import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { WechatCaptureCrop, WechatVoiceConversionStats } from '../../shared/wechat-capture'
import { scrollChatToTop } from './wechat-scroll-controller'
import { WechatVoiceController } from './wechat-voice-controller'
import { preprocessWechatVoices, type VoiceScanFrame } from './wechat-voice-preprocessor'
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

/** 完成整段转写后才允许开始拼接，隔离展开文字造成的布局变化。 */
export class WechatVoicePreparation<T extends VoiceScanFrame> {
  private controller: WechatVoiceController | null = null
  private cancelled = false
  private stats: WechatVoiceConversionStats = { scannedPages: 0, converted: 0, alreadyConverted: 0, failed: 0 }

  constructor(private readonly options: VoicePreparationOptions<T>) {}

  async prepare(): Promise<WechatVoiceConversionStats | null> {
    const { options } = this
    const isCancelled = (): boolean => this.cancelled || options.isCancelled()
    let status: 'complete' | 'stopped' | 'error' = 'error'
    let failure: string | undefined
    let passes = 0
    try {
      if (isCancelled()) { status = 'stopped'; return null }
      this.controller = WechatVoiceController.start(options.sourceId, options.crop)
      await this.controller.validate({ isCancelled })
      // 微信可能固定聊天底部，展开下方消息时把上方未处理语音推离视口。
      // 重新从顶部确认，直到整轮没有新增转写，避免只向下遍历造成漏转。
      for (passes = 1; passes <= 8; passes += 1) {
        const passBaseline = { ...this.stats }
        options.onProgress(`语音预处理第 ${passes} 轮：正在定位聊天顶部…`, this.stats)
        const top = await scrollChatToTop({
          controller: { scroll: options.scroll }, capture: options.capture, isCancelled,
          onProgress: (burst) => options.onProgress(`语音预处理：正在定位顶部（第 ${burst + 1} 次翻页）…`, this.stats)
        })
        if (!top || isCancelled()) { status = 'stopped'; return null }
        const result = await options.log.measure('voice.preprocess', () => preprocessWechatVoices({
          capture: options.capture,
          scroll: options.scroll,
          isCancelled,
          convertVisible: async () => {
            const baseline = { ...this.stats }
            return this.controller!.convertVisible({
              isCancelled,
              onProgress: (progress) => {
                const current = {
                  ...baseline,
                  converted: baseline.converted + progress.converted,
                  alreadyConverted: baseline.alreadyConverted + progress.alreadyConverted,
                  failed: baseline.failed + progress.failed
                }
                this.stats = current
                options.onProgress(`正在展开语音文字：本屏已转写 ${progress.converted} 条，请保持微信窗口可见…`, current)
              }
            })
          },
          onProgress: (stats) => {
            this.stats = addStats(passBaseline, stats)
            options.onProgress(`语音预处理第 ${passes} 轮：已扫描 ${this.stats.scannedPages} 屏，转写 ${this.stats.converted} 条…`, this.stats)
          }
        }), { pass: passes })
        if (!result || isCancelled()) { status = 'stopped'; return null }
        this.stats = addStats(passBaseline, result)
        if (result.converted > 0) continue
        status = 'complete'
        options.onProgress(`语音预处理完成，已转写 ${this.stats.converted} 条；正在回到顶部生成长图…`, this.stats)
        return this.stats
      }
      throw new Error('多轮检查后仍有新增语音转写，已停止截图；请等待聊天内容稳定后重试')
    } catch (error) {
      if (isCancelled()) { status = 'stopped'; return null }
      failure = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      let cleanupFailure: Error | undefined
      try {
        await this.controller?.stop()
      } catch (error) {
        cleanupFailure = error instanceof Error ? error : new Error(String(error))
        options.log.record('voice.cleanup_failed', undefined, { error: cleanupFailure.message })
        if (status === 'complete') status = 'error'
      }
      this.controller = null
      // 只记录数量与故障，不额外保存聊天文字或桌面截图。
      try {
        await writeFile(join(options.outputDirectory, 'voice-conversion-report.json'), JSON.stringify({
          status, passes: Math.min(passes, 8), ...this.stats,
          error: failure ?? cleanupFailure?.message, finishedAt: new Date().toISOString()
        }, null, 2), 'utf8')
      } catch (error) {
        cleanupFailure ??= error instanceof Error ? error : new Error(String(error))
        if (status === 'complete') status = 'error'
        options.log.record('voice.report_failed', undefined, { error: String(error) })
      }
      options.log.record('voice.finished', undefined, { status, ...this.stats, error: failure ?? cleanupFailure?.message })
      if (!failure && status !== 'stopped' && cleanupFailure) throw cleanupFailure
    }
  }

  async stop(): Promise<void> {
    this.cancelled = true
    await this.controller?.stop()
  }
}

function addStats(first: WechatVoiceConversionStats, second: WechatVoiceConversionStats): WechatVoiceConversionStats {
  return {
    scannedPages: first.scannedPages + second.scannedPages,
    converted: first.converted + second.converted,
    alreadyConverted: first.alreadyConverted + second.alreadyConverted,
    failed: first.failed + second.failed
  }
}
