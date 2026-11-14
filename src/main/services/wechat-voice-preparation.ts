import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizedImageDifference, type WechatCaptureCrop, type WechatVoiceConversionStats } from '../../shared/wechat-capture'
import { waitForStillFrame } from './wechat-scroll-controller'
import { WechatVoiceController } from './wechat-voice-controller'
import { createVoiceViewportAnchor, locateVoiceViewportAnchor, type VoiceViewportAnchor, type VoiceScanFrame } from './wechat-voice-viewport'
import type { CaptureTimingLog } from './capture-timing-log'

interface VoicePreparationOptions<T extends VoiceScanFrame> {
  sourceId: string
  crop: WechatCaptureCrop
  outputDirectory: string
  capture: () => Promise<T>
  scroll: (notches: number) => Promise<void>
  isCancelled: () => boolean
  onProgress: (message: string, stats: WechatVoiceConversionStats) => void
  log: CaptureTimingLog
}

/** 一个截图任务复用一个控制器；每屏检查、展开、判稳后立即交给采集器。 */
export class WechatVoicePreparation<T extends VoiceScanFrame> {
  private controller: WechatVoiceController | null = null
  private cancelled = false
  private lastPrepared: T | null = null
  private finishPromise: Promise<void> | null = null
  private viewportTopInset = 0
  private stats: WechatVoiceConversionStats = { scannedPages: 0, converted: 0, alreadyConverted: 0, failed: 0 }

  constructor(private readonly options: VoicePreparationOptions<T>) {}

  /** 局部回滚多露出的顶部像素；首屏输出裁掉它们以保留用户选择的精确起点。 */
  get topInset(): number { return this.viewportTopInset }

  /** 只处理传入画面所在的当前视口，不执行整段聊天扫描或回顶。 */
  async prepare(frame: T): Promise<T | null> {
    const { options } = this
    if (this.isCancelled()) return null
    if (this.lastPrepared) this.assertDimensions(this.lastPrepared, frame)
    if (this.lastPrepared && normalizedImageDifference(this.lastPrepared.fingerprint, frame.fingerprint) < 0.0001) return frame
    let anchor: VoiceViewportAnchor | null = null
    let beforeAnchorRow = 0
    let logicalHeight = frame.height
    let recoveries = 0
    const baseline = { ...this.stats, scannedPages: this.stats.scannedPages + 1 }
    const publish = (message: string): void => options.onProgress(message, { ...this.stats })
    try {
      if (!this.controller) {
        this.controller = WechatVoiceController.start(options.sourceId, options.crop)
        await this.controller.validate({ isCancelled: () => this.isCancelled() })
      }
      this.stats = baseline
      publish(`正在检查第 ${this.stats.scannedPages} 屏语音，处理完成后立即截图…`)
      const result = await options.log.measure('voice.prepare_viewport', () => this.controller!.convertVisible({
        isCancelled: () => this.isCancelled(),
        beforeConvert: async (candidate, viewport) => {
          if (this.isCancelled()) return
          const clean = await options.capture()
          this.assertDimensions(frame, clean)
          const limit = (candidate.y + candidate.height - viewport.y) / viewport.height
          anchor ??= createVoiceViewportAnchor(clean, limit)
          const location = anchor ? locateVoiceViewportAnchor(anchor, clean) : null
          if (anchor && location === null) throw new Error('本屏起点在语音检查期间发生变化，已停止以避免遗漏内容')
          beforeAnchorRow = location ?? 0
          logicalHeight = viewport.height
        },
        restoreViewport: async () => {
          if (!anchor || this.isCancelled()) return
          let current = await options.capture()
          this.assertDimensions(frame, current)
          for (let step = 0; step < 40 && !this.isCancelled(); step += 1) {
            const location = locateVoiceViewportAnchor(anchor, current)
            if (location !== null && location >= anchor.row - 1) {
              return (location - beforeAnchorRow) / frame.fingerprintHeight * logicalHeight
            }
            if (recoveries++ >= 80) throw new Error('本屏语音展开后反复移动，已停止以避免遗漏内容')
            publish('语音文字已展开，正在恢复本屏起点后继续截图…')
            await options.scroll(1)
            const next = await this.settle(frame)
            if (normalizedImageDifference(current.fingerprint, next.fingerprint) < 0.0001) {
              throw new Error('语音展开后无法恢复本屏起点，已停止并保留已截图内容')
            }
            current = next
          }
          if (!this.isCancelled()) throw new Error('语音展开后超出本屏恢复范围，已停止并保留已截图内容')
        },
        onProgress: (progress) => {
          this.stats = {
            scannedPages: baseline.scannedPages,
            converted: baseline.converted + progress.converted,
            alreadyConverted: baseline.alreadyConverted + progress.alreadyConverted,
            failed: baseline.failed + progress.failed
          }
          publish(`正在处理本屏语音：本屏已转写 ${progress.converted} 条，累计 ${this.stats.converted} 条…`)
        }
      }), { page: baseline.scannedPages })
      if (this.isCancelled()) return null
      for (const count of [result.converted, result.alreadyConverted, result.failed]) {
        if (!Number.isSafeInteger(count) || count < 0) throw new Error('语音转写控制器返回了无效统计')
      }
      this.stats = { scannedPages: baseline.scannedPages, converted: baseline.converted + result.converted,
        alreadyConverted: baseline.alreadyConverted + result.alreadyConverted, failed: baseline.failed + result.failed }
      if (result.failed > 0) throw new Error(`本屏有 ${result.failed} 条语音未确认转写完成，已停止并保留已截图内容`)
      const prepared = await this.settle(frame)
      if (this.isCancelled()) return null
      const finalAnchor = anchor as VoiceViewportAnchor | null
      const finalRow = finalAnchor ? locateVoiceViewportAnchor(finalAnchor, prepared) : null
      // The final settle can observe a delayed scroll/resize animation after the native
      // helper's last snapshot. Never silently drop the saved start by treating a lost
      // anchor as a zero inset and handing a different viewport to the capture service.
      if (finalAnchor && (finalRow === null || finalRow < finalAnchor.row - 1)) {
        throw new Error('语音处理后本屏起点再次移动，已停止以避免遗漏内容')
      }
      this.viewportTopInset = finalAnchor && finalRow !== null
        ? Math.max(0, Math.round((finalRow - finalAnchor.row) / frame.fingerprintHeight * frame.height)) : 0
      this.lastPrepared = prepared
      publish('本屏语音检查完成，正在截图…')
      return prepared
    } catch (error) {
      if (this.isCancelled()) return null
      throw error
    }
  }

