import type { FrameExtractOptions, NormalizedCropRect, VideoMattingOptions } from './media-api'

/** 把数值限制在闭区间内。 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 把小数格式化为 FFmpeg 可读且无多余零的文本。 */
function formatNumber(value: number, digits = 6): string {
  return value.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '')
}

/** 把归一化裁剪框转换成位于视频边界内的偶数像素裁剪参数。 */
export function cropToPixels(crop: NormalizedCropRect, sourceWidth: number, sourceHeight: number): { x: number; y: number; width: number; height: number } {
  if (sourceWidth < 2 || sourceHeight < 2) throw new Error('视频尺寸太小，无法裁剪')
  const normalizedX = clamp(crop.x, 0, 1 - 2 / sourceWidth)
  const normalizedY = clamp(crop.y, 0, 1 - 2 / sourceHeight)
  const x = Math.max(0, Math.floor(normalizedX * sourceWidth) & ~1)
  const y = Math.max(0, Math.floor(normalizedY * sourceHeight) & ~1)
  const rawWidth = Math.floor(clamp(crop.width, 2 / sourceWidth, 1 - normalizedX) * sourceWidth)
  const rawHeight = Math.floor(clamp(crop.height, 2 / sourceHeight, 1 - normalizedY) * sourceHeight)
  const width = Math.max(2, Math.min(sourceWidth - x, rawWidth) & ~1)
  const height = Math.max(2, Math.min(sourceHeight - y, rawHeight) & ~1)
  return { x, y, width, height }
}

/** 生成视频抽帧参数，滤镜顺序固定为裁剪后调整帧率。 */
export function buildFrameExtractArgs(options: FrameExtractOptions, outputDirectory: string, size: { width: number; height: number }): string[] {
  const filters: string[] = []
  if (options.crop) {
    const crop = cropToPixels(options.crop, size.width, size.height)
    filters.push(`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`)
  }
  filters.push(`fps=${formatNumber(options.fps)}`)
  const separator = outputDirectory.includes('\\') ? '\\' : '/'
  return [
    '-progress', 'pipe:2', '-nostats',
    '-ss', options.startSeconds.toFixed(3),
    '-to', options.endSeconds.toFixed(3),
    '-i', options.inputPath,
    '-vf', filters.join(','),
    '-frames:v', String(options.maxFrames),
    '-start_number', '1',
    '-y', `${outputDirectory}${separator}frame_%05d.png`
  ]
}

/** 按原版顺序生成视频抠图滤镜链。 */
export function buildVideoMattingFilters(options: VideoMattingOptions, size: { width: number; height: number }): string {
  const filters: string[] = []
  if (options.denoise) filters.push('hqdn3d=4:3:6:4')
  if (options.flipHorizontal) filters.push('hflip')
  if (options.flipVertical) filters.push('vflip')
  if (options.crop) {
    const crop = cropToPixels(options.crop, size.width, size.height)
    filters.push(`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`)
  }
  if (options.enableMatting) {
    const hex = [options.background.r, options.background.g, options.background.b]
      .map((channel) => clamp(Math.round(channel), 0, 255).toString(16).padStart(2, '0'))
      .join('')
    filters.push(`colorkey=0x${hex}:${clamp(options.similarity, 0.01, 1).toFixed(2)}:${clamp(options.blend, 0, 1).toFixed(2)}`)
  }
  return filters.join(',')
}

/** 生成视频抠图导出的完整参数。 */
export function buildVideoMattingArgs(options: VideoMattingOptions, size: { width: number; height: number }): string[] {
  const args = ['-progress', 'pipe:2', '-nostats', '-i', options.inputPath]
  const filters = buildVideoMattingFilters(options, size)
  if (filters) args.push('-vf', filters)
  if (options.outputFormat === 'mov') {
    args.push('-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le')
  } else if (options.outputFormat === 'webm') {
    args.push('-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '2M')
  } else {
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-preset', 'medium', '-crf', '20')
  }
  args.push('-an', '-y', options.outputPath)
  return args
}

/** 从 FFmpeg 探测输出中解析视频元数据。 */
export function parseVideoMetadata(text: string): { duration: number; width: number; height: number; fps: number } | null {
  const durationMatch = /Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/i.exec(text)
  const sizeMatch = /Video:.*?(\d{2,5})x(\d{2,5})/i.exec(text)
  const videoLine = /Video:.*/i.exec(text)?.[0] ?? text
  const ratioFpsMatch = /(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*fps/i.exec(videoLine)
  const plainFpsMatch = /(\d+(?:\.\d+)?)\s*fps/i.exec(videoLine)
  if (!durationMatch || !sizeMatch) return null
  const fraction = Number(`0.${durationMatch[4]}`)
  return {
    duration: Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]) + fraction,
    width: Number(sizeMatch[1]),
    height: Number(sizeMatch[2]),
    fps: ratioFpsMatch && Number(ratioFpsMatch[2]) > 0
      ? Number(ratioFpsMatch[1]) / Number(ratioFpsMatch[2])
      : plainFpsMatch ? Number(plainFpsMatch[1]) : 0
  }
}

/** 从 progress pipe 或旧式 time 文本中解析 0 到 1 的进度。 */
export function parseFfmpegProgress(line: string, totalDuration: number): number | null {
  if (!(totalDuration > 0)) return null
  const trimmed = line.trim()
  if (trimmed === 'progress=end') return 1
  const microseconds = /^(?:out_time_ms|out_time_us)=(\d+)$/.exec(trimmed)
  if (microseconds) return clamp(Number(microseconds[1]) / 1_000_000 / totalDuration, 0, 1)
  const time = /(?:^out_time=|time=)(\d+):(\d+):(\d+)\.(\d+)/.exec(trimmed)
  if (!time) return null
  const seconds = Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3]) + Number(`0.${time[4]}`)
  return clamp(seconds / totalDuration, 0, 1)
}
