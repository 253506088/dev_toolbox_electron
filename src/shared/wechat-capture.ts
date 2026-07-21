/** 可供微信截图工具选择的桌面窗口。 */
export interface WechatWindowSource {
  id: string
  name: string
  thumbnailDataUrl: string
  width: number
  height: number
}

/** 以窗口尺寸百分比表示的截图区域。 */
export interface WechatCaptureCrop {
  left: number
  top: number
  right: number
  bottom: number
}

/** 启动一次微信聊天记录抓取所需的参数。 */
export interface WechatCaptureRequest {
  sourceId: string
  sourceName: string
  outputDirectory: string
  crop: WechatCaptureCrop
  scrollStep: number
  settleDelayMs: number
  maxScreens: number
}

/** 连续长截图节点使用的采样和滚动参数。 */
export interface WechatContinuousCaptureRequest {
  sourceId: string
  sourceName: string
  outputDirectory: string
  crop: WechatCaptureCrop
  frameIntervalMs: number
  scrollIntervalMs: number
  maxFrames: number
}

export type WechatCaptureMode = 'paged' | 'continuous'

export type WechatCaptureStage = 'positioning' | 'capturing' | 'stitching' | 'complete' | 'stopped' | 'error'

/** 主进程向工具页推送的抓取进度。 */
export interface WechatCaptureEvent {
  runId: string
  mode?: WechatCaptureMode
  stage: WechatCaptureStage
  message: string
  screenCount: number
  capturedHeight?: number
  outputDirectory?: string
  markdownPath?: string
  previewDataUrl?: string
}

/** 启动抓取后的初始状态。 */
export interface WechatCaptureStartResult {
  runId: string
  outputDirectory: string
}

export const MAX_ACCEPTED_OVERLAP_DIFFERENCE = 0.012
export const MAX_CONTINUOUS_OVERLAP_DIFFERENCE = 0.025
export const CONTINUOUS_SAFE_BOTTOM_RATIO = 0.7

/** 计算连续帧中避开底部固定悬浮控件的安全条带。 */
export function continuousSafeStripRegion(frameHeight: number, shift: number): { top: number; height: number; safeBottom: number } {
  const safeBottom = Math.max(1, Math.floor(frameHeight * CONTINUOUS_SAFE_BOTTOM_RATIO))
  if (shift < 1 || shift > safeBottom) throw new Error('连续帧位移超出安全条带范围')
  return { top: safeBottom - shift, height: shift, safeBottom }
}

/** 根据实际重叠率决定继续滚动、保存当前画面或按不可靠匹配处理。 */
export function classifyCaptureOverlap(overlap: number, frameHeight: number): 'continue' | 'save' | 'unsafe' {
  if (frameHeight < 1 || overlap / frameHeight < 0.1) return 'unsafe'
  return overlap / frameHeight > 0.25 ? 'continue' : 'save'
}

/** 连续采集只接受相邻帧中较小且可靠的向下新增区域。 */
export function continuousFrameDecision(
  match: { overlap: number; score: number },
  frameHeight: number,
  fingerprintHeight: number
): { kind: 'append' | 'stationary' | 'reject'; overlap: number; shift: number } {
  const overlap = acceptedOverlapHeight(match, frameHeight, fingerprintHeight, MAX_CONTINUOUS_OVERLAP_DIFFERENCE)
  if (overlap === 0) return { kind: 'reject', overlap: 0, shift: 0 }
  const shift = frameHeight - overlap
  if (shift <= Math.max(3, Math.round(frameHeight * 0.008))) return { kind: 'stationary', overlap, shift }
  if (shift > frameHeight * 0.55) return { kind: 'reject', overlap, shift }
  return { kind: 'append', overlap, shift }
}

/** 只把高置信度匹配换算成原图裁切高度；可疑匹配一律保留完整画面。 */
export function acceptedOverlapHeight(
  match: { overlap: number; score: number },
  sourceHeight: number,
  fingerprintHeight: number,
  maximumScore = MAX_ACCEPTED_OVERLAP_DIFFERENCE
): number {
  if (match.score > maximumScore || fingerprintHeight < 1 || sourceHeight < 1) return 0
  return Math.max(0, Math.min(sourceHeight - 1, Math.round(match.overlap / fingerprintHeight * sourceHeight)))
}

/** 计算两个等尺寸灰度图的平均绝对差，结果范围为 0 到 1。 */
export function normalizedImageDifference(first: Uint8Array, second: Uint8Array): number {
  if (first.length !== second.length || first.length === 0) return 1
  let difference = 0
  for (let index = 0; index < first.length; index += 1) difference += Math.abs(first[index] - second[index])
  return difference / (first.length * 255)
}

/**
 * 在两张灰度缩略图中查找“上一张底部 == 下一张顶部”的最佳垂直重叠。
 * 返回值是缩略图像素高度，调用方可按比例换算回原图。
 */
export function findVerticalOverlap(
  previous: Uint8Array,
  next: Uint8Array,
  width: number,
  height: number,
  minimumRatio = 0.04,
  maximumRatio = 0.97
): { overlap: number; score: number } {
  if (width < 1 || height < 2 || previous.length !== width * height || next.length !== previous.length) {
    return { overlap: 0, score: 1 }
  }
  const minimum = Math.max(1, Math.floor(height * minimumRatio))
  const maximum = Math.min(height - 1, Math.ceil(height * maximumRatio))
  let bestOverlap = 0
  let bestScore = Number.POSITIVE_INFINITY

  for (let overlap = minimum; overlap <= maximum; overlap += 1) {
    const rowStep = Math.max(1, Math.floor(overlap / 48))
    const columnStep = Math.max(1, Math.floor(width / 96))
    let difference = 0
    let samples = 0
    for (let row = 0; row < overlap; row += rowStep) {
      const previousOffset = (height - overlap + row) * width
      const nextOffset = row * width
      for (let column = 0; column < width; column += columnStep) {
        difference += Math.abs(previous[previousOffset + column] - next[nextOffset + column])
        samples += 1
      }
    }
    const score = samples === 0 ? 1 : difference / (samples * 255)
    if (score < bestScore) {
      bestScore = score
      bestOverlap = overlap
    }
  }
  return { overlap: bestOverlap, score: bestScore }
}
