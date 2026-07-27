import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, desktopCapturer, globalShortcut, type WebContents } from 'electron'
import sharp from 'sharp'
import {
  computeBlankRows,
  continuousFrameDecision,
  continuousOverlapSearchWindow,
  continuousSafeStripRegion,
  findVerticalOverlap,
  normalizedImageDifference,
  planScreenSlices,
  type WechatCaptureEvent,
  type WechatContinuousCaptureRequest,
  type WechatCaptureStartResult
} from '../../shared/wechat-capture'
import {
  scrollChatToTop,
  waitForStillFrame,
  WechatScrollController,
  FRAME_STILL_THRESHOLD,
  type ScrollDriver,
  TargetWindowMinimizedError
} from './wechat-scroll-controller'
import { nativeCaptureSize } from './capture-resolution'
import { VideoFrameSourceService } from './video-frame-source-service'
import { CaptureTimingLog } from './capture-timing-log'

const LONG_IMAGE_HEIGHT = 20_000
const STOP_HOTKEY = 'CommandOrControl+E'
const INITIAL_PULSE_NOTCHES = 12
const MIN_PULSE_NOTCHES = 4
const MAX_PULSE_NOTCHES = 90
const TARGET_SHIFT_RATIO = 0.5
const SETTLE_TIMEOUT_MS = 1600

interface ContinuousFrame {
  buffer: Buffer | null
  width: number
  height: number
  fingerprint: Uint8Array
  fingerprintWidth: number
  fingerprintHeight: number
  videoFrameId?: number
}

interface ContinuousRun {
  id: string
  cancelled: boolean
  sender: WebContents
  outputDirectory: string
  scroller: ScrollDriver | null
  log: CaptureTimingLog
}

interface FrameReport {
  frame: number
  timestamp: string
  kind: 'initial' | 'append' | 'stationary' | 'reject'
  overlap: number
  shift: number
  score: number
  pulseNotches: number
  settleMs?: number
  captureMs?: number
  matchMs?: number
  encodeMs?: number
}

/** 保序异步写盘队列：采集主循环不再逐帧等待 PNG 编码与磁盘写入。 */
class StripWriteQueue {
  private chain: Promise<void> = Promise.resolve()
  private pendingCount = 0
  private completed = 0
  private failure: Error | null = null

  push(job: () => Promise<unknown>): void {
    this.pendingCount += 1
    this.chain = this.chain
      .then(async () => {
        if (this.failure) return
        try {
          await job()
          this.completed += 1
        } catch (error) {
          this.failure = error instanceof Error ? error : new Error(String(error))
        }
      })
      .finally(() => {
        this.pendingCount -= 1
      })
  }

  get depth(): number {
    return this.pendingCount
  }

  /** 已成功落盘的任务数；任务严格按提交顺序执行，可据此截断路径列表。 */
  get completedCount(): number {
    return this.completed
  }

  assertHealthy(): void {
    if (this.failure) throw this.failure
  }

  async drain(): Promise<void> {
    await this.chain
    if (this.failure) throw this.failure
  }
}

/** 节点 2：连续采集相邻帧，只把可靠的新像素条追加到长图。 */
export class WechatContinuousCaptureService {
  private activeRun: ContinuousRun | null = null
  private readonly videoFrameSource = new VideoFrameSourceService()
  private useVideoFrameSource = false
  private frameSourceFallbackReason: string | null = null

  get defaultOutputDirectory(): string {
    return join(app.getPath('desktop'), '滚动长截图')
  }

