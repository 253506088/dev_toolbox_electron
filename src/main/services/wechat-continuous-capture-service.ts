import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, desktopCapturer, globalShortcut, type WebContents } from 'electron'
import sharp from 'sharp'
import {
  continuousFrameDecision,
  continuousSafeStripRegion,
  findVerticalOverlap,
  normalizedImageDifference,
  type WechatCaptureEvent,
  type WechatContinuousCaptureRequest,
  type WechatCaptureStartResult
} from '../../shared/wechat-capture'

const CAPTURE_SIZE = { width: 1920, height: 1080 }
const LONG_IMAGE_HEIGHT = 20_000
const STOP_HOTKEY = 'CommandOrControl+E'

interface ContinuousFrame {
  buffer: Buffer
  width: number
  height: number
  fingerprint: Uint8Array
  fingerprintHeight: number
  previewDataUrl: string
}

interface ContinuousRun {
  id: string
  cancelled: boolean
  sender: WebContents
  outputDirectory: string
  scroller: ContinuousScrollController | null
}

interface FrameReport {
  frame: number
  timestamp: string
  kind: 'initial' | 'append' | 'stationary' | 'reject'
  overlap: number
  shift: number
  score: number
}

/** 节点 2：连续采集相邻帧，只把可靠的新像素条追加到长图。 */
export class WechatContinuousCaptureService {
  private activeRun: ContinuousRun | null = null

  get defaultOutputDirectory(): string {
    return join(app.getPath('desktop'), '微信聊天截图')
  }

  async start(request: WechatContinuousCaptureRequest, sender: WebContents): Promise<WechatCaptureStartResult> {
    if (process.platform !== 'win32') throw new Error('微信连续长截图目前仅支持 Windows')
    if (this.activeRun) throw new Error('已有连续长截图任务正在运行')
    validateRequest(request)
    const outputDirectory = await this.createRunDirectory(request.outputDirectory, request.sourceName)
    const run: ContinuousRun = {
      id: crypto.randomUUID(),
      cancelled: false,
      sender,
      outputDirectory,
      scroller: null
    }
    this.activeRun = run
    if (!globalShortcut.register(STOP_HOTKEY, () => this.stop())) {
      this.activeRun = null
      throw new Error('Ctrl+E 已被其他截图任务或程序占用')
    }
    void this.execute(run, request)
    return { runId: run.id, outputDirectory }
  }

  stop(): void {
    if (!this.activeRun) return
    this.activeRun.cancelled = true
    this.stopScroller(this.activeRun)
  }

  dispose(): void {
    this.stop()
    globalShortcut.unregister(STOP_HOTKEY)
  }

