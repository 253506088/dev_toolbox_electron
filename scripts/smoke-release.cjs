/*
 * node scripts/smoke-release.cjs [--app dist/win-unpacked/resources/app.asar]
 * Use --app out to exercise a local build. All fixtures, profiles, screenshots,
 * and diagnostics remain under test-results/release-smoke-*. No user data is read.
 */
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], {
    cwd: path.resolve(__dirname, '..'), env, stdio: 'inherit', windowsHide: true, timeout: 120_000
  })
  if (result.error) console.error(result.error.message)
  process.exit(result.status ?? 1)
}

const { app, BrowserWindow, Notification, nativeImage, shell } = require('electron')
const projectRoot = path.resolve(__dirname, '..')
const argumentIndex = process.argv.indexOf('--app')
const target = path.resolve(projectRoot, argumentIndex < 0 ? 'dist/win-unpacked/resources/app.asar' : process.argv[argumentIndex + 1])
const packaged = target.endsWith('.asar')
const entry = path.join(target, packaged ? 'out/main/index.js' : 'main/index.js')
assert(fs.existsSync(entry), `Build entry does not exist: ${entry}`)
const resultsRoot = path.join(projectRoot, 'test-results')
fs.mkdirSync(resultsRoot, { recursive: true })
const output = fs.mkdtempSync(path.join(resultsRoot, 'release-smoke-'))
const profile = path.join(output, 'user-data')
const images = path.join(profile, 'images')
fs.mkdirSync(images, { recursive: true })
fs.mkdirSync(path.join(profile, 'session'), { recursive: true })
app.setPath('userData', profile)
app.setPath('sessionData', path.join(profile, 'session'))
app.setAppPath(packaged ? target : projectRoot)
if (packaged) {
  Object.defineProperty(app, 'isPackaged', { value: true })
  Object.defineProperty(process, 'resourcesPath', { value: path.dirname(target) })
}
delete process.env.ELECTRON_RENDERER_URL

const report = {
  target, output, electron: process.versions.electron, packaged, startedAt: new Date().toISOString(),
  console: [], errors: [], checks: [], screenshots: [], windowMoves: [], notifications: 0, beeps: 0
}
let mainWindow
let complete = false
let expectedResize = false
const originals = []
const baselineModules = new Set(Object.keys(require.cache))
// A hidden test window still runs the real renderer/preload. Suppress only native
// attention side effects so reminders never steal focus or create system toasts.
function replace(object, name, replacement) {
  originals.push([object, name, object[name]])
  object[name] = replacement
}
for (const method of ['show', 'focus', 'setAlwaysOnTop']) replace(BrowserWindow.prototype, method, function () {})
replace(app, 'focus', () => {})
replace(shell, 'beep', () => { report.beeps++ })
replace(Notification.prototype, 'show', function () { report.notifications++ })

process.on('uncaughtException', (error) => finish(error))
process.on('unhandledRejection', (error) => finish(error instanceof Error ? error : new Error(String(error))))
const timeout = setTimeout(() => finish(new Error('Release smoke check timed out after 100 seconds')), 100_000)

// Two due reminders catch events emitted before the root component subscribes.
const now = new Date()
const minuteRemaining = 60_000 - (now.getTime() % 60_000)
const fixtureTime = minuteRemaining < 8_000 ? new Date(now.getTime() + minuteRemaining + 100) : now
const colors = ['#F7D7D9', '#FBE3BC', '#F6EDB6', '#DCECC8', '#C6E7D5', '#BFE4E7', '#C9E0F2', '#DED5F0']
const notes = colors.map((color, index) => ({
  id: `release-smoke-${index}`, color,
  content: index < 2 ? `启动提醒 ${index + 1}：这是独立测试数据。` : `布局验证 ${index + 1}\n${'便签图片、长段落和换行在启动及窗口缩放时应保持清晰稳定。'.repeat(index + 1)}`,
  imageNames: index % 2 === 0 ? ['fixture-wide.png', 'fixture-tall.png'] : [],
  createdAt: new Date(now.getTime() - index * 1000).toISOString(),
  updatedAt: new Date(now.getTime() - index * 1000).toISOString(),
  ...(index < 2 ? { reminder: { type: 'daily', hour: fixtureTime.getHours(), minute: fixtureTime.getMinutes(), enabled: true } } : {})
}))
fs.writeFileSync(path.join(profile, 'notes-v1.json'), JSON.stringify({ schemaVersion: 2, notes }))
for (const [name, width, height] of [['fixture-wide.png', 640, 360], ['fixture-tall.png', 360, 640]]) {
  const bitmap = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4
    const tile = (Math.floor(x / 40) + Math.floor(y / 40)) % 2
    bitmap[offset] = tile ? 80 : 200
    bitmap[offset + 1] = Math.round(80 + x / width * 150)
    bitmap[offset + 2] = Math.round(80 + y / height * 150)
    bitmap[offset + 3] = 255
  }
  fs.writeFileSync(path.join(images, name), nativeImage.createFromBitmap(bitmap, { width, height }).toPNG())
}

