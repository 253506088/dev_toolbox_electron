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
export const CONTINUOUS_MAX_SHIFT_RATIO = 0.62

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
  if (shift > frameHeight * CONTINUOUS_MAX_SHIFT_RATIO) return { kind: 'reject', overlap, shift }
  return { kind: 'append', overlap, shift }
}

/**
 * 依据预期位移收窄重叠搜索范围，降低误匹配并加快搜索。
 * 预期无效或窗口退化时返回 null，调用方应回退全范围搜索。
 */
export function continuousOverlapSearchWindow(
  frameHeight: number,
  expectedShift: number,
  marginPx?: number
): { minimumRatio: number; maximumRatio: number } | null {
  if (!Number.isFinite(frameHeight) || frameHeight < 8) return null
  if (!Number.isFinite(expectedShift) || expectedShift <= 0 || expectedShift >= frameHeight) return null
  const margin = marginPx ?? Math.max(60, Math.round(frameHeight * 0.1))
  const minimumRatio = Math.max(0.05, (frameHeight - expectedShift - margin) / frameHeight)
  const maximumRatio = Math.min(0.995, (frameHeight - expectedShift + margin) / frameHeight)
  if (maximumRatio - minimumRatio < 0.02) return null
  return { minimumRatio, maximumRatio }
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

/**
 * 标记灰度长图中接近纯聊天背景的“空白行”（消息之间的间隙）。
 * 空白行需同时满足：整行像素近似均匀，且行均值接近估算出的背景亮度，
 * 避免把纯色大图内部的均匀行误判为可切割的间隙。
 */
export function computeBlankRows(gray: ArrayLike<number>, width: number, height: number, tolerance = 10): Uint8Array {
  const flags = new Uint8Array(height)
  if (width < 1 || height < 1 || gray.length !== width * height) return flags
  const means = new Float64Array(height)
  const uniformMeans: number[] = []
  for (let row = 0; row < height; row += 1) {
    const offset = row * width
    let min = 255
    let max = 0
    let sum = 0
    for (let column = 0; column < width; column += 1) {
      const value = gray[offset + column]
      if (value < min) min = value
      if (value > max) max = value
      sum += value
    }
    means[row] = sum / width
    if (max - min <= tolerance) {
      flags[row] = 1
      uniformMeans.push(means[row])
    }
  }
  if (uniformMeans.length === 0) return flags
  uniformMeans.sort((first, second) => first - second)
  const background = uniformMeans[Math.floor(uniformMeans.length / 2)]
  for (let row = 0; row < height; row += 1) {
    if (flags[row] === 1 && Math.abs(means[row] - background) > tolerance * 1.5) flags[row] = 0
  }
  return flags
}

/** 长图分屏切片：top 为长图内起始行，height 为切片高度。 */
export interface ScreenSlice {
  top: number
  height: number
}

/**
 * 依据空白行为长图规划分屏切点：优先在目标高度附近的空白行（消息间隙）中间下刀；
 * 附近没有空白行时按固定高度切割，并让下一屏向上重叠一段，保证消息不因截断而丢失。
 */
export function planScreenSlices(
  blankRows: ArrayLike<number | boolean>,
  viewportHeight: number,
  searchRatio = 0.15,
  overlapPx = 48
): ScreenSlice[] {
  const total = blankRows.length
  if (total <= 0) return []
  if (!Number.isFinite(viewportHeight) || viewportHeight < 8) return [{ top: 0, height: total }]
  const searchWindow = Math.max(1, Math.round(viewportHeight * searchRatio))
  const overlap = Math.max(0, Math.min(Math.round(overlapPx), Math.floor(viewportHeight / 3)))
  const slices: ScreenSlice[] = []
  let top = 0
  while (total - top > Math.round(viewportHeight * 1.1)) {
    const target = top + viewportHeight
    const cut = findBlankCutNear(blankRows, target, searchWindow, top + Math.floor(viewportHeight / 2), total - 1)
    if (cut !== null) {
      slices.push({ top, height: cut - top })
      top = cut
    } else {
      slices.push({ top, height: viewportHeight })
      top = target - overlap
    }
  }
  slices.push({ top, height: total - top })
  const last = slices[slices.length - 1]
  if (slices.length > 1 && last.height < 16) {
    slices.pop()
    const previous = slices[slices.length - 1]
    previous.height = total - previous.top
  }
  return slices
}

/** 在目标行附近寻找距离最近的空白行，并返回其所在空白段的中点。 */
function findBlankCutNear(
  blankRows: ArrayLike<number | boolean>,
  target: number,
  searchWindow: number,
  lowerBound: number,
  upperBound: number
): number | null {
  const low = Math.max(lowerBound, target - searchWindow)
  const high = Math.min(upperBound, target + searchWindow)
  for (let distance = 0; distance <= searchWindow; distance += 1) {
    for (const row of distance === 0 ? [target] : [target - distance, target + distance]) {
      if (row < low || row > high || !blankRows[row]) continue
      let start = row
      let end = row
      while (start - 1 >= low && blankRows[start - 1]) start -= 1
      while (end + 1 <= high && blankRows[end + 1]) end += 1
      return Math.floor((start + end + 1) / 2)
    }
  }
  return null
}