  private async execute(run: ContinuousRun, request: WechatContinuousCaptureRequest): Promise<void> {
    const stripsDirectory = join(run.outputDirectory, 'strips')
    const longDirectory = join(run.outputDirectory, 'long')
    const screenshotsDirectory = join(run.outputDirectory, 'screenshots')
    const stripPaths: string[] = []
    const report: FrameReport[] = []
    let capturedHeight = 0
    let acceptedFrames = 0
    let reachedBottom = false
    let failure: Error | null = null

    try {
      await Promise.all([
        mkdir(stripsDirectory, { recursive: true }),
        mkdir(longDirectory, { recursive: true }),
        mkdir(screenshotsDirectory, { recursive: true })
      ])
      this.emit(run, 'positioning', '连续长截图：正在快速定位聊天顶部...', 0, 0)
      const first = await this.positionAtTop(run, request)
      if (run.cancelled) {
        this.emit(run, 'stopped', '连续长截图已停止', 0, 0)
        return
      }

      const firstRegion = continuousSafeStripRegion(first.height, 1)
      const safeBottom = firstRegion.safeBottom
      const firstPath = join(stripsDirectory, 'strip_00000.png')
      await sharp(first.buffer).extract({ left: 0, top: 0, width: first.width, height: safeBottom }).png().toFile(firstPath)
      stripPaths.push(firstPath)
      report.push({ frame: 0, timestamp: new Date().toISOString(), kind: 'initial', overlap: 0, shift: first.height, score: 0 })
      capturedHeight = safeBottom
      acceptedFrames = 1
      let previous = first
      let observedFrames = 1
      let stationaryCount = 0
      const bottomThreshold = 4
      let lastPulseAt = 0

      run.scroller = this.startScroller(request)
      this.emit(run, 'capturing', '连续滚动采集中，按 Ctrl+E 可停止', acceptedFrames, capturedHeight, first.previewDataUrl)

      try {
        while (!run.cancelled && observedFrames < request.maxFrames) {
          this.assertSender(run)
          const pacingDelay = Math.max(0, request.scrollIntervalMs - (Date.now() - lastPulseAt))
          if (pacingDelay > 0) await delay(pacingDelay)
          await run.scroller.pulse()
          lastPulseAt = Date.now()
          await delay(request.frameIntervalMs)
          let current = await this.capture(request)
          observedFrames += 1
          let match = matchContinuousFrames(previous, current)
          let decision = continuousFrameDecision(match, previous.height, previous.fingerprintHeight)
          report.push(frameReport(observedFrames - 1, decision, match.score))

          for (let retry = 0; decision.kind === 'reject' && retry < 3 && observedFrames < request.maxFrames; retry += 1) {
            await delay(request.frameIntervalMs)
            current = await this.capture(request)
            observedFrames += 1
            match = matchContinuousFrames(previous, current)
            decision = continuousFrameDecision(match, previous.height, previous.fingerprintHeight)
            report.push(frameReport(observedFrames - 1, decision, match.score))
          }

          if (decision.kind === 'stationary') {
            stationaryCount += 1
            if (stationaryCount >= bottomThreshold) {
              reachedBottom = true
              break
            }
            continue
          }

          if (decision.kind === 'reject') {
            const directDifference = normalizedImageDifference(previous.fingerprint, current.fingerprint)
            if (directDifference < 0.004) {
              stationaryCount += 1
              continue
            }
            throw new Error('当前滚动后的画面经过 3 次稳定重采样仍无法可靠对齐，已停止以避免产生断层')
          }

          stationaryCount = 0
          const stripPath = join(stripsDirectory, `strip_${String(acceptedFrames).padStart(5, '0')}.png`)
          const stripRegion = continuousSafeStripRegion(current.height, decision.shift)
          await sharp(current.buffer)
            .extract({ left: 0, top: stripRegion.top, width: current.width, height: stripRegion.height })
            .png()
            .toFile(stripPath)
          stripPaths.push(stripPath)
          capturedHeight += decision.shift
          acceptedFrames += 1
          previous = current
          this.emit(
            run,
            'capturing',
            `连续采集中：已追加 ${capturedHeight.toLocaleString('zh-CN')} 像素`,
            acceptedFrames,
            capturedHeight,
            current.previewDataUrl
          )
        }
      } catch (error) {
        if (!run.cancelled) failure = error instanceof Error ? error : new Error(String(error))
      } finally {
        await this.stopScroller(run)
      }

      const stopped = run.cancelled
      const hitLimit = !stopped && !reachedBottom && !failure
      if (reachedBottom) {
        const tailHeight = previous.height - safeBottom
        if (tailHeight > 0) {
          const tailPath = join(stripsDirectory, 'strip_tail.png')
          await sharp(previous.buffer).extract({ left: 0, top: safeBottom, width: previous.width, height: tailHeight }).png().toFile(tailPath)
          stripPaths.push(tailPath)
          capturedHeight += tailHeight
        }
      }
      this.emit(run, 'stitching', '正在生成无缝长图、分屏和 Markdown...', acceptedFrames, capturedHeight)
      const longPaths = await this.buildLongImages(stripPaths, longDirectory)
      const screenshotPaths = await this.buildScreenshots(longPaths, screenshotsDirectory, first.height)
      await writeFile(join(run.outputDirectory, 'capture-report.json'), JSON.stringify({
        mode: 'continuous',
        sourceName: request.sourceName,
        crop: request.crop,
        frameIntervalMs: request.frameIntervalMs,
        scrollIntervalMs: request.scrollIntervalMs,
        capturedHeight,
        acceptedFrames,
        reachedBottom,
        stopped,
        failure: failure?.message,
        frames: report
      }, null, 2), 'utf8')
      const markdownPath = await this.writeMarkdown(
        run.outputDirectory,
        request.sourceName,
        longPaths,
        screenshotPaths,
        capturedHeight,
        stopped,
        reachedBottom,
        hitLimit,
        failure?.message
      )

      if (failure) {
        this.emit(run, 'error', `${failure.message}；已保存停止前的连续长图`, acceptedFrames, capturedHeight, undefined, markdownPath)
      } else {
        const message = stopped
          ? '连续长截图已停止，现有内容已保存'
          : reachedBottom
            ? '连续长截图已完成'
            : '已达到最大采样帧数，现有内容已保存'
        this.emit(run, stopped ? 'stopped' : 'complete', message, acceptedFrames, capturedHeight, undefined, markdownPath)
      }
    } catch (error) {
      await this.stopScroller(run)
      const message = error instanceof Error ? error.message : String(error)
      this.emit(run, 'error', message, acceptedFrames, capturedHeight)
    } finally {
      if (this.activeRun === run) this.activeRun = null
      globalShortcut.unregister(STOP_HOTKEY)
    }
  }

