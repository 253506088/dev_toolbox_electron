/*
 * node scripts/smoke-subtitles.cjs [--app out]
 * Runs the real renderer, preload, IPC and FFmpeg with synthetic media only.
 * Fixtures, screenshots and the isolated profile remain in test-results/.
 */
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')

if (!process.versions.electron) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], {
    cwd: path.resolve(__dirname, '..'), env, stdio: 'inherit', windowsHide: true, timeout: 120_000
  })
  if (result.error) console.error(result.error.message)
  process.exit(result.status ?? 1)
}

const { app, BrowserWindow, dialog, shell } = require('electron')
const root = path.resolve(__dirname, '..')
const appArg = process.argv.indexOf('--app')
const target = path.resolve(root, appArg < 0 ? 'out' : process.argv[appArg + 1])
const packaged = target.endsWith('.asar')
const entry = path.join(target, packaged ? 'out/main/index.js' : 'main/index.js')
assert(fs.existsSync(entry), `Build first: ${entry}`)
const results = path.join(root, 'test-results')
fs.mkdirSync(results, { recursive: true })
const output = fs.mkdtempSync(path.join(results, 'subtitle-smoke-'))
const profile = path.join(output, 'profile')
const directory = path.join(output, '合成剧集')
fs.mkdirSync(directory, { recursive: true })
fs.mkdirSync(profile)
app.setPath('userData', profile)
app.setPath('sessionData', profile)
app.setAppPath(packaged ? target : root)
if (packaged) {
  Object.defineProperty(app, 'isPackaged', { value: true })
  Object.defineProperty(process, 'resourcesPath', { value: path.dirname(target) })
}
delete process.env.ELECTRON_RENDERER_URL

const ffmpeg = packaged ? path.join(path.dirname(target), 'ffmpeg', 'ffmpeg.exe') : path.join(root, 'resources', 'ffmpeg', 'ffmpeg.exe')
function command(args) {
  const result = spawnSync(ffmpeg, args, { encoding: 'utf8', windowsHide: true, timeout: 20_000 })
  if (result.error) throw result.error
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}
const videos = [1, 2, 3].map((episode) => path.join(directory, `Example.Show.S01E0${episode}.1080p.WEB-DL.mp4`))
command(['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=12', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '3', '-c:v', 'libx264', '-c:a', 'aac', '-y', videos[0]])
for (const video of videos.slice(1)) fs.copyFileSync(videos[0], video)
const subtitles = [1, 2].map((episode) => path.join(directory, `示例剧集.Example.Show.1x0${episode}.chs.srt`))
for (const [index, file] of subtitles.entries()) fs.writeFileSync(file, `1\n00:00:00,200 --> 00:00:02,500\n合成字幕 第${index + 1}集\n`, 'utf8')
const manualSubtitle = path.join(output, '手动字幕.srt')
fs.writeFileSync(manualSubtitle, '1\n00:00:00,200 --> 00:00:02,500\n手动选择的第三集字幕\n', 'utf8')
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const sources = [...videos, ...subtitles, manualSubtitle].map((file) => ({ file, hash: hash(file) }))

const selections = []
dialog.showOpenDialog = async () => {
  assert(selections.length, 'Unexpected file picker')
  return { canceled: false, filePaths: [selections.shift()] }
}
shell.openPath = async () => ''
BrowserWindow.prototype.show = function () { this.showInactive() }
let mainWindow
let completed = false
const report = { target, output, checks: [], screenshots: [], errors: [] }
const baselineModules = new Set(Object.keys(require.cache))
app.on('browser-window-created', (_event, window) => {
  if (!mainWindow) {
    mainWindow = window
    window.webContents.on('console-message', (details) => {
      if (details.level === 'error') report.errors.push(details.message)
    })
    window.webContents.on('render-process-gone', (_event, details) => finish(new Error(`Renderer exited: ${details.reason}`)))
  }
})
const timeout = setTimeout(() => finish(new Error('Subtitle smoke timed out')), 100_000)
process.on('uncaughtException', finish)
process.on('unhandledRejection', finish)

