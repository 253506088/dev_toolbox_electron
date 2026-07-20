import type { ImageMattingOptions, RgbColor } from './media-api'

/** 原始 RGBA 图片数据。 */
export interface RgbaImage {
  width: number
  height: number
  data: Uint8Array
}

interface ColorBin {
  count: number
  sumR: number
  sumG: number
  sumB: number
}

/** 把数字限制在闭区间内。 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 计算一个像素与背景色的 RGB 绝对差总和。 */
export function colorDiff(r: number, g: number, b: number, background: RgbColor): number {
  return Math.abs(r - background.r) + Math.abs(g - background.g) + Math.abs(b - background.b)
}

/** 从图片边缘环带的主颜色箱估算背景色。 */
export function detectBackgroundColor(image: RgbaImage): RgbColor {
  const { width, height, data } = image
  const ring = Math.max(1, Math.floor(Math.min(width, height) / 50))
  const bins = new Map<number, ColorBin>()

  /** 把一个边缘像素加入 4 位颜色量化桶。 */
  function sample(x: number, y: number): void {
    const index = (y * width + x) * 4
    const r = data[index]
    const g = data[index + 1]
    const b = data[index + 2]
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
    const bin = bins.get(key) ?? { count: 0, sumR: 0, sumG: 0, sumB: 0 }
    bin.count += 1
    bin.sumR += r
    bin.sumG += g
    bin.sumB += b
    bins.set(key, bin)
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x < ring || x >= width - ring || y < ring || y >= height - ring) sample(x, y)
    }
  }

  let dominant: ColorBin | undefined
  for (const bin of bins.values()) {
    if (!dominant || bin.count > dominant.count) dominant = bin
  }
  if (!dominant || dominant.count <= 0) return { r: 255, g: 255, b: 255 }
  return {
    r: clamp(Math.round(dominant.sumR / dominant.count), 0, 255),
    g: clamp(Math.round(dominant.sumG / dominant.count), 0, 255),
    b: clamp(Math.round(dominant.sumB / dominant.count), 0, 255)
  }
}

/** 按原版边缘泛洪与羽化规则生成透明 RGBA 图片。 */
export function matteRgbaImage(image: RgbaImage, options: ImageMattingOptions): RgbaImage & { background: RgbColor } {
  const { width, height, data } = image
  if (width <= 0 || height <= 0 || data.length !== width * height * 4) throw new Error('RGBA 图片尺寸无效')

  const background = options.background ?? detectBackgroundColor(image)
  const borderDiffs: number[] = []

  /** 收集一个边缘像素与背景色的差异。 */
  function collect(x: number, y: number): void {
    const offset = (y * width + x) * 4
    borderDiffs.push(colorDiff(data[offset], data[offset + 1], data[offset + 2], background))
  }

  for (let x = 0; x < width; x += 1) {
    collect(x, 0)
    if (height > 1) collect(x, height - 1)
  }
  for (let y = 1; y < height - 1; y += 1) {
    collect(0, y)
    if (width > 1) collect(width - 1, y)
  }

  borderDiffs.sort((left, right) => left - right)
  const p80Index = clamp(Math.floor(borderDiffs.length * 0.8), 0, borderDiffs.length - 1)
  const p80 = borderDiffs[p80Index] ?? 0
  const baseThreshold = clamp(p80 + Math.round(options.thresholdOffset), 15, 230)
  const floodThreshold = clamp(baseThreshold + 8, 20, 255)
  const feather = clamp(Math.round(options.feather), 0, 80)
  const low = clamp(baseThreshold - feather, 0, 255)
  const high = clamp(baseThreshold + feather, 1, 255)
  const visited = new Uint8Array(width * height)
  const backgroundMask = new Uint8Array(width * height)
  const queue = new Int32Array(width * height)
  let queueStart = 0
  let queueEnd = 0

  /** 尝试把与背景相近且尚未访问的像素加入泛洪队列。 */
  function tryPush(x: number, y: number): void {
    if (x < 0 || x >= width || y < 0 || y >= height) return
    const pixelIndex = y * width + x
    if (visited[pixelIndex] === 1) return
    visited[pixelIndex] = 1
    const offset = pixelIndex * 4
    if (colorDiff(data[offset], data[offset + 1], data[offset + 2], background) <= floodThreshold) {
      backgroundMask[pixelIndex] = 1
      queue[queueEnd] = pixelIndex
      queueEnd += 1
    }
  }

  for (let x = 0; x < width; x += 1) {
    tryPush(x, 0)
    tryPush(x, height - 1)
  }
  for (let y = 0; y < height; y += 1) {
    tryPush(0, y)
    tryPush(width - 1, y)
  }

  while (queueStart < queueEnd) {
    const pixelIndex = queue[queueStart]
    queueStart += 1
    const x = pixelIndex % width
    const y = Math.floor(pixelIndex / width)
    tryPush(x - 1, y)
    tryPush(x + 1, y)
    tryPush(x, y - 1)
    tryPush(x, y + 1)
  }

  const output = new Uint8Array(data)
  for (let pixelIndex = 0; pixelIndex < width * height; pixelIndex += 1) {
    if (backgroundMask[pixelIndex] !== 1) continue
    const offset = pixelIndex * 4
    const sourceAlpha = data[offset + 3]
    const difference = colorDiff(data[offset], data[offset + 1], data[offset + 2], background)
    if (feather <= 0 || difference <= low) {
      output[offset + 3] = difference <= baseThreshold ? 0 : sourceAlpha
    } else if (difference >= high) {
      output[offset + 3] = sourceAlpha
    } else {
      output[offset + 3] = clamp(Math.round(((difference - low) / (high - low)) * sourceAlpha), 0, 255)
    }
  }

  return { width, height, data: output, background }
}