  async start(request: WechatContinuousCaptureRequest, sender: WebContents): Promise<WechatCaptureStartResult> {
    if (process.platform !== 'win32') throw new Error('连续长截图目前仅支持 Windows')
    if (this.activeRun) throw new Error('已有连续长截图任务正在运行')
    validateRequest(request)
    const outputDirectory = await this.createRunDirectory(request.outputDirectory, request.sourceName)
    const log = await CaptureTimingLog.create(outputDirectory, {
      mode: 'continuous',
      sourceId: request.sourceId,
      sourceName: request.sourceName,
      crop: request.crop,
      stableWindowMs: request.frameIntervalMs,
      scrollIntervalMs: request.scrollIntervalMs,
      maxFrames: request.maxFrames
    })
    const run: ContinuousRun = {
      id: crypto.randomUUID(),
      cancelled: false,
      sender,
      outputDirectory,
      scroller: null,
      log
    }
    this.activeRun = run
    if (!globalShortcut.register(STOP_HOTKEY, () => this.stop())) {
      this.activeRun = null
      await log.finish('error', { error: 'Ctrl+E 已被其他截图任务或程序占用' })
      throw new Error('Ctrl+E 已被其他截图任务或程序占用')
    }
    void this.execute(run, request)
    return { runId: run.id, outputDirectory }
  }

  stop(): void {
    if (!this.activeRun) return
    this.activeRun.cancelled = true
    void this.stopScroller(this.activeRun)
  }

  dispose(): void {
    this.stop()
    globalShortcut.unregister(STOP_HOTKEY)
    this.videoFrameSource.dispose()
  }