app.on('browser-window-created', (_event, window) => {
  if (mainWindow) return
  mainWindow = window
  window.webContents.setBackgroundThrottling(false)
  window.on('move', () => { if (!expectedResize) report.windowMoves.push(window.getBounds()) })
  window.webContents.on('console-message', (details) => {
    report.console.push({ level: details.level, message: details.message })
    if (details.level === 'error') report.errors.push({ source: 'renderer-console', message: details.message })
  })
  window.webContents.on('render-process-gone', (_event, details) => finish(new Error(`Renderer exited: ${JSON.stringify(details)}`)))
  window.webContents.on('preload-error', (_event, preload, error) => finish(new Error(`Preload failed (${preload}): ${error.message}`)))
  window.webContents.on('did-fail-load', (_event, code, description) => finish(new Error(`Renderer load failed ${code}: ${description}`)))
  // Session preloads run before the application's preload and document scripts.
  // Unlike async debugger registration, this cannot race the first navigation.
  const diagnosticsPath = path.join(output, 'layout-diagnostics.cjs')
  fs.writeFileSync(diagnosticsPath, `require('electron').contextBridge.executeInMainWorld({ func: ${installDiagnostics.toString()} })`)
  window.webContents.session.registerPreloadScript({ type: 'frame', filePath: diagnosticsPath })
  window.webContents.once('did-finish-load', () => { void runChecks().catch(finish) })
})

// Keep registration before Electron becomes ready: the app declares custom schemes.
require(entry)

function installDiagnostics() {
  if (window.__releaseSmoke) return
  const state = window.__releaseSmoke = { phase: 'startup', frames: [], errors: [], layoutShifts: [] }
  window.addEventListener('error', (event) => state.errors.push(event.message))
  window.addEventListener('unhandledrejection', (event) => state.errors.push(String(event.reason)))
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) state.layoutShifts.push({ value: entry.value, time: entry.startTime, phase: state.phase })
    }).observe({ type: 'layout-shift', buffered: true })
  } catch { /* LayoutShift is diagnostic only. */ }
  function sample() {
    const cards = [...document.querySelectorAll('.note-card')].filter((card) => getComputedStyle(card).visibility !== 'hidden')
    const rectangles = cards.map((card) => {
      const r = card.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })
    let overlaps = 0
    for (let a = 0; a < rectangles.length; a++) for (let b = a + 1; b < rectangles.length; b++) {
      const r = rectangles[a], s = rectangles[b]
      if (Math.min(r.x + r.width, s.x + s.width) - Math.max(r.x, s.x) > 1 && Math.min(r.y + r.height, s.y + s.height) - Math.max(r.y, s.y) > 1) overlaps++
    }
    const host = document.querySelector('.notes-scroll')
    if (host && state.frames.length < 2400) state.frames.push({ phase: state.phase, time: performance.now(), count: cards.length, overlaps, rectangles })
    // rAF runs before ResizeObserver; sampling there can report intermediate
    // geometry that is corrected before paint. A following task observes the
    // completed rendering update, including the masonry observer's writes.
    requestAnimationFrame(() => setTimeout(sample, 0))
  }
  requestAnimationFrame(() => setTimeout(sample, 0))
}

