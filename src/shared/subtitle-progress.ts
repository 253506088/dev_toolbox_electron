/** 一个完整 FFmpeg progress 块中的真实编码数据。 */
export interface SubtitleProgressSample {
  processedSeconds?: number
  fps?: number
  speed?: number
  frame?: number
  ended: boolean
  finalizing?: boolean
}

/** 按 progress=continue/end 提交整块，避免不同采样周期的数据混在一起。 */
export class SubtitleProgressReader {
  private values: Record<string, string> = {}

  push(line: string): SubtitleProgressSample | null {
    if (/Starting second pass:\s*moving the moov atom|moving the moov atom to the beginning/i.test(line)) return { ended: false, finalizing: true }
    const match = /^([a-z_]+)=(.*)$/.exec(line.trim())
    if (!match) return null
    this.values[match[1]] = match[2].trim()
    if (match[1] !== 'progress') return null
    const sample: SubtitleProgressSample = { ended: match[2].trim() === 'end' }
    const frame = numeric(this.values.frame)
    const fps = numeric(this.values.fps)
    const speed = numeric(this.values.speed?.replace(/x$/, ''))
    const microseconds = numeric(this.values.out_time_us ?? this.values.out_time_ms)
    if (frame !== undefined && frame >= 0) sample.frame = frame
    if (fps !== undefined && fps >= 0) sample.fps = fps
    if (speed !== undefined && speed >= 0) sample.speed = speed
    if (microseconds !== undefined) sample.processedSeconds = Math.max(0, microseconds / 1_000_000)
    else {
      const time = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(this.values.out_time ?? '')
      if (time) sample.processedSeconds = Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3])
    }
    this.values = {}
    return sample
  }
}

/** 使用已处理视频时间与真实编码耗时估计剩余；初始化阶段不给出虚假的乐观 ETA。 */
export function estimateSubtitleRemaining(duration: number, processedSeconds: number | undefined, encodingElapsedSeconds: number, ended: boolean): number | undefined {
  if (ended || !Number.isFinite(duration) || !(duration > 0) || processedSeconds === undefined || !Number.isFinite(processedSeconds) || !(processedSeconds >= 1) || !Number.isFinite(encodingElapsedSeconds) || encodingElapsedSeconds < 8) return undefined
  const speed = processedSeconds / encodingElapsedSeconds
  if (!(speed > 0) || !Number.isFinite(speed)) return undefined
  return Math.max(0, Math.ceil((duration - processedSeconds) / speed))
}

function numeric(value: string | undefined): number | undefined {
  if (value === undefined || !value || value === 'N/A') return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}
