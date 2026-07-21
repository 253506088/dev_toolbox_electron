import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, desktopCapturer, globalShortcut, type WebContents } from 'electron'
import sharp from 'sharp'
import {
  acceptedOverlapHeight,
  classifyCaptureOverlap,
  findVerticalOverlap,
  normalizedImageDifference,
  type WechatCaptureEvent,
  type WechatCaptureRequest,
  type WechatCaptureStartResult,
  type WechatWindowSource
} from '../../shared/wechat-capture'

const CAPTURE_SIZE = { width: 1920, height: 1080 }
const FINGERPRINT_WIDTH = 320
const LONG_IMAGE_HEIGHT = 20_000
const STOP_HOTKEY = 'CommandOrControl+E'

interface ActiveRun {
  id: string
  cancelled: boolean
  sender: WebContents
  outputDirectory: string
}

interface CapturedFrame {
  buffer: Buffer
  width: number
  height: number
  fingerprint: Uint8Array
  fingerprintHeight: number
  previewDataUrl: string
}

/** 抓取微信窗口、自动滚动，并产出分屏、长图和 Markdown。 */
export class WechatCaptureService {
  private activeRun: ActiveRun | null = null

  get defaultOutputDirectory(): string {
    return join(app.getPath('desktop'), '微信聊天截图')
  }

