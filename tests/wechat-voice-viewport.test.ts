import { describe, expect, it } from 'vitest'
import { createVoiceViewportAnchor, locateVoiceViewportAnchor } from '../src/main/services/wechat-voice-viewport'
import type { VoiceScanFrame } from '../src/main/services/wechat-voice-viewport'
import { continuousFrameDecision, findVerticalOverlap } from '../src/shared/wechat-capture'

function frame(): VoiceScanFrame {
  const fingerprint = new Uint8Array(64 * 100).fill(245)
  for (let y = 14; y < 20; y += 1) {
    for (let x = 0; x < 64; x += 1) fingerprint[y * 64 + x] = (y * 31 + x * 73) % 256
  }
  return { fingerprint, fingerprintWidth: 64, fingerprintHeight: 100, width: 640, height: 1000 }
}
function shift(source: VoiceScanFrame, rows: number): VoiceScanFrame {
  const fingerprint = new Uint8Array(source.fingerprint.length).fill(245)
  for (let y = 0; y < source.fingerprintHeight; y += 1) {
    const destination = y + rows
    if (destination < 0 || destination >= source.fingerprintHeight) continue
    fingerprint.set(source.fingerprint.subarray(y * source.fingerprintWidth, (y + 1) * source.fingerprintWidth), destination * source.fingerprintWidth)
  }
  return { ...source, fingerprint }
}
describe('语音展开后当前视口的像素锚点', () => {
  it('锚点只选取语音之前的有纹理区域，并在原位置精确匹配', () => {
    const source = frame()
    const anchor = createVoiceViewportAnchor(source, 0.5)!
    expect(anchor).not.toBeNull()
    expect(anchor.row + anchor.height).toBeLessThanOrEqual(50)
    expect(locateVoiceViewportAnchor(anchor, source)).toBe(anchor.row)
  })
  it('消息整体上下位移时可找回锚点的新位置', () => {
    const source = frame()
    const anchor = createVoiceViewportAnchor(source, 0.5)!
    expect(locateVoiceViewportAnchor(anchor, shift(source, 23))).toBe(anchor.row + 23)
    expect(locateVoiceViewportAnchor(anchor, shift(source, -8))).toBe(anchor.row - 8)
  })
  it('当前语音之后的转写变化不会污染前缀锚点', () => {
    const source = frame()
    const anchor = createVoiceViewportAnchor(source, 0.5)!
    const changed = { ...source, fingerprint: source.fingerprint.slice() }
    changed.fingerprint.fill(0, 50 * source.fingerprintWidth)
    expect(locateVoiceViewportAnchor(anchor, changed)).toBe(anchor.row)
  })
  it('纯色聊天背景不被当作可辨识锚点，也不能匹配真实锚点', () => {
    const source = frame()
    const blank = { ...source, fingerprint: new Uint8Array(source.fingerprint.length).fill(245) }
    expect(createVoiceViewportAnchor(blank, 0.5)).toBeNull()
    expect(locateVoiceViewportAnchor(createVoiceViewportAnchor(source, 0.5)!, blank)).toBeNull()
  })
  it('锚点完全离开视口或窗口宽度变化时不报告已恢复', () => {
    const source = frame()
    const anchor = createVoiceViewportAnchor(source, 0.5)!
    expect(locateVoiceViewportAnchor(anchor, shift(source, -30))).toBeNull()
    expect(locateVoiceViewportAnchor(anchor, { ...source, fingerprintWidth: 80 })).toBeNull()
  })
  it('重复图案同分时选择靠近原位置的匹配，减少错误跳转', () => {
    const source = frame()
    const anchor = createVoiceViewportAnchor(source, 0.5)!
    const repeated = { ...source, fingerprint: source.fingerprint.slice() }
    repeated.fingerprint.set(anchor.pixels, 55 * anchor.width)
    expect(locateVoiceViewportAnchor(anchor, repeated)).toBe(anchor.row)
  })

  it('新语音插入长转写并触发底部锚定后，局部恢复仍可与前一截图连续拼接', () => {
    const rows = Array.from({ length: 300 }, (_, row) => row)
    const render = (document: number[], start: number): VoiceScanFrame => {
      const fingerprint = new Uint8Array(64 * 100).fill(245)
      for (let y = 0; y < 100; y += 1) {
        const row = document[start + y]
        // Each row represents a distinguishable line of a synthetic chat document.
        // The common margins emulate the plain chat background around message text.
        for (let x = 8; x < 56; x += 1) fingerprint[y * 64 + x] = (row * 37 + x * 53 + Math.floor(row / 16) * 11) % 211
      }
      return { fingerprint, fingerprintWidth: 64, fingerprintHeight: 100, width: 640, height: 1000 }
    }
    const previous = render(rows, 0)
    const nextBeforeConversion = render(rows, 40)
    const anchor = createVoiceViewportAnchor(nextBeforeConversion, 0.8)!
    // A newly revealed voice near the bottom expands by 120 rows; WeChat keeps
    // the old bottom message visible and pushes this screen's starting rows away.
    const expanded = [...rows.slice(0, 132), ...Array.from({ length: 120 }, (_, row) => row + 1000), ...rows.slice(132)]
    const pinnedToBottom = render(expanded, 160)
    expect(locateVoiceViewportAnchor(anchor, pinnedToBottom)).toBeNull()
    // A small local rollback overshoots by two rows. The caller can crop the
    // inset on the first screen; subsequent frames align against saved content.
    const restored = render(expanded, 38)
    expect(locateVoiceViewportAnchor(anchor, restored)).toBe(anchor.row + 2)
    const match = findVerticalOverlap(previous.fingerprint, restored.fingerprint, 64, 100, 0.35, 0.995)
    expect(match).toEqual({ overlap: 62, score: 0 })
    expect(continuousFrameDecision(match, 1000, 100)).toEqual({ kind: 'append', overlap: 620, shift: 380 })
  })
})
