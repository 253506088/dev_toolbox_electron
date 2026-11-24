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
command(['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:size=640x360:rate=12', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '3', '-c:v', 'libx264', '-c:a', 'aac', '-y', videos[0]])
for (const video of videos.slice(1)) fs.copyFileSync(videos[0], video)
const subtitles = [1, 2].map((episode) => path.join(directory, `示例剧集.Example.Show.1x0${episode}.chs.srt`))
for (const [index, file] of subtitles.entries()) fs.writeFileSync(file, `1\n00:00:00,200 --> 00:00:02,500\n合成字幕 第${index + 1}集\n`, 'utf8')
const manualSubtitle = path.join(output, '手动字幕.srt')
fs.writeFileSync(manualSubtitle, '1\n00:00:00,200 --> 00:00:02,500\n手动选择的第三集字幕\n', 'utf8')
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const sources = [...videos, ...subtitles, manualSubtitle].map((file) => ({ file, hash: hash(file) }))

function burnedFramePixels(file, seconds) {
  const result = spawnSync(ffmpeg, ['-v', 'error', '-ss', String(seconds), '-i', file, '-sn', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { windowsHide: true, timeout: 20_000, maxBuffer: 2 * 1024 * 1024 })
  assert.equal(result.status, 0, result.stderr?.toString())
  assert.equal(result.stdout.length, 640 * 360 * 3)
  let white = 0
  for (let offset = 280 * 640 * 3; offset < result.stdout.length; offset += 3) {
    if (result.stdout[offset] > 140 && result.stdout[offset + 1] > 140 && result.stdout[offset + 2] > 140) white++
  }
  return white
}
function verifyBurnedVideo(file) {
  const info = spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8', windowsHide: true, timeout: 20_000 }).stderr
  assert(info.includes('Video: h264') && info.includes('Audio: aac'), info)
  assert(!info.includes('Subtitle:'), 'Burned video must display captions without a subtitle stream')
  assert.equal(burnedFramePixels(file, 0), 0)
  assert(burnedFramePixels(file, 1) > 20, 'Chinese caption pixels must exist in the video frame itself')
}

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
  assert(await evaluate(() => document.querySelector('[data-testid="subtitle-mode-burn"]')?.getAttribute('aria-pressed') === 'true'), 'New page must default to visible burned captions')
  assert(await evaluate(() => document.querySelector('[data-testid="subtitle-acceleration-auto"]')?.getAttribute('aria-pressed') === 'true'), 'New page must default to verified hardware acceleration')
  assert.equal(await evaluate(() => document.querySelector('[data-testid="subtitle-resolution"]')?.dataset.resolution), 'source')
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
  report.hardware = await evaluate(() => window.electronApi.subtitles.hardwareStatus())
  assert.equal(report.hardware.qsvAvailable, true, 'This Intel Arc machine must pass its real hardware check')
  assert(/Intel/i.test(report.hardware.gpuName ?? ''), JSON.stringify(report.hardware))
  await click('[data-testid="subtitle-start"]')
  await evaluate(() => { [...document.querySelectorAll('.tool-nav-button')].find((button) => button.textContent.includes('时间转换')).click() })
  const first = await waitBatch()
  assert.equal(first.items.length, 1, 'Deselected and unmatched videos must not process')
  assert(first.items[0].videoPath.endsWith('S01E01.1080p.WEB-DL.mp4'))
  assert.equal(first.outputDirectory, path.join(directory, '内嵌字幕处理+合成剧集'))
  assert.equal(first.mode, 'burn')
  assert.equal(first.acceleration, 'auto')
  assert.equal(first.resolution, 'source')
  assert.equal(first.items[0].actualEncoder, 'h264_qsv')
  assert.equal(first.items[0].actualDecoder, 'h264_qsv')
  assert.equal(first.items[0].outputWidth, 640)
  assert.equal(first.items[0].outputHeight, 360)
  assert(first.items[0].elapsedSeconds > 0)
  report.firstHardwareItem = first.items[0]
  verifyBurnedVideo(first.items[0].outputPath)
  report.checks.push('default-burn-folder-match-selection-background-encoding')
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
  assert.equal(second.mode, 'burn')
  verifyBurnedVideo(second.items[0].outputPath)
  await evaluate((id) => { window.__subtitlePreviousId = id }, second.batchId)
  await click('[data-testid="subtitle-start"]')
  const third = await waitBatch(second.batchId)
  assert.notEqual(third.items[0].outputPath, second.items[0].outputPath, 'Repeated runs must preserve previous output')
  await click('[data-testid="subtitle-acceleration-cpu-fast"]')
  assert(await evaluate(() => document.querySelector('[data-testid="subtitle-acceleration-cpu-fast"]')?.getAttribute('aria-pressed') === 'true'))
  await evaluate((id) => { window.__subtitlePreviousId = id }, third.batchId)
  await click('[data-testid="subtitle-start"]')
  const explicitCpu = await waitBatch(third.batchId)
  assert.equal(explicitCpu.acceleration, 'cpu-fast')
  assert.equal(explicitCpu.items[0].actualEncoder, 'libx264')
  verifyBurnedVideo(explicitCpu.items[0].outputPath)
  await click('[data-testid="subtitle-acceleration-auto"]')
  report.checks.push('verified-qsv-default-and-explicit-cpu-mode')
  for (const source of sources) assert.equal(hash(source.file), source.hash, `Source was modified: ${source.file}`)
  report.checks.push('single-video-manual-subtitle-repeated-output-source-integrity')
  await click('[data-testid="subtitle-mode-soft"]')
  assert(await evaluate(() => document.querySelector('[data-testid="subtitle-mode-soft"]')?.getAttribute('aria-pressed') === 'true'))
  await click('[data-testid="subtitle-mode-burn"]')

  await evaluate(() => document.querySelector('button[aria-label="切换为暗色主题"]')?.click())
  mainWindow.setContentSize(960, 640)
  await screenshot('completed-dark-960')
  const overflow = await evaluate(() => ({ body: document.body.scrollWidth > innerWidth + 1, startVisible: (() => { const rect = document.querySelector('[data-testid="subtitle-start"]').getBoundingClientRect(); return rect.right <= innerWidth && rect.bottom <= innerHeight && rect.top >= 0 })() }))
  assert(!overflow.body && overflow.startVisible, JSON.stringify(overflow))
  assert.equal(report.errors.length, 0, report.errors.join('\n'))
  report.checks.push('light-dark-minimum-window-layout')

  const videoOnly = path.join(output, 'video-only')
  fs.mkdirSync(videoOnly)
  const portableVideo = path.join(videoOnly, 'copied-and-renamed.mp4')
  fs.copyFileSync(first.items[0].outputPath, portableVideo)
  assert.equal(fs.readdirSync(videoOnly).length, 1, 'Delivery directory must contain only the video')
  for (const fixturePath of [directory, `${directory}-isolated`, manualSubtitle, `${manualSubtitle}.isolated`]) {
    const relative = path.relative(output, fixturePath)
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Only synthetic fixture paths may be moved')
  }
  fs.renameSync(directory, `${directory}-isolated`)
  fs.renameSync(manualSubtitle, `${manualSubtitle}.isolated`)
  verifyBurnedVideo(portableVideo)
  report.checks.push('renamed-video-only-delivery-source-paths-unavailable')
  await evaluate(async (file) => {
    const metadata = await window.electronApi.media.registerVideo(file)
    const video = document.createElement('video')
    video.id = 'subtitle-portability-player'
    video.muted = true
    video.controls = true
    video.playsInline = true
    video.style.cssText = 'position:fixed;z-index:99999;left:210px;top:100px;width:640px;height:360px;background:blue;'
    video.src = metadata.previewUrl
    document.body.append(video)
    await video.play()
  }, portableVideo)
  await waitFor(() => document.querySelector('#subtitle-portability-player')?.currentTime >= 0.8, 'ordinary HTML5 video plays copied product')
  report.browserPlayback = await evaluate(() => {
    const video = document.querySelector('#subtitle-portability-player')
    video.pause()
    return { currentTime: video.currentTime, width: video.videoWidth, height: video.videoHeight, textTracks: video.textTracks.length, decodedFrames: video.getVideoPlaybackQuality().totalVideoFrames }
  })
  assert.equal(report.browserPlayback.textTracks, 0)
  assert(report.browserPlayback.decodedFrames > 0)
  await screenshot('copied-video-html5-visible-captions')
  report.checks.push('ordinary-html5-player-shows-captions-without-subtitle-tracks')
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