  private async execute(run: ContinuousRun, request: WechatContinuousCaptureRequest): Promise<void> {
    const stripsDirectory = join(run.outputDirectory, 'strips')
    const longDirectory = join(run.outputDirectory, 'long')
    const screenshotsDirectory = join(run.outputDirectory, 'screenshots')
    const stripPaths: string[] = []
    const report: FrameReport[] = []
    const writer = new StripWriteQueue()
    let capturedHeight = 0
    let acceptedFrames = 0
    let reachedBottom = false
    let failure: Error | null = null
    let pixelsPerNotch: number | null = null
    let finalStatus: 'complete' | 'stopped' | 'error' = 'error'

    try {
      await run.log.measure('output.create_directories', () => Promise.all([
        mkdir(stripsDirectory, { recursive: true }),
        mkdir(longDirectory, { recursive: true }),
        mkdir(screenshotsDirectory, { recursive: true })
      ]))
      try {
        await run.log.measure('frame_source.open', () => this.videoFrameSource.open({
          sourceId: request.sourceId,
          crop: request.crop,
          maxSize: nativeCaptureSize(),
          minimumSize: request.expectedSize,
          fingerprintWidth: 320
        }))
        this.useVideoFrameSource = true
        this.frameSourceFallbackReason = null
      } catch (error) {
        this.useVideoFrameSource = false
        this.frameSourceFallbackReason = error instanceof Error ? error.message : String(error)
        await this.videoFrameSource.close()
        run.log.record('frame_source.fallback', undefined, { reason: this.frameSourceFallbackReason })
        this.emit(run, 'positioning', `视频流不可用，已降级为兼容模式（较慢）：${this.frameSourceFallbackReason}`, 0, 0)
      }
      const scrollerStartedAt = performance.now()
      run.scroller = WechatScrollController.start(request.sourceId, request.crop)
      run.log.record('scroll_driver.start', performance.now() - scrollerStartedAt, { driver: run.scroller.name })
      const startFromTop = request.startFromTop !== false
      this.emit(
        run,
        'positioning',
        startFromTop ? '连续长截图：正在快速定位内容顶部...' : '连续长截图：从当前位置开始采集...',
        0,
        0
      )
      const first = await run.log.measure(
        startFromTop ? 'position_to_top.total' : 'capture_start_frame.total',
        () => startFromTop ? this.positionAtTop(run, request) : this.captureStartFrame(run, request)
      )
      if (!first || run.cancelled) {
        finalStatus = 'stopped'
        this.emit(run, 'stopped', '连续长截图已停止', 0, 0)
        return
      }

      run.log.record('capture.resolution', undefined, {
        width: first.width,
        height: first.height,
        sourcePreviewWidth: request.expectedSize?.width,
        sourcePreviewHeight: request.expectedSize?.height,
        frameSource: this.frameSourceFallbackReason ? 'desktop-capturer' : 'video-stream'
      })

      const firstRegion = continuousSafeStripRegion(first.height, 1)
      const safeBottom = firstRegion.safeBottom
      const firstPath = join(stripsDirectory, 'strip_00000.png')
      const firstBuffer = await this.encodeFrame(first)
      writer.push(() =>
        run.log.measure('strip.write', () =>
          sharp(firstBuffer).extract({ left: 0, top: 0, width: first.width, height: safeBottom }).png().toFile(firstPath),
        { strip: 0, height: safeBottom })
      )
      stripPaths.push(firstPath)
      report.push({ frame: 0, timestamp: new Date().toISOString(), kind: 'initial', overlap: 0, shift: first.height, score: 0, pulseNotches: 0 })
      capturedHeight = safeBottom
      acceptedFrames = 1
      let previous = first
      let observedFrames = 1
      let stationaryCount = 0
      const bottomThreshold = 3
      let lastPulseAt = 0
      let pulseNotches = INITIAL_PULSE_NOTCHES

      this.emit(run, 'capturing', '连续滚动采集中，按 Ctrl+E 可停止', acceptedFrames, capturedHeight, await this.preview(firstBuffer))

      try {
        while (!run.cancelled && observedFrames < request.maxFrames) {
          const iteration = observedFrames
          const iterationStartedAt = performance.now()
          run.log.record('iteration.start', undefined, { iteration, acceptedFrames, pulseNotches })
          this.assertSender(run)
          writer.assertHealthy()
          const pacingDelay = Math.max(0, request.scrollIntervalMs - (Date.now() - lastPulseAt))
          if (pacingDelay > 0) await delay(pacingDelay)
          await this.scroll(run, -pulseNotches, acceptedFrames, capturedHeight)
          lastPulseAt = Date.now()
          const settleStartedAt = performance.now()
          const settled = await this.waitForSettledFrame(run, request, SETTLE_TIMEOUT_MS)
          const settleMs = Math.max(0, performance.now() - settleStartedAt - settled.captureMs)
          run.log.record('frame.settled', settleMs, {
            iteration,
            captureMs: settled.captureMs,
            still: settled.still,
            samples: settled.samples
          })
          observedFrames += settled.samples
          if (run.cancelled) break
          let current = settled.frame

          // 底部快速判定：画面与上一接受帧几乎一致时直接按静止处理，不做重叠搜索。
          // 窗口化搜索不包含“零位移”解，聊天背景又高度自相似，到底后容易凑出低分假位移，
          // 导致静止计数永远清零、采集不会自动结束。
          const stillDifference = normalizedImageDifference(previous.fingerprint, current.fingerprint)
          if (stillDifference < FRAME_STILL_THRESHOLD) {
            report.push({
              frame: observedFrames - 1,
              timestamp: new Date().toISOString(),
              kind: 'stationary',
              overlap: previous.height,
              shift: 0,
              score: stillDifference,
              pulseNotches,
              settleMs,
              captureMs: settled.captureMs
            })
            stationaryCount += 1
            run.log.record('iteration.finish', performance.now() - iterationStartedAt, {
              iteration, decision: 'stationary', score: stillDifference
            })
            if (stationaryCount >= bottomThreshold) {
              reachedBottom = true
              break
            }
            continue
          }

          const expectedShift = pixelsPerNotch === null ? null : pulseNotches * pixelsPerNotch
          const matchStartedAt = performance.now()
          let match = matchContinuousFrames(previous, current, expectedShift)
          let decision = continuousFrameDecision(match, previous.height, previous.fingerprintHeight)
          if (decision.kind === 'reject' && expectedShift !== null) {
            match = matchContinuousFrames(previous, current, null)
            decision = continuousFrameDecision(match, previous.height, previous.fingerprintHeight)
          }
          let currentReport = frameReport(observedFrames - 1, decision, match.score, pulseNotches)
          currentReport.settleMs = settleMs
          currentReport.captureMs = settled.captureMs
          currentReport.matchMs = performance.now() - matchStartedAt
          report.push(currentReport)
          run.log.record('frame.match', currentReport.matchMs, {
            iteration,
            kind: decision.kind,
            score: match.score,
            overlap: decision.overlap,
            shift: decision.shift
          })

          let usedRetry = false
          for (let retry = 0; decision.kind === 'reject' && retry < 3 && observedFrames < request.maxFrames && !run.cancelled; retry += 1) {
            usedRetry = true
            await delay(Math.max(150, request.frameIntervalMs))
            current = await this.capture(request)
            observedFrames += 1
            match = matchContinuousFrames(previous, current, null)
            decision = continuousFrameDecision(match, previous.height, previous.fingerprintHeight)
            currentReport = frameReport(observedFrames - 1, decision, match.score, pulseNotches)
            report.push(currentReport)
            run.log.record('frame.retry_match', undefined, {
              iteration,
              retry: retry + 1,
              kind: decision.kind,
              score: match.score,
              overlap: decision.overlap,
              shift: decision.shift
            })
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
            throw new Error('当前滚动后的画面经过多次稳定重采样仍无法可靠对齐，已停止以避免产生断层')
          }

          stationaryCount = 0
          const stripPath = join(stripsDirectory, `strip_${String(acceptedFrames).padStart(5, '0')}.png`)
          const stripRegion = continuousSafeStripRegion(current.height, decision.shift)
          const encodeStartedAt = performance.now()
          const stripSource = await this.encodeFrame(current)
          currentReport.encodeMs = performance.now() - encodeStartedAt
          const stripWidth = current.width
          writer.push(() =>
            run.log.measure('strip.write', () =>
              sharp(stripSource).extract({ left: 0, top: stripRegion.top, width: stripWidth, height: stripRegion.height }).png().toFile(stripPath),
            { strip: acceptedFrames, top: stripRegion.top, height: stripRegion.height })
          )
          stripPaths.push(stripPath)
          capturedHeight += decision.shift
          acceptedFrames += 1

          if (settled.still && !usedRetry && pulseNotches > 0) {
            const measured = decision.shift / pulseNotches
            if (pixelsPerNotch === null) pixelsPerNotch = measured
            else if (expectedShift === null || decision.shift > expectedShift * 0.3) pixelsPerNotch = pixelsPerNotch * 0.6 + measured * 0.4
          }
          if (pixelsPerNotch !== null && pixelsPerNotch > 0.1) {
            pulseNotches = clampInt(Math.round(current.height * TARGET_SHIFT_RATIO / pixelsPerNotch), MIN_PULSE_NOTCHES, MAX_PULSE_NOTCHES)
          }

          previous = current
          if (writer.depth > 8) await run.log.measure('strip_queue.drain', () => writer.drain(), { depth: writer.depth })
          this.emit(
            run,
            'capturing',
            `连续采集中：已追加 ${capturedHeight.toLocaleString('zh-CN')} 像素`,
            acceptedFrames,
            capturedHeight,
            await this.preview(stripSource)
          )
          run.log.record('iteration.finish', performance.now() - iterationStartedAt, {
            iteration,
            decision: 'append',
            shift: decision.shift,
            acceptedFrames,
            capturedHeight
          })
        }
      } catch (error) {
        if (!run.cancelled) failure = error instanceof Error ? error : new Error(String(error))
      } finally {
        await this.stopScroller(run)
      }

      const stopped = run.cancelled
      const hitLimit = !stopped && !reachedBottom && !failure
      if (reachedBottom) {
        const tailFrame = previous
        const tailHeight = tailFrame.height - safeBottom
        if (tailHeight > 0) {
          const tailPath = join(stripsDirectory, 'strip_tail.png')
          writer.push(() =>
            run.log.measure('strip.write_tail', () =>
              sharp(tailFrame.buffer!).extract({ left: 0, top: safeBottom, width: tailFrame.width, height: tailHeight }).png().toFile(tailPath),
            { height: tailHeight })
          )
          stripPaths.push(tailPath)
          capturedHeight += tailHeight
        }
      }
      try {
        await run.log.measure('strip_queue.final_drain', () => writer.drain(), { depth: writer.depth })
      } catch (error) {
        if (!failure) failure = error instanceof Error ? error : new Error(String(error))
        stripPaths.length = writer.completedCount
      }
      this.emit(run, 'stitching', '正在生成无缝长图、分屏和 Markdown...', acceptedFrames, capturedHeight)
      const longPaths = await run.log.measure('output.build_long_images', () => this.buildLongImages(stripPaths, longDirectory), { strips: stripPaths.length })
      const screenshotPaths = await run.log.measure('output.build_screenshots', () => this.buildScreenshots(longPaths, screenshotsDirectory, first.height), { longImages: longPaths.length })
      await run.log.measure('output.write_report', () => writeFile(join(run.outputDirectory, 'capture-report.json'), JSON.stringify({
        mode: 'continuous',
        sourceName: request.sourceName,
        crop: request.crop,
        startFromTop: request.startFromTop !== false,
        frameIntervalMs: request.frameIntervalMs,
        scrollIntervalMs: request.scrollIntervalMs,
        capturedHeight,
        captureWidth: first.width,
        viewportHeight: first.height,
        sourcePreviewSize: request.expectedSize,
        acceptedFrames,
        reachedBottom,
        stopped,
        failure: failure?.message,
        pixelsPerNotch,
        frameSource: this.frameSourceFallbackReason ? 'desktop-capturer' : 'video-stream',
        frameSourceFallbackReason: this.frameSourceFallbackReason,
        scrollDriver: run.scroller?.name ?? 'foreground-wheel',
        frames: report
      }, null, 2), 'utf8'))
      const markdownPath = await run.log.measure('output.write_markdown', () => this.writeMarkdown(
        run.outputDirectory,
        request.sourceName,
        longPaths,
        screenshotPaths,
        capturedHeight,
        stopped,
        reachedBottom,
        hitLimit,
        failure?.message
      ))

      if (failure) {
        finalStatus = 'error'
        this.emit(run, 'error', `${failure.message}；已保存停止前的连续长图`, acceptedFrames, capturedHeight, undefined, markdownPath)
      } else {
        finalStatus = stopped ? 'stopped' : 'complete'
        const message = stopped
          ? '连续长截图已停止，现有内容已保存'
          : reachedBottom
            ? '连续长截图已完成'
            : '已达到最大采样帧数，现有内容已保存'
        this.emit(run, stopped ? 'stopped' : 'complete', message, acceptedFrames, capturedHeight, undefined, markdownPath)
      }
    } catch (error) {
      await this.stopScroller(run)
      if (run.cancelled) {
        finalStatus = 'stopped'
        this.emit(run, 'stopped', '连续长截图已停止', acceptedFrames, capturedHeight)
      } else {
        finalStatus = 'error'
        const message = error instanceof Error ? error.message : String(error)
        this.emit(run, 'error', message, acceptedFrames, capturedHeight)
      }
    } finally {
      await run.log.measure('frame_source.close', () => this.videoFrameSource.close())
      this.useVideoFrameSource = false
      if (this.activeRun === run) this.activeRun = null
      globalShortcut.unregister(STOP_HOTKEY)
      await run.log.finish(finalStatus, {
        acceptedFrames,
        capturedHeight,
        reachedBottom,
        error: failure?.message
      })
    }
  }

