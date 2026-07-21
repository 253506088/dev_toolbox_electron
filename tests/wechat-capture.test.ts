import { describe, expect, it } from 'vitest'
import {
  acceptedOverlapHeight,
  classifyCaptureOverlap,
  continuousFrameDecision,
  continuousSafeStripRegion,
  findVerticalOverlap,
  normalizedImageDifference
} from '../src/shared/wechat-capture'

describe('微信长截图图像匹配', () => {
  it('识别完全相同和明显不同的画面', () => {
    expect(normalizedImageDifference(Uint8Array.from([0, 127, 255]), Uint8Array.from([0, 127, 255]))).toBe(0)
    expect(normalizedImageDifference(Uint8Array.from([0, 0]), Uint8Array.from([255, 255]))).toBe(1)
  })

  it('找到上一屏底部与下一屏顶部的重叠高度', () => {
    const width = 6
    const previousRows = Array.from({ length: 20 }, (_, row) => Array.from({ length: width }, (_, column) => row * 7 + column * 3))
    const nextRows = [
      ...previousRows.slice(13),
      ...Array.from({ length: 13 }, (_, row) => Array.from({ length: width }, (_, column) => 160 + row * 4 + column))
    ]
    const result = findVerticalOverlap(
      Uint8Array.from(previousRows.flat()),
      Uint8Array.from(nextRows.flat()),
      width,
      20,
      0.1,
      0.9
    )
    expect(result.overlap).toBe(7)
    expect(result.score).toBe(0)
  })

  it('拒绝尺寸不一致的输入', () => {
    expect(findVerticalOverlap(new Uint8Array(4), new Uint8Array(5), 2, 2)).toEqual({ overlap: 0, score: 1 })
  })

  it('可疑匹配不执行猜测裁切', () => {
    expect(acceptedOverlapHeight({ overlap: 27, score: 0.0267 }, 669, 216)).toBe(0)
    expect(acceptedOverlapHeight({ overlap: 120, score: 0.004 }, 800, 200)).toBe(480)
  })

  it('按目标重叠率控制保存时机', () => {
    expect(classifyCaptureOverlap(447, 685)).toBe('continue')
    expect(classifyCaptureOverlap(240, 685)).toBe('continue')
    expect(classifyCaptureOverlap(115, 685)).toBe('save')
    expect(classifyCaptureOverlap(0, 685)).toBe('unsafe')
  })

  it('连续采集只追加可靠的小幅位移', () => {
    expect(continuousFrameDecision({ overlap: 150, score: 0.003 }, 800, 200)).toEqual({ kind: 'append', overlap: 600, shift: 200 })
    expect(continuousFrameDecision({ overlap: 199, score: 0.003 }, 800, 200)).toEqual({ kind: 'stationary', overlap: 796, shift: 4 })
    expect(continuousFrameDecision({ overlap: 80, score: 0.003 }, 800, 200).kind).toBe('reject')
    expect(continuousFrameDecision({ overlap: 150, score: 0.02 }, 800, 200).kind).toBe('append')
    expect(continuousFrameDecision({ overlap: 150, score: 0.03 }, 800, 200).kind).toBe('reject')
  })

  it('连续相邻帧保留原始像素级位移', () => {
    const width = 8
    const previousRows = Array.from({ length: 24 }, (_, row) => Array.from({ length: width }, (_, column) => row * 8 + column))
    const nextRows = [
      ...previousRows.slice(5),
      ...Array.from({ length: 5 }, (_, row) => Array.from({ length: width }, (_, column) => 200 + row * 8 + column))
    ]
    const match = findVerticalOverlap(
      Uint8Array.from(previousRows.flat()),
      Uint8Array.from(nextRows.flat()),
      width,
      24,
      0.35,
      0.995
    )
    expect(match).toEqual({ overlap: 19, score: 0 })
    expect(continuousFrameDecision(match, 24, 24)).toEqual({ kind: 'append', overlap: 19, shift: 5 })
  })

  it('连续拼接从安全带提取半屏新内容', () => {
    expect(continuousSafeStripRegion(698, 354)).toEqual({ top: 134, height: 354, safeBottom: 488 })
    expect(() => continuousSafeStripRegion(698, 500)).toThrow('连续帧位移超出安全条带范围')
  })

  it('安全条带不会重复采集底部固定覆盖层', () => {
    const frameHeight = 10
    const shift = 5
    const region = continuousSafeStripRegion(frameHeight, shift)
    const firstFrame = Array.from({ length: frameHeight }, (_, row) => row)
    const secondFrame = Array.from({ length: frameHeight }, (_, row) => row + shift)
    firstFrame[8] = firstFrame[9] = 99
    secondFrame[8] = secondFrame[9] = 99
    const stitched = [
      ...firstFrame.slice(0, region.safeBottom),
      ...secondFrame.slice(region.top, region.top + region.height)
    ]
    expect(stitched).toEqual(Array.from({ length: 12 }, (_, row) => row))
    expect(stitched).not.toContain(99)
  })
})