  private async positionAtTop(run: ContinuousRun, request: WechatContinuousCaptureRequest): Promise<ContinuousFrame> {
    let previous = await this.capture(request)
    let stableCount = 0
    for (let attempt = 0; attempt < 120 && stableCount < 3 && !run.cancelled; attempt += 1) {
      await this.scrollOnce(request, 'up', 80)
      await delay(250)
      const current = await this.capture(request)
      stableCount = normalizedImageDifference(previous.fingerprint, current.fingerprint) < 0.0035 ? stableCount + 1 : 0
      previous = current
      this.emit(run, 'positioning', `连续长截图：正在定位顶部${'.'.repeat((attempt % 3) + 1)}`, 0, 0)
    }
    if (stableCount < 3 && !run.cancelled) throw new Error('未能确认聊天记录顶部，请检查框选区域')
    return previous
  }

  private async capture(request: WechatContinuousCaptureRequest): Promise<ContinuousFrame> {
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: CAPTURE_SIZE })
    const source = sources.find((candidate) => candidate.id === request.sourceId)
    if (!source || source.thumbnail.isEmpty()) throw new Error('微信窗口已关闭或无法读取')
    const image = sharp(source.thumbnail.toPNG())
    const metadata = await image.metadata()
    if (!metadata.width || !metadata.height) throw new Error('无法读取微信窗口尺寸')
    const region = cropToPixels(request.crop, metadata.width, metadata.height)
    const buffer = await image.extract(region).png().toBuffer()
    const fingerprintHeight = region.height
    const [fingerprint, preview] = await Promise.all([
      sharp(buffer).grayscale().raw().toBuffer(),
      sharp(buffer).resize({ width: 240, withoutEnlargement: true }).png().toBuffer()
    ])
    return {
      buffer,
      width: region.width,
      height: region.height,
      fingerprint,
      fingerprintHeight,
      previewDataUrl: `data:image/png;base64,${preview.toString('base64')}`
    }
  }

  private startScroller(request: WechatContinuousCaptureRequest): ContinuousScrollController {
    const hwnd = parseWindowHandle(request.sourceId)
    if (!hwnd) throw new Error('无法识别微信窗口句柄')
    const script = controlledScrollScript(hwnd, request.crop)
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', encoded],
      { windowsHide: true }
    )
    return new ContinuousScrollController(child)
  }

  private async stopScroller(run: ContinuousRun): Promise<void> {
    const child = run.scroller
    if (!child) return
    run.scroller = null
    await child.stop()
  }

  private async scrollOnce(request: WechatContinuousCaptureRequest, direction: 'up' | 'down', steps: number): Promise<void> {
    const hwnd = parseWindowHandle(request.sourceId)
    if (!hwnd) throw new Error('无法识别微信窗口句柄')
    const script = oneShotScrollScript(hwnd, request.crop, direction, steps)
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    await new Promise<void>((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true })
      let errorText = ''
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => { errorText += chunk })
      child.once('error', reject)
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(errorText.trim() || '无法控制微信窗口滚动')))
    })
  }

  private async buildLongImages(stripPaths: string[], outputDirectory: string): Promise<string[]> {
    if (stripPaths.length === 0) return []
    const firstMetadata = await sharp(stripPaths[0]).metadata()
    if (!firstMetadata.width) throw new Error('无法读取连续截图宽度')
    const width = firstMetadata.width
    const outputPaths: string[] = []
    let pieces: Array<{ input: Buffer; top: number; left: number }> = []
    let currentHeight = 0

    const flush = async (): Promise<void> => {
      if (currentHeight === 0) return
      const path = join(outputDirectory, `long_${String(outputPaths.length + 1).padStart(3, '0')}.png`)
      await sharp({ create: { width, height: currentHeight, channels: 3, background: '#ffffff' } })
        .composite(pieces)
        .png()
        .toFile(path)
      outputPaths.push(path)
      pieces = []
      currentHeight = 0
    }

    for (const stripPath of stripPaths) {
      const source = await readFile(stripPath)
      const metadata = await sharp(source).metadata()
      if (!metadata.height || metadata.width !== width) throw new Error('连续截图条带尺寸不一致')
      let sourceTop = 0
      let remaining = metadata.height
      while (remaining > 0) {
        const pieceHeight = Math.min(remaining, LONG_IMAGE_HEIGHT - currentHeight)
        const piece = await sharp(source).extract({ left: 0, top: sourceTop, width, height: pieceHeight }).png().toBuffer()
        pieces.push({ input: piece, top: currentHeight, left: 0 })
        currentHeight += pieceHeight
        sourceTop += pieceHeight
        remaining -= pieceHeight
        if (currentHeight >= LONG_IMAGE_HEIGHT) await flush()
      }
    }
    await flush()
    return outputPaths
  }

  private async buildScreenshots(longPaths: string[], outputDirectory: string, viewportHeight: number): Promise<string[]> {
    const outputPaths: string[] = []
    for (const longPath of longPaths) {
      const metadata = await sharp(longPath).metadata()
      if (!metadata.width || !metadata.height) throw new Error('无法读取连续长图尺寸')
      for (let top = 0; top < metadata.height; top += viewportHeight) {
        const height = Math.min(viewportHeight, metadata.height - top)
        const path = join(outputDirectory, `screen_${String(outputPaths.length + 1).padStart(4, '0')}.png`)
        await sharp(longPath).extract({ left: 0, top, width: metadata.width, height }).png().toFile(path)
        outputPaths.push(path)
      }
    }
    return outputPaths
  }

  private async writeMarkdown(
    root: string,
    sourceName: string,
    longImages: string[],
    screenshots: string[],
    capturedHeight: number,
    stopped: boolean,
    reachedBottom: boolean,
    hitLimit: boolean,
    failure?: string
  ): Promise<string> {
    const status = failure
      ? `匹配中止：${failure}`
      : stopped
        ? '用户提前停止'
        : reachedBottom
          ? '已抓取到聊天底部'
          : hitLimit
            ? '已达到最大采样帧数'
            : '已保存'
    const lines = [
      '# 微信聊天记录（连续长截图）',
      '',
      `- 窗口：${sourceName}`,
      `- 抓取时间：${new Date().toLocaleString('zh-CN')}`,
      `- 状态：${status}`,
      `- 长图高度：${capturedHeight}px`,
      '',
      '## 无缝长图',
      '',
      ...longImages.flatMap((_, index) => [`![长图 ${index + 1}](./long/long_${String(index + 1).padStart(3, '0')}.png)`, '']),
      '## 长图分屏',
      '',
      ...screenshots.flatMap((_, index) => [`![第 ${index + 1} 屏](./screenshots/screen_${String(index + 1).padStart(4, '0')}.png)`, ''])
    ]
    const path = join(root, '微信聊天记录.md')
    await writeFile(path, lines.join('\n'), 'utf8')
    return path
  }

  private async createRunDirectory(baseDirectory: string, sourceName: string): Promise<string> {
    const base = baseDirectory.trim() || this.defaultOutputDirectory
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
    const safeName = sourceName.replace(/[<>:"/\\|?*]/g, '_').slice(0, 36) || '微信'
    await mkdir(base, { recursive: true })
    for (let suffix = 0; suffix < 1000; suffix += 1) {
      const directory = join(base, `${stamp}_${safeName}_连续${suffix === 0 ? '' : `_${suffix + 1}`}`)
      try {
        await mkdir(directory)
        return directory
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    throw new Error('无法创建连续长截图输出目录')
  }

  private assertSender(run: ContinuousRun): void {
    if (run.sender.isDestroyed()) throw new Error('工具页面已关闭')
  }

  private emit(
    run: ContinuousRun,
    stage: WechatCaptureEvent['stage'],
    message: string,
    screenCount: number,
    capturedHeight: number,
    previewDataUrl?: string,
    markdownPath?: string
  ): void {
    if (run.sender.isDestroyed()) return
    const payload: WechatCaptureEvent = {
      runId: run.id,
      mode: 'continuous',
      stage,
      message,
      screenCount,
      capturedHeight,
      outputDirectory: run.outputDirectory,
      previewDataUrl,
      markdownPath
    }
    run.sender.send('wechat-capture:event', payload)
  }
}

function matchContinuousFrames(previous: ContinuousFrame, current: ContinuousFrame): { overlap: number; score: number } {
  return findVerticalOverlap(
    previous.fingerprint,
    current.fingerprint,
    previous.width,
    previous.fingerprintHeight,
    0.35,
    0.995
  )
}

function frameReport(
  frame: number,
  decision: { kind: 'append' | 'stationary' | 'reject'; overlap: number; shift: number },
  score: number
): FrameReport {
  return {
    frame,
    timestamp: new Date().toISOString(),
    kind: decision.kind,
    overlap: decision.overlap,
    shift: decision.shift,
    score
  }
}

/** 与常驻 PowerShell 进程逐次握手，确认一轮采集完成后才允许再次滚动。 */
class ContinuousScrollController {
  private readonly pending: Array<{ resolve: () => void; reject: (error: Error) => void }> = []
  private outputBuffer = ''
  private errorText = ''
  private failure: Error | null = null

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.consumeOutput(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.errorText = `${this.errorText}${chunk}`.trim().slice(-500)
    })
    child.once('error', (error) => this.fail(error))
    child.once('exit', (code) => {
      if (code !== 0 && !child.killed) {
        const message = this.errorText.replace(/^#< CLIXML\s*/i, '').trim()
        this.fail(new Error(message || `连续滚动控制进程退出，退出码 ${code ?? 'unknown'}`))
      } else {
        this.fail(new Error('连续滚动控制进程已结束'))
      }
    })
  }

  pulse(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.child.exitCode !== null || this.child.killed) return Promise.reject(new Error('连续滚动控制进程未运行'))
    return new Promise<void>((resolve, reject) => {
      const item = { resolve, reject }
      this.pending.push(item)
      this.child.stdin.write('scroll\n', (error) => {
        if (!error) return
        const index = this.pending.indexOf(item)
        if (index >= 0) this.pending.splice(index, 1)
        reject(error)
      })
    })
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.killed) return
    this.child.stdin.write('quit\n')
    await Promise.race([
      new Promise<void>((resolve) => this.child.once('exit', () => resolve())),
      delay(500)
    ])
    if (this.child.exitCode === null && !this.child.killed) this.child.kill()
  }

  private consumeOutput(chunk: string): void {
    this.outputBuffer += chunk
    const lines = this.outputBuffer.split(/\r?\n/)
    this.outputBuffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim() !== 'ok') continue
      this.pending.shift()?.resolve()
    }
  }

  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    for (const item of this.pending.splice(0)) item.reject(error)
  }
}

