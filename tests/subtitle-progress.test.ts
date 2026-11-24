import { describe, expect, it } from 'vitest'
import { estimateSubtitleRemaining, SubtitleProgressReader } from '../src/shared/subtitle-progress'

describe('字幕编码真实进度与预计剩余时间', () => {
  it('仅在完整 progress 块后提交帧率、倍速与视频时间，避免混用两次采样', () => {
    const reader = new SubtitleProgressReader()
    expect(reader.push('frame=240')).toBeNull()
    expect(reader.push('fps=30.82')).toBeNull()
    reader.push('out_time_us=10000000')
    reader.push('speed=1.28x')
    expect(reader.push('progress=continue')).toEqual({ frame: 240, fps: 30.82, processedSeconds: 10, speed: 1.28, ended: false })
    reader.push('frame=250')
    reader.push('out_time_us=10416667')
    expect(reader.push('progress=end')).toEqual({ frame: 250, processedSeconds: 10.416667, ended: true })
  })

  it('未知值不伪造速度，负时间钳零，兼容旧 out_time_ms 和时钟时间', () => {
    const reader = new SubtitleProgressReader()
    reader.push('fps=N/A')
    reader.push('speed=N/A')
    reader.push('out_time_us=-1000')
    expect(reader.push('progress=continue')).toEqual({ processedSeconds: 0, ended: false })
    reader.push('out_time_ms=2500000')
    expect(reader.push('progress=continue')).toEqual({ processedSeconds: 2.5, ended: false })
    reader.push('out_time=01:02:03.25')
    expect(reader.push('progress=continue')).toEqual({ processedSeconds: 3723.25, ended: false })
    expect(reader.push('[h264_qsv] device busy')).toBeNull()
  })

  it('MP4 索引搬移日志立即标记整理阶段，不必等 progress=end 才解释等待', () => {
    const reader = new SubtitleProgressReader()
    reader.push('frame=240')
    expect(reader.push('[mp4 @ 000000000] Starting second pass: moving the moov atom to the beginning of the file')).toEqual({ ended: false, finalizing: true })
    reader.push('out_time_us=10000000')
    expect(reader.push('progress=end')).toEqual({ frame: 240, processedSeconds: 10, ended: true })
  })

  it('至少预热八秒且处理一秒有效视频后才显示 ETA，不隐藏缓慢编码的真实耗时', () => {
    expect(estimateSubtitleRemaining(1440, 10, 7.9, false)).toBeUndefined()
    expect(estimateSubtitleRemaining(1440, .5, 15, false)).toBeUndefined()
    expect(estimateSubtitleRemaining(1440, 10, 10, false)).toBe(1430)
    expect(estimateSubtitleRemaining(1440, 10, 20, false)).toBe(2860)
    expect(estimateSubtitleRemaining(1440, 1400, 1000, false)).toBe(29)
    expect(estimateSubtitleRemaining(1440, 1440, 1000, true)).toBeUndefined()
    expect(estimateSubtitleRemaining(0, 10, 20, false)).toBeUndefined()
    expect(estimateSubtitleRemaining(Infinity, 10, 20, false)).toBeUndefined()
    expect(estimateSubtitleRemaining(10, NaN, 20, false)).toBeUndefined()
  })
})