  private async positionAtTop(run: ContinuousRun, request: WechatContinuousCaptureRequest): Promise<ContinuousFrame | null> {
    if (!run.scroller) throw new Error('滚动控制进程未启动')
    return scrollChatToTop({
      controller: { scroll: (notches) => this.scroll(run, notches, 0, 0) },
      capture: () => this.capture(request),
      isCancelled: () => run.cancelled,
      onProgress: (burst) =>
        this.emit(run, 'positioning', `连续长截图：正在快速定位顶部（第 ${burst + 1} 次翻页）...`, 0, 0),
      pollDelayMs: Math.min(120, request.frameIntervalMs),
      settle: () => this.waitForSettledFrame(run, request, 2000)
    })
  }

  /** 不回顶模式：等画面停稳后把当前内容作为长图起点。 */
  private async captureStartFrame(run: ContinuousRun, request: WechatContinuousCaptureRequest): Promise<ContinuousFrame | null> {
    const settled = await this.waitForSettledFrame(run, request, 1000)
    return run.cancelled ? null : settled.frame
  }

  private async waitForSettledFrame(
    run: ContinuousRun,
    request: WechatContinuousCaptureRequest,
    timeoutMs: number
  ): Promise<{ frame: ContinuousFrame; still: boolean; samples: number; captureMs: number }> {
    if (this.useVideoFrameSource) {
      try {
        const settled = await this.measureActive(
          'frame_source.wait_for_settle',
          () => this.videoFrameSource.waitForSettle(request.frameIntervalMs, timeoutMs),
          { quietMs: request.frameIntervalMs, timeoutMs }
        )
        if (run.cancelled) throw new CaptureCancelledError()
        const captureStartedAt = performance.now()
        const frame = await this.capture(request)
        return {
          frame,
          still: !settled.timedOut,
          samples: 1,
          captureMs: performance.now() - captureStartedAt
        }
      } catch (error) {
        if (error instanceof CaptureCancelledError) throw error
        this.frameSourceFallbackReason = error instanceof Error ? error.message : String(error)
        this.activeRun?.log.record('frame_source.fallback', undefined, { reason: this.frameSourceFallbackReason, stage: 'settle' })
        this.useVideoFrameSource = false
        await this.videoFrameSource.close()
      }
    }
    const captureStartedAt = performance.now()
    const result = await waitForStillFrame(() => this.capture(request), () => run.cancelled, {
      pollDelayMs: Math.min(120, request.frameIntervalMs),
      timeoutMs
    })
    return { ...result, captureMs: performance.now() - captureStartedAt }
  }