  async stop(): Promise<void> {
    this.cancelled = true
    await this.controller?.stop()
  }

  finish(status: 'complete' | 'stopped' | 'error', failure?: string): Promise<void> {
    this.finishPromise ??= this.finishOnce(status, failure)
    return this.finishPromise
  }

  private async finishOnce(status: 'complete' | 'stopped' | 'error', failure?: string): Promise<void> {
    let cleanupFailure: Error | undefined
    try { await this.controller?.stop() } catch (error) {
      cleanupFailure = error instanceof Error ? error : new Error(String(error))
      this.options.log.record('voice.cleanup_failed', undefined, { error: cleanupFailure.message })
    }
    this.controller = null
    const result = { mode: 'per-viewport', status: cleanupFailure && status === 'complete' ? 'error' : status, ...this.stats,
      error: failure ?? cleanupFailure?.message, finishedAt: new Date().toISOString() }
    try {
      await writeFile(join(this.options.outputDirectory, 'voice-conversion-report.json'), JSON.stringify(result, null, 2), 'utf8')
    } catch (error) {
      cleanupFailure ??= error instanceof Error ? error : new Error(String(error))
      result.status = 'error'
      result.error ??= cleanupFailure.message
      this.options.log.record('voice.report_failed', undefined, { error: String(error) })
    }
    this.options.log.record('voice.finished', undefined, result)
    if (cleanupFailure && !failure && status !== 'stopped') throw cleanupFailure
  }

  private isCancelled(): boolean { return this.cancelled || this.options.isCancelled() }

  private async settle(reference: T): Promise<T> {
    const settled = await waitForStillFrame(this.options.capture, () => this.isCancelled(), { pollDelayMs: 100, timeoutMs: 3000 })
    if (this.isCancelled()) return settled.frame
    this.assertDimensions(reference, settled.frame)
    if (!settled.still) throw new Error('语音处理后画面仍在变化，已停止并保留已截图内容')
    return settled.frame
  }

  private assertDimensions(first: T, second: T): void {
    if (first.width !== second.width || first.height !== second.height || first.fingerprintWidth !== second.fingerprintWidth ||
      first.fingerprintHeight !== second.fingerprintHeight) throw new Error('语音处理期间窗口尺寸发生变化，请固定窗口大小后重试')
  }
}