function validateRequest(request: WechatContinuousCaptureRequest): void {
  if (!request || typeof request.sourceId !== 'string' || !request.sourceId.startsWith('window:')) throw new Error('请选择有效的微信窗口')
  for (const value of Object.values(request.crop)) if (!Number.isFinite(value) || value < 0 || value > 80) throw new Error('截图区域参数无效')
  if (request.crop.left + request.crop.right >= 90 || request.crop.top + request.crop.bottom >= 90) throw new Error('截图区域过小')
  if (!Number.isInteger(request.frameIntervalMs) || request.frameIntervalMs < 80 || request.frameIntervalMs > 1000) throw new Error('采样间隔必须在 80 到 1000 毫秒之间')
  if (!Number.isInteger(request.scrollIntervalMs) || request.scrollIntervalMs < 160 || request.scrollIntervalMs > 2000) throw new Error('滚动间隔必须在 160 到 2000 毫秒之间')
  if (request.scrollIntervalMs < request.frameIntervalMs * 2) throw new Error('滚动间隔至少应为采样间隔的 2 倍')
  if (!Number.isInteger(request.maxFrames) || request.maxFrames < 20 || request.maxFrames > 20_000) throw new Error('最大采样帧数必须在 20 到 20000 之间')
}

function cropToPixels(crop: WechatContinuousCaptureRequest['crop'], width: number, height: number): { left: number; top: number; width: number; height: number } {
  const left = Math.round(width * crop.left / 100)
  const top = Math.round(height * crop.top / 100)
  const right = Math.round(width * crop.right / 100)
  const bottom = Math.round(height * crop.bottom / 100)
  return { left, top, width: width - left - right, height: height - top - bottom }
}