  private async capture(request: WechatContinuousCaptureRequest): Promise<ContinuousFrame> {
    if (this.useVideoFrameSource) {
      try {
        const frame = await this.measureActive('frame.capture.video_fingerprint', () => this.videoFrameSource.fingerprint())
        return {
          buffer: null,
          width: frame.width,
          height: frame.height,
          fingerprint: frame.fingerprint,
          fingerprintWidth: frame.fingerprintWidth,
          fingerprintHeight: frame.fingerprintHeight,
          videoFrameId: frame.frameId
        }
      } catch (error) {
        this.frameSourceFallbackReason = error instanceof Error ? error.message : String(error)
        this.activeRun?.log.record('frame_source.fallback', undefined, { reason: this.frameSourceFallbackReason, stage: 'fingerprint' })
        this.useVideoFrameSource = false
        await this.videoFrameSource.close()
      }
    }
    const sources = await this.measureActive(
      'frame.capture.compatible_enumerate_windows',
      () => desktopCapturer.getSources({ types: ['window'], thumbnailSize: nativeCaptureSize() })
    )
    const source = sources.find((candidate) => candidate.id === request.sourceId)
    if (!source || source.thumbnail.isEmpty()) throw new Error('目标窗口已关闭或无法读取')
    const image = sharp(source.thumbnail.toPNG())
    const metadata = await image.metadata()
    if (!metadata.width || !metadata.height) throw new Error('无法读取目标窗口尺寸')
    const region = cropToPixels(request.crop, metadata.width, metadata.height)
    const buffer = await this.measureActive(
      'frame.capture.compatible_crop_encode',
      () => image.extract(region).png().toBuffer(),
      region
    )
    const fingerprintWidth = 320
    const fingerprintHeight = Math.max(24, Math.round(region.height * fingerprintWidth / region.width))
    const fingerprint = await this.measureActive(
      'frame.capture.compatible_fingerprint',
      () => sharp(buffer).resize(fingerprintWidth, fingerprintHeight, { fit: 'fill' }).grayscale().raw().toBuffer(),
      { fingerprintWidth, fingerprintHeight }
    )
    return {
      buffer,
      width: region.width,
      height: region.height,
      fingerprint,
      fingerprintWidth,
      fingerprintHeight
    }
  }