async function evaluate(fn, argument) {
  return mainWindow.webContents.executeJavaScript(`(${fn.toString()})(${JSON.stringify(argument)})`)
}
async function waitFor(fn, description, limit = 15_000) {
  const deadline = Date.now() + limit
  while (Date.now() < deadline) {
    if (mainWindow && await evaluate(fn)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out: ${description}`)
}
async function click(selector) {
  await evaluate((query) => {
    const element = document.querySelector(query)
    if (!element) throw new Error(`Missing control: ${query}`)
    if (element.disabled) throw new Error(`Disabled control: ${query}`)
    element.click()
  }, selector)
}
async function screenshot(name) {
  await evaluate(async () => {
    await Promise.all(document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {})))
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
  const file = path.join(output, `${name}.png`)
  const capture = await mainWindow.webContents.capturePage()
  assert(!capture.isEmpty(), 'Empty screenshot')
  fs.writeFileSync(file, capture.toPNG())
  report.screenshots.push(file)
}
async function waitBatch(previousId) {
  await waitFor(async () => {
    const snapshot = await window.electronApi.subtitles.snapshot()
    return snapshot && snapshot.status !== 'running' && snapshot.batchId !== window.__subtitlePreviousId
  }, 'batch finishes')
  const batch = await evaluate(() => window.electronApi.subtitles.snapshot())
  assert.notEqual(batch.batchId, previousId)
  assert(batch.items.every((item) => item.status === 'succeeded'), JSON.stringify(batch))
  return batch
}

async function run() {
  await waitFor(() => Boolean(window.electronApi && document.querySelector('.tool-nav-button')), 'application mounts')
  await evaluate(() => {
    [...document.querySelectorAll('.tool-nav-button')].find((button) => button.textContent.includes('外挂字幕内嵌')).click()
  })
  await waitFor(() => Boolean(document.querySelector('[data-testid="subtitle-select-folder"]')), 'subtitle page mounts')
  await screenshot('empty-light')
  selections.push(directory)
  await click('[data-testid="subtitle-select-folder"]')
  await waitFor(() => document.querySelectorAll('[data-testid="subtitle-match-row"]').length === 3, 'folder matches all videos')
  const rows = await evaluate(() => [...document.querySelectorAll('[data-testid="subtitle-match-row"]')].map((row) => ({ id: row.dataset.rowId, text: row.textContent, checked: row.querySelector('[data-testid="subtitle-row-checkbox"]')?.classList.contains('n-checkbox--checked') })))
  assert(rows.every((row) => row.checked), 'Folder selection must default to all videos')
  assert(rows.find((row) => row.text.includes('S01E01')).text.includes('1x01'), 'Episode 1 subtitle mismatch')
  assert(rows.find((row) => row.text.includes('S01E02')).text.includes('1x02'), 'Episode 2 subtitle mismatch')
  await screenshot('folder-matches-light')
  const episode2 = rows.find((row) => row.text.includes('S01E02'))
  await click(`[data-row-id="${episode2.id}"] [data-testid="subtitle-row-checkbox"]`)
  await waitFor(() => !document.querySelector('[data-testid="subtitle-start"]')?.disabled, 'FFmpeg ready and start enabled')
  await click('[data-testid="subtitle-start"]')
  await evaluate(() => { [...document.querySelectorAll('.tool-nav-button')].find((button) => button.textContent.includes('时间转换')).click() })
  const first = await waitBatch()
  assert.equal(first.items.length, 1, 'Deselected and unmatched videos must not process')
  assert(first.items[0].videoPath.endsWith('S01E01.1080p.WEB-DL.mp4'))
  assert.equal(first.outputDirectory, path.join(directory, '内嵌字幕处理+合成剧集'))
  assert(command(['-v', 'error', '-i', first.items[0].outputPath, '-map', '0:s:0', '-f', 'srt', '-']).includes('合成字幕 第1集'))
  report.checks.push('folder-match-default-selection-deselection-unmatched-skip-background-mux')
  await evaluate(() => { [...document.querySelectorAll('.tool-nav-button')].find((button) => button.textContent.includes('外挂字幕内嵌')).click() })
  await screenshot('completed-light')

  selections.push(videos[2])
  await click('[data-testid="subtitle-select-video"]')
  await waitFor(() => document.querySelectorAll('[data-testid="subtitle-match-row"]').length === 1 && document.querySelector('[data-testid="subtitle-match-row"]')?.textContent.includes('S01E03'), 'single video scan')
  selections.push(manualSubtitle)
  await click('[data-testid="subtitle-select-subtitle"]')
  await waitFor(() => document.querySelector('[data-testid="subtitle-match-row"]')?.textContent.includes('手动字幕.srt'), 'manual subtitle selected')
  await evaluate((id) => { window.__subtitlePreviousId = id }, first.batchId)
  await click('[data-testid="subtitle-start"]')
  const second = await waitBatch(first.batchId)
  assert.equal(second.items.length, 1)
  assert(command(['-v', 'error', '-i', second.items[0].outputPath, '-map', '0:s:0', '-f', 'srt', '-']).includes('手动选择的第三集字幕'))
  await evaluate((id) => { window.__subtitlePreviousId = id }, second.batchId)
  await click('[data-testid="subtitle-start"]')
  const third = await waitBatch(second.batchId)
  assert.notEqual(third.items[0].outputPath, second.items[0].outputPath, 'Repeated runs must preserve previous output')
  for (const source of sources) assert.equal(hash(source.file), source.hash, `Source was modified: ${source.file}`)
  report.checks.push('single-video-manual-subtitle-repeated-output-source-integrity')

  await evaluate(() => document.querySelector('button[aria-label="切换为暗色主题"]')?.click())
  mainWindow.setContentSize(960, 640)
  await screenshot('completed-dark-960')
  const overflow = await evaluate(() => ({ body: document.body.scrollWidth > innerWidth + 1, startVisible: (() => { const rect = document.querySelector('[data-testid="subtitle-start"]').getBoundingClientRect(); return rect.right <= innerWidth && rect.bottom <= innerHeight && rect.top >= 0 })() }))
  assert(!overflow.body && overflow.startVisible, JSON.stringify(overflow))
  assert.equal(report.errors.length, 0, report.errors.join('\n'))
  report.checks.push('light-dark-minimum-window-layout')
  if (packaged) {
    const appRequire = require('node:module').createRequire(entry)
    const insidePackage = (file) => [target, `${target}.unpacked`].some((packageRoot) => {
      const relative = path.relative(packageRoot, file)
      return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    })
    report.version = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).version
    report.dependencies = ['iconv-lite', 'sharp', '@img/sharp-win32-x64/sharp.node', 'csv-parse/sync']
      .map((id) => ({ id, path: appRequire.resolve(id) }))
    for (const dependency of report.dependencies) assert(insidePackage(dependency.path), `Dependency resolved outside package: ${dependency.id}`)
    for (const file of Object.keys(require.cache).filter((file) => !baselineModules.has(file))) {
      assert(insidePackage(file), `Application loaded a development dependency: ${file}`)
    }
    report.checks.push('self-contained-packaged-dependencies')
  }
  finish()
}
function finish(error) {
  if (completed) return
  completed = true
  clearTimeout(timeout)
  report.success = !error
  if (error) report.error = error.stack ?? String(error)
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  app.exit(error ? 1 : 0)
}
require(entry)
app.whenReady().then(run).catch(finish)