async function evaluate(fn, argument) {
  return mainWindow.webContents.executeJavaScript(`(${fn.toString()})(${JSON.stringify(argument)})`)
}
async function waitFor(fn, description, timeoutMs = 15_000) {
  report.phase = description
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(fn)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out: ${description}`)
}
async function stableFrame(phase) {
  report.phase = `stable layout: ${phase}`
  await evaluate((name) => { window.__releaseSmoke.phase = name }, phase)
  await evaluate(() => new Promise((resolve) => {
    let previous = '', stable = 0
    function check() {
      const signature = JSON.stringify([...document.querySelectorAll('.note-card')].map((element) => {
        const rect = element.getBoundingClientRect()
        return [rect.x, rect.y, rect.width, rect.height]
      }))
      stable = signature === previous ? stable + 1 : 0
      previous = signature
      if (stable >= 12) resolve(true)
      else requestAnimationFrame(check)
    }
    requestAnimationFrame(check)
  }))
}
async function screenshot(name) {
  // A mounted modal can still be in its entrance animation. Wait for the paint
  // after finite transitions before recording a visual acceptance screenshot.
  await evaluate(async () => {
    const animations = document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
    await Promise.all(animations.map((animation) => animation.finished.catch(() => {})))
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
  const destination = path.join(output, `${name}.png`)
  const capture = await mainWindow.webContents.capturePage()
  assert(!capture.isEmpty(), `Empty screenshot: ${name}`)
  fs.writeFileSync(destination, capture.toPNG())
  report.screenshots.push(destination)
}
async function click(selector) {
  await evaluate((query) => {
    const element = document.querySelector(query)
    if (!element) throw new Error(`Missing UI control: ${query}`)
    element.click()
  }, selector)
}

async function runChecks() {
  await waitFor(() => Boolean(window.electronApi && document.querySelector('.note-cell')), 'preload and notes mount')
  assert(await evaluate(() => Boolean(window.__releaseSmoke)), 'Early layout diagnostics did not load')
  await waitFor(() => [...document.querySelectorAll('.note-images img')].every((image) => image.complete && image.naturalWidth > 0), 'note images load')
  await waitFor(() => document.querySelector('.reminder-count')?.textContent.includes('2'), 'both startup reminders reach the queue', Math.max(15_000, minuteRemaining + 4000))
  await stableFrame('reminder-first')
  report.checks.push({ name: 'startup-reminder-queue', count: 2, first: await evaluate(() => document.querySelector('.reminder-note').textContent) })
  assert.match(report.checks.at(-1).first, /启动提醒 1/)
  await screenshot('01-startup-reminder')
  const reminderWidth = await evaluate(() => document.querySelector('.reminder-modal').getBoundingClientRect().width)
  assert(reminderWidth > 300 && reminderWidth <= 480, `Unexpected reminder width: ${reminderWidth}`)
  await click('.reminder-content .n-button')
  await waitFor(() => document.querySelector('.reminder-note')?.textContent.includes('启动提醒 2'), 'second reminder after confirming first')
  await screenshot('02-second-reminder')
  await click('.reminder-content .n-button')
  await waitFor(() => !document.querySelector('.reminder-content'), 'reminder closes without an empty card')
  await stableFrame('notes-default')
  await screenshot('03-notes-default')
  await click('.note-card-actions .n-button')
  await waitFor(() => Boolean(document.querySelector('.note-editor-modal textarea')), 'note editor opens')
  await screenshot('03-note-editor')
  const editorWidth = await evaluate(() => document.querySelector('.note-editor-modal').getBoundingClientRect().width)
  assert(editorWidth > 600 && editorWidth <= 720, `Unexpected note editor width: ${editorWidth}`)
  await click('.note-editor-modal .n-card-header__close')
  await waitFor(() => !document.querySelector('.note-editor-modal'), 'note editor closes')

  report.services = await evaluate(async (imagePath) => {
    const api = window.electronApi
    const notes = await api.notes.list()
    const metadata = await api.media.registerImages([imagePath])
    const preview = await api.media.previewResize(imagePath, { width: 240, height: 180, fit: 'contain' })
    const ffmpeg = await api.media.ffmpegStatus()
    const dictionary = await api.dictionary.load()
    return {
      noteCount: notes.length, triggered: notes.filter((note) => note.reminder?.lastTriggered).length,
      md5: await api.calculateMd5('release-smoke'), metadata,
      preview: { width: preview.width, height: preview.height, valid: preview.dataUrl.startsWith('data:image/png;base64,') },
      ffmpeg, dictionary: dictionary.status
    }
  }, path.join(images, 'fixture-wide.png'))
  assert.equal(report.services.noteCount, notes.length)
  assert.equal(report.services.triggered, 2)
  assert.equal(report.services.md5, require('node:crypto').createHash('md5').update('release-smoke').digest('hex'))
  assert.equal(report.services.metadata[0].width, 640)
  assert.equal(report.services.preview.valid, true)
  assert.equal(report.services.ffmpeg.available, true)
  if (packaged) assert.equal(path.resolve(report.services.ffmpeg.path), path.join(path.dirname(target), 'ffmpeg', 'ffmpeg.exe'))
  assert(report.services.dictionary.builtInCount > 100, 'Bundled dictionary was not loaded')

  for (const [name, width, height] of [['narrow', 960, 640], ['wide', 1440, 900]]) {
    await evaluate((phase) => { window.__releaseSmoke.phase = phase }, `resize-${name}`)
    expectedResize = true
    mainWindow.setSize(width, height)
    expectedResize = false
    await stableFrame(`resize-${name}`)
    await screenshot(`04-notes-${name}`)
  }
  await click('.note-images img')
  await waitFor(() => Boolean(document.querySelector('.viewer-stage img')?.naturalWidth), 'full image viewer')
  await screenshot('05-image-viewer')
  await click('.image-viewer [aria-label="下一张"]')
  await waitFor(() => document.querySelector('.viewer-count')?.textContent.includes('2 / 2'), 'image viewer advances')
  await click('.image-viewer [aria-label="关闭"]')
  await waitFor(() => !document.querySelector('.image-viewer'), 'image viewer closes')

  await click('[aria-label="打开设置"]')
  await evaluate(() => { window.__releaseSmoke.phase = 'settings-font-change' })
  await waitFor(() => Boolean(document.querySelector('.settings-item-control input')), 'settings open')
  await evaluate(async () => {
    const input = document.querySelector('.settings-item-control input')
    input.focus()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, '20')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await Promise.resolve()
    input.blur()
  })
  await waitFor(() => getComputedStyle(document.documentElement).getPropertyValue('--ui-font-size').trim() === '20px', 'large font setting applies')
  await click('.settings-actions .n-button--primary-type')
  await waitFor(() => !document.querySelector('.settings-modal'), 'settings close')
  await stableFrame('large-font')
  await screenshot('06-notes-large-font')
  await click('[aria-label="切换为暗色主题"]')
  await stableFrame('dark-theme')
  await screenshot('07-notes-dark-theme')

  report.layout = await evaluate(() => {
    const ancestry = []
    let element = document.querySelector('.note-card')
    while (element) {
      const style = getComputedStyle(element)
      ancestry.push({ tag: element.tagName, class: element.className, filter: style.filter, backdropFilter: style.backdropFilter, transform: style.transform, animation: style.animationName })
      element = element.parentElement
    }
    const state = window.__releaseSmoke
    return { ...state, devicePixelRatio, ancestry, readyCount: document.querySelectorAll('.note-cell[data-masonry-ready]').length }
  })
  assert.equal(report.layout.readyCount, notes.length)
  assert.equal(report.layout.errors.length, 0, `Renderer exceptions: ${report.layout.errors.join('; ')}`)
  const overlaps = report.layout.frames.filter((frame) => frame.overlaps > 0)
  assert.equal(overlaps.length, 0, `Visible cards overlapped in ${overlaps.length} rendered frames`)
  assert(report.layout.ancestry.every((item) => item.filter === 'none' && item.transform === 'none'), 'Notes inherit blur or transform')
  assert.equal(report.errors.length, 0, `Errors: ${JSON.stringify(report.errors)}`)
  assert.equal(report.windowMoves.length, 0, 'Application moved the test window unexpectedly')
  if (packaged) {
    const appRequire = require('node:module').createRequire(entry)
    const insidePackage = (file) => [target, `${target}.unpacked`].some((root) => {
      const relative = path.relative(root, file)
      return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    })
    report.dependencies = ['sharp', 'iconv-lite', 'csv-parse/sync', '@img/sharp-win32-x64/sharp.node']
      .map((id) => ({ id, path: appRequire.resolve(id) }))
    for (const dependency of report.dependencies) assert(insidePackage(dependency.path), `Dependency resolved outside the package: ${dependency.id}`)
    const loadedModules = Object.keys(require.cache).filter((file) => !baselineModules.has(file))
    for (const file of loadedModules) assert(insidePackage(file), `Application loaded a development dependency: ${file}`)
    report.checks.push({ name: 'self-contained-dependencies', modules: loadedModules.length })
  }
  report.checks.push({ name: 'notes-layout', samples: report.layout.frames.length, overlaps: 0, images: 'loaded', resize: ['960x640', '1440x900'], fontSize: 20 })
  finish()
}

function finish(error) {
  if (complete) return
  complete = true
  clearTimeout(timeout)
  report.finishedAt = new Date().toISOString()
  report.passed = !error
  if (error) report.failure = error.stack || String(error)
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`${error ? 'FAIL' : 'PASS'} release smoke: ${output}`)
  if (error) console.error(report.failure)
  for (const [object, name, original] of originals) object[name] = original
  app.exit(error ? 1 : 0)
}