function parseWindowHandle(sourceId: string): string | null {
  return /^window:(\d+):/.exec(sourceId)?.[1] ?? null
}

function nativeScript(hwnd: string, crop: WechatContinuousCaptureRequest['crop']): string {
  const xRatio = (crop.left + (100 - crop.right)) / 200
  const yRatio = (crop.top + (100 - crop.bottom)) / 200
  return `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WechatContinuousNative {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extraInfo);
}
'@
$handle = [IntPtr]::new([Int64]${hwnd})
$rect = New-Object WechatContinuousNative+RECT
if ([WechatContinuousNative]::IsIconic($handle)) { [WechatContinuousNative]::ShowWindowAsync($handle, 9) | Out-Null }
[WechatContinuousNative]::SetForegroundWindow($handle) | Out-Null
Start-Sleep -Milliseconds 80
if (-not [WechatContinuousNative]::GetWindowRect($handle, [ref]$rect)) { throw 'Cannot read window bounds' }
$x = [int]($rect.Left + ($rect.Right - $rect.Left) * ${xRatio.toFixed(4)})
$y = [int]($rect.Top + ($rect.Bottom - $rect.Top) * ${yRatio.toFixed(4)})
[WechatContinuousNative]::SetCursorPos($x, $y) | Out-Null
`
}