  private async encodeFrame(frame: ContinuousFrame): Promise<Buffer> {
    if (frame.buffer) return frame.buffer
    if (frame.videoFrameId === undefined) throw new Error('采集帧缺少可编码的像素数据')
    frame.buffer = await this.measureActive(
      'frame.encode_png',
      () => this.videoFrameSource.encode(frame.videoFrameId!),
      { frameId: frame.videoFrameId }
    )
    return frame.buffer
  }

  /** 预览图只在需要推送进度时才生成，避免每次采样都做缩放编码。 */
  private async preview(buffer: Buffer): Promise<string> {
    const image = await this.measureActive(
      'preview.encode',
      () => sharp(buffer).resize({ width: 240, withoutEnlargement: true }).png().toBuffer()
    )
    return `data:image/png;base64,${image.toString('base64')}`
  }

  private async stopScroller(run: ContinuousRun): Promise<void> {
    const child = run.scroller
    if (!child) return
    run.scroller = null
    await run.log.measure('scroll_driver.stop', () => child.stop(), { driver: child.name })
  }

  private async scroll(
    run: ContinuousRun,
    notches: number,
    screenCount: number,
    capturedHeight: number
  ): Promise<void> {
    if (!run.scroller) throw new Error('滚动控制进程未启动')
    while (!run.cancelled) {
      try {
        await run.log.measure('scroll.execute', () => run.scroller!.scroll(notches), { notches })
        return
      } catch (error) {
        if (!(error instanceof TargetWindowMinimizedError)) throw error
        this.emit(run, 'positioning', '目标窗口已最小化，请恢复窗口；恢复后将自动继续', screenCount, capturedHeight)
        const minimizedAt = performance.now()
        while (!run.cancelled && await run.scroller.isMinimized()) await delay(300)
        run.log.record('scroll.wait_for_window_restore', performance.now() - minimizedAt)
      }
    }
  }

