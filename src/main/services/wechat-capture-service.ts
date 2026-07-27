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
import {
  scrollChatToTop,
  WechatScrollController,
  type ScrollDriver,
  TargetWindowMinimizedError
} from './wechat-scroll-controller'
import { nativeCaptureSize } from './capture-resolution'
import { CaptureTimingLog } from './capture-timing-log'

const FINGERPRINT_WIDTH = 320
const LONG_IMAGE_HEIGHT = 20_000
const STOP_HOTKEY = 'CommandOrControl+E'

interface ActiveRun {
  id: string
  cancelled: boolean
  sender: WebContents
  outputDirectory: string
  scroller: ScrollDriver | null
  log: CaptureTimingLog
}

interface CapturedFrame {
  buffer: Buffer
  width: number
  height: number
  fingerprint: Uint8Array
  fingerprintHeight: number
}

/** 抓取任意桌面窗口、自动滚动，并产出分屏、长图和 Markdown。 */
export class WechatCaptureService {
  private activeRun: ActiveRun | null = null

  get defaultOutputDirectory(): string {
    return join(app.getPath('desktop'), '滚动长截图')
  }

  /** 返回全部可截图窗口；常用通信软件和浏览器置顶，其余按预览面积降序。 */
  async listWindows(): Promise<WechatWindowSource[]> {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      // 预览直接用于精确框选，也作为视频流最低清晰度基线，不能为枚举提速而降采样。
      thumbnailSize: nativeCaptureSize(),
      fetchWindowIcons: true
    })
    return sources
      .map((source) => {
        const size = source.thumbnail.getSize()
        const application = identifyApplication(source.name)
        const capturable = !source.thumbnail.isEmpty() && size.width > 0 && size.height > 0
        return {
          captureApiVersion: 2,
          id: source.id,
          name: source.name || '未命名窗口',
          thumbnailDataUrl: capturable ? source.thumbnail.toDataURL() : source.appIcon?.toDataURL() ?? '',
          width: capturable ? size.width : 0,
          height: capturable ? size.height : 0,
          capturable,
          application: application.id,
          applicationLabel: application.label
        }
      })
      .sort((first, second) => {
        const priority = applicationPriority(first.application) - applicationPriority(second.application)
        return priority || second.width * second.height - first.width * first.height || first.name.localeCompare(second.name, 'zh-CN')
      })
  }

  /** 校验参数并在后台启动一次抓取。 */
  async start(request: WechatCaptureRequest, sender: WebContents): Promise<WechatCaptureStartResult> {
    if (process.platform !== 'win32') throw new Error('自动滚动截图目前仅支持 Windows')
    if (this.activeRun) throw new Error('已有截图任务正在运行')
    validateRequest(request)
    const outputDirectory = await this.createRunDirectory(request.outputDirectory, request.sourceName)
    const log = await CaptureTimingLog.create(outputDirectory, {
      mode: 'paged',
      sourceId: request.sourceId,
      sourceName: request.sourceName,
      crop: request.crop,
      scrollStep: request.scrollStep,
      settleDelayMs: request.settleDelayMs,
      maxScreens: request.maxScreens
    })
    const run: ActiveRun = { id: crypto.randomUUID(), cancelled: false, sender, outputDirectory, scroller: null, log }
    this.activeRun = run
    if (!globalShortcut.register(STOP_HOTKEY, () => this.stop())) {
      this.activeRun = null
      await log.finish('error', { error: 'Ctrl+E 已被其他程序占用' })
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
    let finalStatus: 'complete' | 'stopped' | 'error' = 'error'
    let finalError: string | undefined
    try {
      await run.log.measure('output.create_directories', () =>
        Promise.all([mkdir(screenshotsDirectory, { recursive: true }), mkdir(longDirectory, { recursive: true })]))
      const scrollerStartedAt = performance.now()
      run.scroller = WechatScrollController.start(request.sourceId, request.crop)
      run.log.record('scroll_driver.start', performance.now() - scrollerStartedAt, { driver: run.scroller.name })
      const startFromTop = request.startFromTop !== false
      this.emit(run, 'positioning', startFromTop ? '正在将内容滚动到顶部...' : '从当前位置开始截图...', 0)
      const top = await run.log.measure(startFromTop ? 'position_to_top.total' : 'capture_start_frame.total', () => startFromTop
        ? scrollChatToTop({
            controller: { scroll: (notches) => this.scroll(run, notches, screenPaths.length) },
            capture: () => this.capture(run, request),
            isCancelled: () => run.cancelled || run.sender.isDestroyed(),
            onProgress: (burst) => this.emit(run, 'positioning', `正在定位顶部（第 ${burst + 1} 次翻页）...`, 0),
            pollDelayMs: Math.min(120, Math.max(80, Math.round(request.settleDelayMs / 3)))
          })
        : this.capture(run, request))
      if (!top || run.cancelled) {
        finalStatus = 'stopped'
        this.emit(run, 'stopped', '截图已停止', 0)
        return
      }

      let frame = top
      await this.saveScreen(run, frame.buffer, screenshotsDirectory, screenPaths, overlaps, 0)
      this.emit(run, 'capturing', '已从顶部开始截图，按 Ctrl+E 可停止', screenPaths.length, await this.preview(run, frame.buffer))

      let unchangedCount = 0
      let reachedBottom = false
      captureLoop: while (!run.cancelled && screenPaths.length < request.maxScreens) {
        this.assertSender(run)
        const baseFrame = frame
        let lastObserved = frame
        let highOverlapCandidate: { frame: CapturedFrame; overlap: number } | null = null

        for (let attempt = 0; attempt < 12 && !run.cancelled; attempt += 1) {
          const iterationStartedAt = performance.now()
          run.log.record('iteration.start', undefined, { screen: screenPaths.length + 1, attempt: attempt + 1 })
          await this.scroll(run, -(attempt === 0 ? request.scrollStep : 1), screenPaths.length)
          await run.log.measure('frame.wait_fixed_settle', () => delay(request.settleDelayMs), { delayMs: request.settleDelayMs })
          const next = await this.capture(run, request)
          const movement = normalizedImageDifference(lastObserved.fingerprint, next.fingerprint)
          run.log.record('frame.compare_movement', undefined, { movement })
          if (movement < 0.0035) {
            unchangedCount += 1
            if (highOverlapCandidate) {
              await this.saveScreen(run, highOverlapCandidate.frame.buffer, screenshotsDirectory, screenPaths, overlaps, highOverlapCandidate.overlap)
              frame = highOverlapCandidate.frame
              this.emit(run, 'capturing', `正在抓取第 ${screenPaths.length} 屏，按 Ctrl+E 可停止`, screenPaths.length, await this.preview(run, frame.buffer))
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
          const matchStartedAt = performance.now()
          const match = findVerticalOverlap(baseFrame.fingerprint, next.fingerprint, FINGERPRINT_WIDTH, baseFrame.fingerprintHeight)
          const overlap = acceptedOverlapHeight(match, baseFrame.height, baseFrame.fingerprintHeight)
          const overlapDecision = classifyCaptureOverlap(overlap, baseFrame.height)
          run.log.record('frame.match', performance.now() - matchStartedAt, {
            score: match.score,
            overlap,
            decision: overlapDecision
          })

          if (overlapDecision === 'continue') {
            highOverlapCandidate = { frame: next, overlap }
            continue
          }

          if (overlapDecision === 'save') {
            await this.saveScreen(run, next.buffer, screenshotsDirectory, screenPaths, overlaps, overlap)
            frame = next
            this.emit(run, 'capturing', `正在抓取第 ${screenPaths.length} 屏，按 Ctrl+E 可停止`, screenPaths.length, await this.preview(run, next.buffer))
            continue captureLoop
          }

          if (highOverlapCandidate && screenPaths.length + 1 < request.maxScreens) {
            await this.saveScreen(run, highOverlapCandidate.frame.buffer, screenshotsDirectory, screenPaths, overlaps, highOverlapCandidate.overlap)
            const adjacentMatch = findVerticalOverlap(highOverlapCandidate.frame.fingerprint, next.fingerprint, FINGERPRINT_WIDTH, highOverlapCandidate.frame.fingerprintHeight)
            const adjacentOverlap = acceptedOverlapHeight(adjacentMatch, highOverlapCandidate.frame.height, highOverlapCandidate.frame.fingerprintHeight)
            await this.saveScreen(run, next.buffer, screenshotsDirectory, screenPaths, overlaps, adjacentOverlap)
          } else {
            await this.saveScreen(run, next.buffer, screenshotsDirectory, screenPaths, overlaps, 0)
          }
          frame = next
          this.emit(run, 'capturing', `正在抓取第 ${screenPaths.length} 屏，按 Ctrl+E 可停止`, screenPaths.length, await this.preview(run, next.buffer))
          continue captureLoop
        }

        if (highOverlapCandidate && screenPaths.length < request.maxScreens) {
          await this.saveScreen(run, highOverlapCandidate.frame.buffer, screenshotsDirectory, screenPaths, overlaps, highOverlapCandidate.overlap)
          frame = highOverlapCandidate.frame
          this.emit(run, 'capturing', `正在抓取第 ${screenPaths.length} 屏，按 Ctrl+E 可停止`, screenPaths.length, await this.preview(run, frame.buffer))
        }
      }

      const stopped = run.cancelled
      const completionMessage = reachedBottom ? '已到达底部，正在生成长图和 Markdown...' : '已达到最大分屏数，正在生成长图和 Markdown...'
      this.emit(run, 'stitching', stopped ? '正在保存已抓取内容...' : completionMessage, screenPaths.length)
      const longPaths = await run.log.measure('output.build_long_images', () => this.buildLongImages(screenPaths, overlaps, longDirectory), { screens: screenPaths.length })
      const markdownPath = await run.log.measure('output.write_markdown', () =>
        this.writeMarkdown(run.outputDirectory, request.sourceName, screenPaths, longPaths, stopped, reachedBottom))
      finalStatus = stopped ? 'stopped' : 'complete'
      const finalMessage = stopped ? '截图已停止，现有内容已保存' : reachedBottom ? '滚动长截图已完成' : '已达到最大分屏数，现有内容已保存'
      this.emit(run, stopped ? 'stopped' : 'complete', finalMessage, screenPaths.length, undefined, markdownPath)
    } catch (error) {
      if (run.cancelled) {
        finalStatus = 'stopped'
        this.emit(run, 'stopped', '截图已停止', screenPaths.length)
      } else {
        const message = error instanceof Error ? error.message : String(error)
        finalStatus = 'error'
        finalError = message
        this.emit(run, 'error', message, screenPaths.length)
      }
    } finally {
      await this.stopScroller(run)
      if (this.activeRun === run) this.activeRun = null
      globalShortcut.unregister(STOP_HOTKEY)
      await run.log.finish(finalStatus, { screens: screenPaths.length, error: finalError })
    }
  }

  private async capture(run: ActiveRun, request: WechatCaptureRequest): Promise<CapturedFrame> {
    const sources = await run.log.measure('frame.capture.enumerate_windows', () =>
      desktopCapturer.getSources({ types: ['window'], thumbnailSize: nativeCaptureSize() }))
    const source = sources.find((candidate) => candidate.id === request.sourceId)
    if (!source || source.thumbnail.isEmpty()) throw new Error('目标窗口已关闭或无法读取')
    const image = sharp(source.thumbnail.toPNG())
    const metadata = await image.metadata()
    if (!metadata.width || !metadata.height) throw new Error('无法读取目标窗口尺寸')
    const region = cropToPixels(request.crop, metadata.width, metadata.height)
    const buffer = await run.log.measure('frame.capture.crop_encode', () => image.extract(region).png().toBuffer(), region)
    const fingerprintHeight = Math.max(24, Math.round(region.height * FINGERPRINT_WIDTH / region.width))
    const fingerprint = await run.log.measure('frame.capture.fingerprint', () =>
      sharp(buffer).resize(FINGERPRINT_WIDTH, fingerprintHeight, { fit: 'fill' }).grayscale().raw().toBuffer(),
    { width: FINGERPRINT_WIDTH, height: fingerprintHeight })
    return {
      buffer,
      width: region.width,
      height: region.height,
      fingerprint,
      fingerprintHeight
    }
  }

  /** 预览图只在推送进度时生成，采样路径不再逐帧缩放编码。 */
  private async preview(run: ActiveRun, buffer: Buffer): Promise<string> {
    const image = await run.log.measure('preview.encode', () =>
      sharp(buffer).resize({ width: 240, withoutEnlargement: true }).png().toBuffer())
    return `data:image/png;base64,${image.toString('base64')}`
  }

  private async stopScroller(run: ActiveRun): Promise<void> {
    const child = run.scroller
    if (!child) return
    run.scroller = null
    await run.log.measure('scroll_driver.stop', () => child.stop(), { driver: child.name })
  }

  private async scroll(run: ActiveRun, notches: number, screenCount: number): Promise<void> {
    if (!run.scroller) throw new Error('滚动控制进程未启动')
    while (!run.cancelled) {
      try {
        await run.log.measure('scroll.execute', () => run.scroller!.scroll(notches), { notches })
        return
      } catch (error) {
        if (!(error instanceof TargetWindowMinimizedError)) throw error
        this.emit(run, 'positioning', '目标窗口已最小化，请恢复窗口；恢复后将自动继续', screenCount)
        const minimizedAt = performance.now()
        while (!run.cancelled && await run.scroller.isMinimized()) await delay(300)
        run.log.record('scroll.wait_for_window_restore', performance.now() - minimizedAt)
      }
    }
  }

  private async saveScreen(run: ActiveRun, buffer: Buffer, directory: string, paths: string[], overlaps: number[], overlap: number): Promise<void> {
    const path = join(directory, `screen_${String(paths.length + 1).padStart(4, '0')}.png`)
    await run.log.measure('screen.write', () => writeFile(path, buffer), { screen: paths.length + 1, bytes: buffer.byteLength, overlap })
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
      '# 滚动长截图',
      '',
      `- 窗口：${sourceName}`,
      `- 抓取时间：${new Date().toLocaleString('zh-CN')}`,
      `- 状态：${stopped ? '用户提前停止' : reachedBottom ? '已抓取到内容底部' : '已达到最大分屏数'}`,
      `- 分屏数量：${screens.length}`,
      '',
      '## 长截图',
      '',
      ...longImages.flatMap((_, index) => [`![长截图 ${index + 1}](./long/long_${String(index + 1).padStart(3, '0')}.png)`, '']),
      '## 原始分屏',
      '',
      ...screens.flatMap((_, index) => [`![第 ${index + 1} 屏](./screenshots/screen_${String(index + 1).padStart(4, '0')}.png)`, ''])
    ]
    const path = join(root, '滚动长截图.md')
    await writeFile(path, lines.join('\n'), 'utf8')
    return path
  }

  private async createRunDirectory(baseDirectory: string, sourceName: string): Promise<string> {
    const base = baseDirectory.trim() || this.defaultOutputDirectory
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
    const safeName = sourceName.replace(/[<>:"/\\|?*]/g, '_').slice(0, 40) || '窗口'
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
  if (!request || typeof request.sourceId !== 'string' || !request.sourceId.startsWith('window:')) throw new Error('请选择有效的目标窗口')
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function identifyApplication(name: string): { id: WechatWindowSource['application']; label: string } {
  if (/微信|wechat/i.test(name)) return { id: 'wechat', label: '微信' }
  if (/(^|\s)qq(nt)?($|\s)|腾讯qq/i.test(name)) return { id: 'qq', label: 'QQ' }
  if (/chrome|edge|firefox|brave|vivaldi|opera|arc|浏览器/i.test(name)) return { id: 'browser', label: '浏览器' }
  if (/excel|word|powerpoint|outlook/i.test(name)) return { id: 'office', label: 'Office' }
  if (/intellij|idea|webstorm|pycharm|rider|clion|goland|visual studio|vscode/i.test(name)) return { id: 'ide', label: 'IDE' }
  if (/codex/i.test(name)) return { id: 'codex', label: 'Codex' }
  if (/command prompt|powershell|cmd\.exe|windows terminal|终端|命令提示符/i.test(name)) return { id: 'terminal', label: '终端' }
  if (/飞书|lark/i.test(name)) return { id: 'feishu', label: '飞书' }
  if (/钉钉|dingtalk/i.test(name)) return { id: 'dingtalk', label: '钉钉' }
  return { id: 'unknown', label: '其他' }
}

function applicationPriority(application: WechatWindowSource['application']): number {
  return ['wechat', 'qq', 'browser', 'office', 'ide', 'codex', 'terminal', 'feishu', 'dingtalk', 'unknown'].indexOf(application)
}
