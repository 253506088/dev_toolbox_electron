import {
  findVerticalOverlap,
  MAX_ACCEPTED_OVERLAP_DIFFERENCE,
  normalizedImageDifference,
  type WechatVoiceConversionStats
} from '../../shared/wechat-capture'

const STILL_DIFFERENCE = 0.0035
const BOTTOM_CONFIRMATIONS = 3
const DEFAULT_MAX_PAGES = 5000

export interface VoiceScanFrame {
  fingerprint: Uint8Array
  width: number
  height: number
  fingerprintWidth: number
  fingerprintHeight: number
}

export interface WechatVoicePreprocessorOptions<T extends VoiceScanFrame> {
  capture: () => Promise<T>
  scroll: (notches: number) => Promise<void>
  /** 本次可见区域的处理结果；实现方应在每条语音展开后重新定位其余语音。 */
  convertVisible: () => Promise<Pick<WechatVoiceConversionStats, 'converted' | 'alreadyConverted' | 'failed'>>
  isCancelled: () => boolean
  onProgress?: (stats: WechatVoiceConversionStats) => void
  maxPages?: number
  settle?: () => Promise<{ frame: T; still: boolean }>
}

/**
 * 独立的转写预处理遍历。调用前由采集服务定位顶部，成功后再回顶开始截图。
 * 转写会改变消息高度，因此只比较「转写完成后的帧」与随后纯滚动产生的帧；
 * 任何未确认完成的转写或不可靠的位移都会中止，避免输出缺失文字的长图。
 */
export async function preprocessWechatVoices<T extends VoiceScanFrame>(
  options: WechatVoicePreprocessorOptions<T>
): Promise<WechatVoiceConversionStats | null> {
  if (options.isCancelled()) return null
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new Error('语音预处理最大扫描页数必须为正整数')
  const stats: WechatVoiceConversionStats = { scannedPages: 0, converted: 0, alreadyConverted: 0, failed: 0 }

  try {
    let frame = await settledFrame(options)
    if (options.isCancelled()) return null
    let needsScan = true
    let stationaryCount = 0

    while (!options.isCancelled()) {
      if (needsScan) {
        if (stats.scannedPages >= maxPages) {
          throw new Error(`语音预处理已达到 ${maxPages} 页扫描上限，尚未确认聊天底部；本次未生成截图，请减少待处理记录后重试`)
        }
        const result = await options.convertVisible()
        if (options.isCancelled()) return null
        for (const count of [result.converted, result.alreadyConverted, result.failed]) {
          if (!Number.isSafeInteger(count) || count < 0) throw new Error('语音转写控制器返回了无效统计')
        }
        stats.scannedPages += 1
        stats.converted += result.converted
        // 相邻视口存在重叠，该值表示已展开语音的观察次数，不用于消息去重。
        stats.alreadyConverted += result.alreadyConverted
        stats.failed += result.failed
        options.onProgress?.({ ...stats })
        if (options.isCancelled()) return null
        if (result.failed > 0) {
          throw new Error(`有 ${stats.failed} 条语音未能确认转写完成，已停止截图；请在微信中处理后重试`)
        }

        const convertedFrame = await settledFrame(options)
        if (options.isCancelled()) return null
        assertSameDimensions(frame, convertedFrame)
        // 这里不能做重叠匹配：转写产生的重新排版是预期行为。
        frame = convertedFrame
        needsScan = false
      }

      if (options.isCancelled()) return null
      await options.scroll(-1)
      if (options.isCancelled()) return null
      const next = await settledFrame(options)
      if (options.isCancelled()) return null
      assertSameDimensions(frame, next)

      if (normalizedImageDifference(frame.fingerprint, next.fingerprint) < STILL_DIFFERENCE) {
        stationaryCount += 1
        frame = next
        // 静止确认期间不重复右击同一视口，也不重复累计转写统计。
        if (stationaryCount >= BOTTOM_CONFIRMATIONS) return { ...stats }
        continue
      }

      const overlap = findVerticalOverlap(
        frame.fingerprint, next.fingerprint, frame.fingerprintWidth, frame.fingerprintHeight, 0.5, 0.995
      )
      if (overlap.overlap < Math.ceil(frame.fingerprintHeight * 0.5) || overlap.score > MAX_ACCEPTED_OVERLAP_DIFFERENCE) {
        throw new Error('语音预处理滚动后无法确认连续内容，已停止以避免漏掉语音；请检查聊天区域和窗口大小后重试')
      }
      stationaryCount = 0
      frame = next
      needsScan = true
    }
    return null
  } catch (error) {
    // 停止操作可能关闭正在工作的原生控制器；其退出异常属于取消。
    if (options.isCancelled()) return null
    throw error
  }
}

async function settledFrame<T extends VoiceScanFrame>(options: WechatVoicePreprocessorOptions<T>): Promise<T> {
  if (options.settle) {
    const result = await options.settle()
    if (options.isCancelled()) return result.frame
    assertFrame(result.frame)
    if (!result.still) throw new Error('语音预处理等待画面稳定超时，已停止截图；请等待微信转写完成后重试')
    return result.frame
  }

  let frame = await options.capture()
  if (options.isCancelled()) return frame
  assertFrame(frame)
  const deadline = Date.now() + 2200
  let quietSamples = 0
  while (!options.isCancelled() && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 90))
    if (options.isCancelled()) return frame
    const next = await options.capture()
    if (options.isCancelled()) return next
    assertFrame(next)
    assertSameDimensions(frame, next)
    quietSamples = normalizedImageDifference(frame.fingerprint, next.fingerprint) < STILL_DIFFERENCE
      ? quietSamples + 1
      : 0
    frame = next
    if (quietSamples >= 2) return frame
  }
  if (options.isCancelled()) return frame
  throw new Error('语音预处理等待画面稳定超时，已停止截图；请等待微信转写完成后重试')
}

function assertFrame(frame: VoiceScanFrame): void {
  if (![frame.width, frame.height, frame.fingerprintWidth, frame.fingerprintHeight].every((size) => Number.isSafeInteger(size) && size > 0) ||
    frame.fingerprintHeight < 2 || frame.fingerprint.length !== frame.fingerprintWidth * frame.fingerprintHeight) {
    throw new Error('语音预处理无法读取有效的聊天画面')
  }
}

function assertSameDimensions(first: VoiceScanFrame, second: VoiceScanFrame): void {
  if (first.width !== second.width || first.height !== second.height ||
    first.fingerprintWidth !== second.fingerprintWidth || first.fingerprintHeight !== second.fingerprintHeight) {
    throw new Error('语音预处理期间窗口尺寸发生变化，已停止截图；请固定窗口大小后重试')
  }
}
