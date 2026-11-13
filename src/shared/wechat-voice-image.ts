export interface VoiceBubbleRegion {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Locate short, mostly flat chat bubbles for a second, enlarged OCR pass. Whole-page
 * Windows OCR often omits the isolated 3″ label even when it recognizes nearby text.
 * These are only OCR regions: a rectangle never establishes that a message is a voice.
 * Returned coordinates always refer to the original image, including high-DPI captures.
 */
export function findVoiceBubbleRegions(
  pixels: Uint8Array,
  width: number,
  height: number,
  channels: 3 | 4 = 3
): VoiceBubbleRegion[] {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
    (channels !== 3 && channels !== 4) || pixels.length !== width * height * channels) return []

  // Bound connected-component memory and work without assuming a Windows DPI setting.
  const step = Math.max(1, Math.ceil(Math.max(width, height) / 1400))
  const sampledWidth = Math.ceil(width / step)
  const sampledHeight = Math.ceil(height / step)
  const colors = new Int32Array(sampledWidth * sampledHeight)
  colors.fill(-1)
  for (let y = 0; y < sampledHeight; y += 1) {
    for (let x = 0; x < sampledWidth; x += 1) {
      const offset = (Math.min(height - 1, y * step) * width + Math.min(width - 1, x * step)) * channels
      const r = pixels[offset]
      const g = pixels[offset + 1]
      const b = pixels[offset + 2]
      const neutral = Math.max(r, g, b) - Math.min(r, g, b) <= 22
      const wechatGreen = g >= 65 && g > r * 1.06 && g > b * 1.12 && r > b * 0.75
      if ((!neutral && !wechatGreen) || Math.max(r, g, b) < 16 || (channels === 4 && pixels[offset + 3] < 220)) continue
      // Four-level bins preserve the distinction between white bubbles and pale backgrounds.
      colors[y * sampledWidth + x] = (r >> 2) * 4096 + (g >> 2) * 64 + (b >> 2)
    }
  }

  const queue = new Int32Array(colors.length)
  const result: VoiceBubbleRegion[] = []
  const minimumHeight = Math.max(6, Math.ceil(12 / step))
  for (let seed = 0; seed < colors.length; seed += 1) {
    const color = colors[seed]
    if (color < 0) continue
    colors[seed] = -1
    queue[0] = seed
    let head = 0
    let tail = 1
    let left = seed % sampledWidth
    let right = left
    let top = Math.floor(seed / sampledWidth)
    let bottom = top
    while (head < tail) {
      const index = queue[head++]
      const x = index % sampledWidth
      const y = Math.floor(index / sampledWidth)
      left = Math.min(left, x)
      right = Math.max(right, x)
      top = Math.min(top, y)
      bottom = Math.max(bottom, y)
      if (x > 0 && colors[index - 1] === color) { colors[index - 1] = -1; queue[tail++] = index - 1 }
      if (x + 1 < sampledWidth && colors[index + 1] === color) { colors[index + 1] = -1; queue[tail++] = index + 1 }
      if (y > 0 && colors[index - sampledWidth] === color) { colors[index - sampledWidth] = -1; queue[tail++] = index - sampledWidth }
      if (y + 1 < sampledHeight && colors[index + sampledWidth] === color) { colors[index + sampledWidth] = -1; queue[tail++] = index + sampledWidth }
    }
    const regionWidth = right - left + 1
    const regionHeight = bottom - top + 1
    const aspect = regionWidth / regionHeight
    if (regionHeight < minimumHeight || aspect < 1.5 || aspect > 7.6 ||
      regionWidth > sampledWidth * 0.82 || regionHeight > sampledHeight * 0.75 ||
      tail / (regionWidth * regionHeight) < 0.64) continue

    // Include antialiased rounded edges, which may fall outside the dominant-color component.
    const x = Math.max(0, left * step - step)
    const y = Math.max(0, top * step - step)
    const endX = Math.min(width, (right + 2) * step)
    const endY = Math.min(height, (bottom + 2) * step)
    result.push({ x, y, width: endX - x, height: endY - y })
  }

  return result.sort((a, b) => a.y - b.y || a.x - b.x).slice(0, 64)
}
