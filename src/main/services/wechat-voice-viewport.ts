export interface VoiceScanFrame {
  fingerprint: Uint8Array
  width: number
  height: number
  fingerprintWidth: number
  fingerprintHeight: number
}

export interface VoiceViewportAnchor { pixels: Uint8Array; width: number; height: number; row: number }

/** 选取首条语音之前最有辨识度的小段像素，不依赖聊天文本或消息 ID。 */
export function createVoiceViewportAnchor(frame: VoiceScanFrame, beforeRatio: number): VoiceViewportAnchor | null {
  const width = frame.fingerprintWidth
  const limit = Math.max(1, Math.min(frame.fingerprintHeight, Math.floor(frame.fingerprintHeight * beforeRatio)))
  const height = Math.min(limit, Math.max(6, Math.round(frame.fingerprintHeight * 0.045)))
  let selected = -1
  let bestTexture = 0
  for (let top = 0; top <= limit - height; top += 1) {
    let texture = 0
    for (let row = top; row < top + height; row += 1) {
      for (let column = 1; column < width; column += 2) {
        texture += Math.abs(frame.fingerprint[row * width + column] - frame.fingerprint[row * width + column - 1])
      }
    }
    if (texture > bestTexture) { selected = top; bestTexture = texture }
  }
  if (selected < 0 || bestTexture < height * width * 0.25) return null
  return { pixels: frame.fingerprint.slice(selected * width, (selected + height) * width), width, height, row: selected }
}

/** 返回锚点在当前视口的位置；纯色背景或弱匹配不能冒充已恢复的起点。 */
export function locateVoiceViewportAnchor(anchor: VoiceViewportAnchor, frame: VoiceScanFrame): number | null {
  if (anchor.width !== frame.fingerprintWidth) return null
  let bestRow: number | null = null
  let bestScore = 0.009
  for (let row = 0; row <= frame.fingerprintHeight - anchor.height; row += 1) {
    let difference = 0
    let samples = 0
    for (let y = 0; y < anchor.height; y += 1) {
      for (let x = 0; x < anchor.width; x += 2) {
        difference += Math.abs(anchor.pixels[y * anchor.width + x] - frame.fingerprint[(row + y) * anchor.width + x])
        samples += 1
      }
    }
    const score = difference / (samples * 255)
    if (score < bestScore || (score === bestScore && bestRow !== null && Math.abs(row - anchor.row) < Math.abs(bestRow - anchor.row))) {
      bestScore = score
      bestRow = row
    }
  }
  return bestRow
}