  private measureActive<T>(event: string, action: () => Promise<T>, details: Record<string, unknown> = {}): Promise<T> {
    const log = this.activeRun?.log
    return log ? log.measure(event, action, details) : action()
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

  /** 把多张长图视作一条连续画布，优先在消息间隙下刀切分屏，跨长图边界的切片自动拼合。 */
  private async buildScreenshots(longPaths: string[], outputDirectory: string, viewportHeight: number): Promise<string[]> {
    if (longPaths.length === 0) return []
    const segments: Array<{ path: string; top: number; height: number }> = []
    const blankChunks: Uint8Array[] = []
    let width = 0
    let totalHeight = 0
    for (const longPath of longPaths) {
      const metadata = await sharp(longPath).metadata()
      if (!metadata.width || !metadata.height) throw new Error('无法读取连续长图尺寸')
      if (width === 0) width = metadata.width
      if (metadata.width !== width) throw new Error('连续长图宽度不一致')
      const gray = await sharp(longPath).grayscale().raw().toBuffer()
      blankChunks.push(computeBlankRows(gray, metadata.width, metadata.height))
      segments.push({ path: longPath, top: totalHeight, height: metadata.height })
      totalHeight += metadata.height
    }
    const blankRows = new Uint8Array(totalHeight)
    let offset = 0
    for (const chunk of blankChunks) {
      blankRows.set(chunk, offset)
      offset += chunk.length
    }

    const slices = planScreenSlices(blankRows, viewportHeight)
    const outputPaths: string[] = []
    for (const slice of slices) {
      const path = join(outputDirectory, `screen_${String(outputPaths.length + 1).padStart(4, '0')}.png`)
      const covering = segments.filter(
        (segment) => segment.top < slice.top + slice.height && segment.top + segment.height > slice.top
      )
      if (covering.length === 1) {
        const segment = covering[0]
        await sharp(segment.path)
          .extract({ left: 0, top: slice.top - segment.top, width, height: slice.height })
          .png()
          .toFile(path)
      } else {
        const pieces: Array<{ input: Buffer; top: number; left: number }> = []
        for (const segment of covering) {
          const sourceTop = Math.max(0, slice.top - segment.top)
          const sourceBottom = Math.min(segment.height, slice.top + slice.height - segment.top)
          const piece = await sharp(segment.path)
            .extract({ left: 0, top: sourceTop, width, height: sourceBottom - sourceTop })
            .png()
            .toBuffer()
          pieces.push({ input: piece, top: segment.top + sourceTop - slice.top, left: 0 })
        }
        await sharp({ create: { width, height: slice.height, channels: 3, background: '#ffffff' } })
          .composite(pieces)
          .png()
          .toFile(path)
      }
      outputPaths.push(path)
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
          ? '已抓取到内容底部'
          : hitLimit
            ? '已达到最大采样帧数'
            : '已保存'
    const lines = [
      '# 滚动长截图（连续模式）',
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
    const path = join(root, '滚动长截图.md')
    await writeFile(path, lines.join('\n'), 'utf8')
    return path
  }

  private async createRunDirectory(baseDirectory: string, sourceName: string): Promise<string> {
    const base = baseDirectory.trim() || this.defaultOutputDirectory
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
    const safeName = sourceName.replace(/[<>:"/\\|?*]/g, '_').slice(0, 36) || '窗口'
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

function matchContinuousFrames(
  previous: ContinuousFrame,
  current: ContinuousFrame,
  expectedShift: number | null
): { overlap: number; score: number } {
  // expectedShift 是原图像素；搜索窗口只需要重叠率，因此必须用原图高度计算，
  // 再把同一比例交给缩略指纹。混用 fingerprintHeight 会把窗口推到错误位置。
  const searchWindow = expectedShift === null ? null : continuousOverlapSearchWindow(previous.height, expectedShift)
  return findVerticalOverlap(
    previous.fingerprint,
    current.fingerprint,
    previous.fingerprintWidth,
    previous.fingerprintHeight,
    searchWindow?.minimumRatio ?? 0.35,
    searchWindow?.maximumRatio ?? 0.995
  )
}

function frameReport(
  frame: number,
  decision: { kind: 'append' | 'stationary' | 'reject'; overlap: number; shift: number },
  score: number,
  pulseNotches: number
): FrameReport {
  return {
    frame,
    timestamp: new Date().toISOString(),
    kind: decision.kind,
    overlap: decision.overlap,
    shift: decision.shift,
    score,
    pulseNotches
  }
}

function validateRequest(request: WechatContinuousCaptureRequest): void {
  if (!request || typeof request.sourceId !== 'string' || !request.sourceId.startsWith('window:')) throw new Error('请选择有效的目标窗口')
  for (const value of Object.values(request.crop)) if (!Number.isFinite(value) || value < 0 || value > 80) throw new Error('截图区域参数无效')
  if (request.crop.left + request.crop.right >= 90 || request.crop.top + request.crop.bottom >= 90) throw new Error('截图区域过小')
  if (!Number.isInteger(request.frameIntervalMs) || request.frameIntervalMs < 60 || request.frameIntervalMs > 500) throw new Error('稳定判定窗口必须在 60 到 500 毫秒之间')
  if (!Number.isInteger(request.scrollIntervalMs) || request.scrollIntervalMs < 120 || request.scrollIntervalMs > 2000) throw new Error('滚动节流间隔必须在 120 到 2000 毫秒之间')
  if (request.scrollIntervalMs < request.frameIntervalMs * 2) throw new Error('滚动节流间隔至少应为稳定判定窗口的 2 倍')
  if (!Number.isInteger(request.maxFrames) || request.maxFrames < 20 || request.maxFrames > 20_000) throw new Error('最大采样帧数必须在 20 到 20000 之间')
}

function cropToPixels(crop: WechatContinuousCaptureRequest['crop'], width: number, height: number): { left: number; top: number; width: number; height: number } {
  const left = Math.round(width * crop.left / 100)
  const top = Math.round(height * crop.top / 100)
  const right = Math.round(width * crop.right / 100)
  const bottom = Math.round(height * crop.bottom / 100)
  return { left, top, width: width - left - right, height: height - top - bottom }
}

function clampInt(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.round(value)))
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

class CaptureCancelledError extends Error {
  constructor() {
    super('截图任务已取消')
    this.name = 'CaptureCancelledError'
  }
}