function oneShotScrollScript(hwnd: string, crop: WechatContinuousCaptureRequest['crop'], direction: 'up' | 'down', steps: number): string {
  const delta = direction === 'up' ? 120 : -120
  return `${nativeScript(hwnd, crop)}
$remaining = ${steps}
while ($remaining -gt 0) {
  $chunk = [Math]::Min(12, $remaining)
  [WechatContinuousNative]::mouse_event(0x0800, 0, 0, ${delta} * $chunk, [UIntPtr]::Zero)
  $remaining -= $chunk
  if ($remaining -gt 0) { Start-Sleep -Milliseconds 8 }
}
`
}

function controlledScrollScript(hwnd: string, crop: WechatContinuousCaptureRequest['crop']): string {
  return `${nativeScript(hwnd, crop)}
while ($true) {
  $command = [Console]::In.ReadLine()
  if ($null -eq $command -or $command -eq 'quit') { break }
  if ($command -ne 'scroll') { continue }
  [WechatContinuousNative]::SetForegroundWindow($handle) | Out-Null
  [WechatContinuousNative]::SetCursorPos($x, $y) | Out-Null
  [WechatContinuousNative]::mouse_event(0x0800, 0, 0, -1440, [UIntPtr]::Zero)
  [Console]::Out.WriteLine('ok')
  [Console]::Out.Flush()
}
`
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