  /** 列出名称疑似微信的窗口；没有命中时返回全部普通窗口供用户手选。 */
  async listWindows(): Promise<WechatWindowSource[]> {
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1600, height: 1000 } })
    const mapped = sources
      .filter((source) => !source.thumbnail.isEmpty())
      .map((source) => {
        const size = source.thumbnail.getSize()
        return {
          id: source.id,
          name: source.name || '未命名窗口',
          thumbnailDataUrl: source.thumbnail.toDataURL(),
          width: size.width,
          height: size.height
        }
      })
    const wechat = mapped.filter((source) => /微信|wechat/i.test(source.name))
    return wechat.length > 0 ? wechat : mapped
  }

  /** 校验参数并在后台启动一次抓取。 */
  async start(request: WechatCaptureRequest, sender: WebContents): Promise<WechatCaptureStartResult> {
    if (process.platform !== 'win32') throw new Error('微信自动滚动截图目前仅支持 Windows')
    if (this.activeRun) throw new Error('已有截图任务正在运行')
    validateRequest(request)
    const outputDirectory = await this.createRunDirectory(request.outputDirectory, request.sourceName)
    const run: ActiveRun = { id: crypto.randomUUID(), cancelled: false, sender, outputDirectory }
    this.activeRun = run
    if (!globalShortcut.register(STOP_HOTKEY, () => this.stop())) {
      this.activeRun = null
      throw new Error('Ctrl+E 已被其他程序占用，请关闭占用程序后重试')
    }
    void this.execute(run, request)
    return { runId: run.id, outputDirectory }
  }

  /** 请求停止当前抓取；当前一次截图或滚动结束后退出。 */
  stop(): void {
    if (this.activeRun) this.activeRun.cancelled = true
  }

  dispose(): void {
    this.stop()
    globalShortcut.unregister(STOP_HOTKEY)
  }

  private async execute(run: ActiveRun, request: WechatCaptureRequest): Promise<void> {
    const screenshotsDirectory = join(run.outputDirectory, 'screenshots')
    const longDirectory = join(run.outputDirectory, 'long')
    const screenPaths: string[] = []
    const overlaps: number[] = []
    try {
      await Promise.all([mkdir(screenshotsDirectory, { recursive: true }), mkdir(longDirectory, { recursive: true })])
      this.emit(run, 'positioning', '正在将聊天记录滚动到顶部...', 0)
      let previous = await this.capture(request)
      let stableCount = 0
      const positioningDelay = Math.min(300, request.settleDelayMs)
      for (let attempt = 0; attempt < 120 && stableCount < 3 && !run.cancelled; attempt += 1) {
        this.assertSender(run)
        await this.scroll(request.sourceId, request.crop, 'up', 80)
        await delay(positioningDelay)
        const current = await this.capture(request)
        stableCount = normalizedImageDifference(previous.fingerprint, current.fingerprint) < 0.0035 ? stableCount + 1 : 0
        previous = current
        this.emit(run, 'positioning', `正在定位顶部${'.'.repeat((attempt % 3) + 1)}`, 0)
      }
      if (run.cancelled) {
        this.emit(run, 'stopped', '截图已停止', 0)
        return
      }
      if (stableCount < 3) throw new Error('未能确认聊天记录顶部，请检查截图区域是否覆盖聊天消息列表')

      let frame = previous
      await this.saveScreen(frame.buffer, screenshotsDirectory, screenPaths, overlaps, 0)
      this.emit(run, 'capturing', '已从顶部开始截图，按 Ctrl+E 可停止', screenPaths.length, frame.previewDataUrl)

      let unchangedCount = 0
      let reachedBottom = false
      captureLoop: while (!run.cancelled && screenPaths.length < request.maxScreens) {
        this.assertSender(run)
        const baseFrame = frame
        let lastObserved = frame
        let highOverlapCandidate: { frame: CapturedFrame; overlap: number } | null = null

        for (let attempt = 0; attempt < 12 && !run.cancelled; attempt += 1) {
          await this.scroll(request.sourceId, request.crop, 'down', attempt === 0 ? request.scrollStep : 1)
          await delay(request.settleDelayMs)
          const next = await this.capture(request)
          const movement = normalizedImageDifference(lastObserved.fingerprint, next.fingerprint)
          if (movement < 0.0035) {
            unchangedCount += 1
            if (highOverlapCandidate) {
              await this.saveScreen(highOverlapCandidate.frame.buffer, screenshotsDirectory, screenPaths, overlaps, highOverlapCandidate.overlap)
              frame = highOverlapCandidate.frame
              this.emit(run, 'capturing', `正在抓取第 ${screenPaths.length} 屏，按 Ctrl+E 可停止`, screenPaths.length, frame.previewDataUrl)
              continue captureLoop
            }
            if (unchangedCount >= 2) {
              reachedBottom = true
              break captureLoop
            }
            lastObserved = next
            continue
          }
          unchangedCount = 0
          lastObserved = next
          const match = findVerticalOverlap(baseFrame.fingerprint, next.fingerprint, FINGERPRINT_WIDTH, baseFrame.fingerprintHeight)
          const overlap = acceptedOverlapHeight(match, baseFrame.height, baseFrame.fingerprintHeight)
          const overlapDecision = classifyCaptureOverlap(overlap, baseFrame.height)

          if (overlapDecision === 'continue') {
            highOverlapCandidate = { frame: next, overlap }
            continue
          }

          if (overlapDecision === 'save') {
            await this.saveScreen(next.buffer, screenshotsDirectory, screenPaths, overlaps, overlap)
            frame = next
            this.emit(run, 'capturing', `正在抓取第 ${screenPaths.length} 屏，按 Ctrl+E 可停止`, screenPaths.length, next.previewDataUrl)
            continue captureLoop
          }

          if (highOverlapCandidate && screenPaths.length + 1 < request.maxScreens) {
            await this.saveScreen(highOverlapCandidate.frame.buffer, screenshotsDirectory, screenPaths, overlaps, highOverlapCandidate.overlap)
            const adjacentMatch = findVerticalOverlap(highOverlapCandidate.frame.fingerprint, next.fingerprint, FINGERPRINT_WIDTH, highOverlapCandidate.frame.fingerprintHeight)
            const adjacentOverlap = acceptedOverlapHeight(adjacentMatch, highOverlapCandidate.frame.height, highOverlapCandidate.frame.fingerprintHeight)
            await this.saveScreen(next.buffer, screenshotsDirectory, screenPaths, overlaps, adjacentOverlap)
          } else {
            await this.saveScreen(next.buffer, screenshotsDirectory, screenPaths, overlaps, 0)
          }
          frame = next
          this.emit(run, 'capturing', `正在抓取第 ${screenPaths.length} 屏，按 Ctrl+E 可停止`, screenPaths.length, next.previewDataUrl)
          continue captureLoop
        }

        if (highOverlapCandidate && screenPaths.length < request.maxScreens) {
          await this.saveScreen(highOverlapCandidate.frame.buffer, screenshotsDirectory, screenPaths, overlaps, highOverlapCandidate.overlap)
          frame = highOverlapCandidate.frame
          this.emit(run, 'capturing', `正在抓取第 ${screenPaths.length} 屏，按 Ctrl+E 可停止`, screenPaths.length, frame.previewDataUrl)
        }
      }

      const stopped = run.cancelled
      const completionMessage = reachedBottom ? '已到达底部，正在生成长图和 Markdown...' : '已达到最大分屏数，正在生成长图和 Markdown...'
      this.emit(run, 'stitching', stopped ? '正在保存已抓取内容...' : completionMessage, screenPaths.length)
      const longPaths = await this.buildLongImages(screenPaths, overlaps, longDirectory)
      const markdownPath = await this.writeMarkdown(run.outputDirectory, request.sourceName, screenPaths, longPaths, stopped, reachedBottom)
      const finalMessage = stopped ? '截图已停止，现有内容已保存' : reachedBottom ? '聊天记录截图已完成' : '已达到最大分屏数，现有内容已保存'
      this.emit(run, stopped ? 'stopped' : 'complete', finalMessage, screenPaths.length, undefined, markdownPath)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.emit(run, 'error', message, screenPaths.length)
    } finally {
      if (this.activeRun === run) this.activeRun = null
      globalShortcut.unregister(STOP_HOTKEY)
    }
  }

  private async capture(request: WechatCaptureRequest): Promise<CapturedFrame> {
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: CAPTURE_SIZE })
    const source = sources.find((candidate) => candidate.id === request.sourceId)
    if (!source || source.thumbnail.isEmpty()) throw new Error('微信窗口已关闭或无法读取')
    const image = sharp(source.thumbnail.toPNG())
    const metadata = await image.metadata()
    if (!metadata.width || !metadata.height) throw new Error('无法读取微信窗口尺寸')
    const region = cropToPixels(request.crop, metadata.width, metadata.height)
    const buffer = await image.extract(region).png().toBuffer()
    const fingerprintHeight = Math.max(24, Math.round(region.height * FINGERPRINT_WIDTH / region.width))
    const [fingerprint, preview] = await Promise.all([
      sharp(buffer).resize(FINGERPRINT_WIDTH, fingerprintHeight, { fit: 'fill' }).grayscale().raw().toBuffer(),
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

  private async scroll(sourceId: string, crop: WechatCaptureRequest['crop'], direction: 'up' | 'down', steps: number): Promise<void> {
    const hwnd = parseWindowHandle(sourceId)
    if (!hwnd) throw new Error('无法识别微信窗口句柄')
    const script = windowsScrollScript(hwnd, crop, direction, steps)
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

  private async saveScreen(buffer: Buffer, directory: string, paths: string[], overlaps: number[], overlap: number): Promise<void> {
    const path = join(directory, `screen_${String(paths.length + 1).padStart(4, '0')}.png`)
    await writeFile(path, buffer)
    paths.push(path)
    overlaps.push(overlap)
  }

  private async buildLongImages(screenPaths: string[], overlaps: number[], outputDirectory: string): Promise<string[]> {
    if (screenPaths.length === 0) return []
    const metadata = await sharp(screenPaths[0]).metadata()
    if (!metadata.width || !metadata.height) throw new Error('无法读取分屏图片尺寸')
    const outputPaths: string[] = []
    let pieces: Array<{ input: Buffer; top: number; left: number }> = []
    let currentHeight = 0

    const flush = async (): Promise<void> => {
      if (currentHeight === 0) return
      const path = join(outputDirectory, `long_${String(outputPaths.length + 1).padStart(3, '0')}.png`)
      await sharp({ create: { width: metadata.width!, height: currentHeight, channels: 3, background: '#ffffff' } }).composite(pieces).png().toFile(path)
      outputPaths.push(path)
      pieces = []
      currentHeight = 0
    }

    for (let index = 0; index < screenPaths.length; index += 1) {
      const source = await readFile(screenPaths[index])
      const top = Math.min(metadata.height - 1, Math.max(0, overlaps[index] ?? 0))
      let sourceTop = top
      let remaining = metadata.height - top
      while (remaining > 0) {
        const available = LONG_IMAGE_HEIGHT - currentHeight
        const pieceHeight = Math.min(remaining, available)
        const piece = await sharp(source).extract({ left: 0, top: sourceTop, width: metadata.width, height: pieceHeight }).png().toBuffer()
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

  private async writeMarkdown(root: string, sourceName: string, screens: string[], longImages: string[], stopped: boolean, reachedBottom: boolean): Promise<string> {
    const lines = [
      '# 微信聊天记录',
      '',
      `- 窗口：${sourceName}`,
      `- 抓取时间：${new Date().toLocaleString('zh-CN')}`,
      `- 状态：${stopped ? '用户提前停止' : reachedBottom ? '已抓取到聊天底部' : '已达到最大分屏数'}`,
      `- 分屏数量：${screens.length}`,
      '',
      '## 长截图',
      '',
      ...longImages.flatMap((_, index) => [`![长截图 ${index + 1}](./long/long_${String(index + 1).padStart(3, '0')}.png)`, '']),
      '## 原始分屏',
      '',
      ...screens.flatMap((_, index) => [`![第 ${index + 1} 屏](./screenshots/screen_${String(index + 1).padStart(4, '0')}.png)`, ''])
    ]
    const path = join(root, '微信聊天记录.md')
    await writeFile(path, lines.join('\n'), 'utf8')
    return path
  }

  private async createRunDirectory(baseDirectory: string, sourceName: string): Promise<string> {
    const base = baseDirectory.trim() || this.defaultOutputDirectory
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
    const safeName = sourceName.replace(/[<>:"/\\|?*]/g, '_').slice(0, 40) || '微信'
    await mkdir(base, { recursive: true })
    for (let suffix = 0; suffix < 1000; suffix += 1) {
      const name = `${stamp}_${safeName}${suffix === 0 ? '' : `_${suffix + 1}`}`
      const directory = join(base, name)
      try {
        await mkdir(directory)
        return directory
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    throw new Error('无法创建新的截图输出目录')
  }

  private assertSender(run: ActiveRun): void {
    if (run.sender.isDestroyed()) throw new Error('工具页面已关闭')
  }

  private emit(
    run: ActiveRun,
    stage: WechatCaptureEvent['stage'],
    message: string,
    screenCount: number,
    previewDataUrl?: string,
    markdownPath?: string
  ): void {
    if (run.sender.isDestroyed()) return
    const payload: WechatCaptureEvent = {
      runId: run.id,
      stage,
      message,
      screenCount,
      outputDirectory: run.outputDirectory,
      markdownPath,
      previewDataUrl
    }
    run.sender.send('wechat-capture:event', payload)
  }
}

function validateRequest(request: WechatCaptureRequest): void {
  if (!request || typeof request.sourceId !== 'string' || !request.sourceId.startsWith('window:')) throw new Error('请选择有效的微信窗口')
  for (const value of Object.values(request.crop)) if (!Number.isFinite(value) || value < 0 || value > 80) throw new Error('截图区域参数无效')
  if (request.crop.left + request.crop.right >= 90 || request.crop.top + request.crop.bottom >= 90) throw new Error('截图区域过小')
  if (!Number.isInteger(request.scrollStep) || request.scrollStep < 1 || request.scrollStep > 3) throw new Error('滚动步长必须在 1 到 3 之间')
  if (!Number.isInteger(request.settleDelayMs) || request.settleDelayMs < 200 || request.settleDelayMs > 5000) throw new Error('截图等待时间必须在 200 到 5000 毫秒之间')
  if (!Number.isInteger(request.maxScreens) || request.maxScreens < 2 || request.maxScreens > 1000) throw new Error('最大截图数必须在 2 到 1000 之间')
}

function cropToPixels(crop: WechatCaptureRequest['crop'], width: number, height: number): { left: number; top: number; width: number; height: number } {
  const left = Math.round(width * crop.left / 100)
  const top = Math.round(height * crop.top / 100)
  const right = Math.round(width * crop.right / 100)
  const bottom = Math.round(height * crop.bottom / 100)
  return { left, top, width: width - left - right, height: height - top - bottom }
}

function parseWindowHandle(sourceId: string): string | null {
  const match = /^window:(\d+):/.exec(sourceId)
  return match?.[1] ?? null
}

function windowsScrollScript(hwnd: string, crop: WechatCaptureRequest['crop'], direction: 'up' | 'down', steps: number): string {
  const delta = direction === 'up' ? 120 : -120
  const xRatio = (crop.left + (100 - crop.right)) / 200
  const yRatio = (crop.top + (100 - crop.bottom)) / 200
  return `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WechatCaptureNative {
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
$rect = New-Object WechatCaptureNative+RECT
if ([WechatCaptureNative]::IsIconic($handle)) { [WechatCaptureNative]::ShowWindowAsync($handle, 9) | Out-Null }
[WechatCaptureNative]::SetForegroundWindow($handle) | Out-Null
Start-Sleep -Milliseconds 80
if (-not [WechatCaptureNative]::GetWindowRect($handle, [ref]$rect)) { throw 'Cannot read window bounds' }
$x = [int]($rect.Left + ($rect.Right - $rect.Left) * ${xRatio.toFixed(4)})
$y = [int]($rect.Top + ($rect.Bottom - $rect.Top) * ${yRatio.toFixed(4)})
[WechatCaptureNative]::SetCursorPos($x, $y) | Out-Null
$remaining = ${steps}
while ($remaining -gt 0) {
  $chunk = [Math]::Min(12, $remaining)
  [WechatCaptureNative]::mouse_event(0x0800, 0, 0, ${delta} * $chunk, [UIntPtr]::Zero)
  $remaining -= $chunk
  if ($remaining -gt 0) { Start-Sleep -Milliseconds 8 }
}
`
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
