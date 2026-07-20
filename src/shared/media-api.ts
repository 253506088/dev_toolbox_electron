import type { BatchTaskKind, BatchTaskSnapshot } from './batch-task'

/** 支持导入的图片扩展名。 */
export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'bmp'] as const

/** 支持导入的视频扩展名。 */
export const VIDEO_EXTENSIONS = ['mp4', 'mov', 'webm', 'avi', 'mkv'] as const

/** 图片文件的基本信息。 */
export interface ImageMetadata {
  path: string
  name: string
  width: number
  height: number
  format: string
  size: number
  previewUrl: string
}

/** 图片缩放裁剪参数。 */
export interface ImageResizeOptions {
  width: number
  height: number
  fit: 'cover' | 'contain'
}

/** RGB 背景颜色。 */
export interface RgbColor {
  r: number
  g: number
  b: number
}

/** 图片抠图参数。 */
export interface ImageMattingOptions {
  thresholdOffset: number
  feather: number
  background?: RgbColor
}

/** 图片预览处理结果。 */
export interface ImagePreviewResult {
  dataUrl: string
  width: number
  height: number
  background?: RgbColor
}

/** 启动批量图片任务时使用的参数。 */
export interface StartImageBatchRequest {
  kind: BatchTaskKind
  inputPaths: string[]
  outputDirectory: string
  resize?: ImageResizeOptions
  matting?: ImageMattingOptions
}

/** FFmpeg 当前检测结果。 */
export interface FfmpegStatus {
  available: boolean
  path?: string
  version?: string
  message: string
}

/** 视频元数据。 */
export interface VideoMetadata {
  path: string
  name: string
  duration: number
  width: number
  height: number
  fps: number
  previewUrl: string
}

/** 归一化裁剪区域。 */
export interface NormalizedCropRect {
  x: number
  y: number
  width: number
  height: number
}

/** 视频抽帧参数。 */
export interface FrameExtractOptions {
  inputPath: string
  outputRoot: string
  fps: number
  startSeconds: number
  endSeconds: number
  maxFrames: number
  crop?: NormalizedCropRect
}

/** 视频抠图输出格式。 */
export type VideoOutputFormat = 'webm' | 'mov' | 'mp4'

/** 视频抠图参数。 */
export interface VideoMattingOptions {
  inputPath: string
  outputPath: string
  background: RgbColor
  similarity: number
  blend: number
  enableMatting: boolean
  denoise: boolean
  flipHorizontal: boolean
  flipVertical: boolean
  crop?: NormalizedCropRect
  outputFormat: VideoOutputFormat
}

/** 媒体子进程的实时事件。 */
export interface MediaJobEvent {
  jobId: string
  type: 'progress' | 'log' | 'completed' | 'failed' | 'cancelled'
  progress: number
  message: string
  outputPath?: string
  frameCount?: number
}

/** 启动视频任务后的信息。 */
export interface MediaJobStartResult {
  jobId: string
  outputPath: string
}

/** 第三期媒体工具对渲染进程开放的安全接口。 */
export interface MediaApi {
  /** 选择一张或多张图片并读取元数据。 */
  selectImages(multiple: boolean): Promise<ImageMetadata[]>
  /** 选择一个视频并读取元数据。 */
  selectVideo(): Promise<VideoMetadata | null>
  /** 选择输出目录。 */
  selectDirectory(): Promise<string | null>
  /** 选择视频导出文件。 */
  selectVideoOutput(format: VideoOutputFormat, suggestedName: string): Promise<string | null>
  /** 把拖入文件转换成主进程可使用的真实路径。 */
  pathForFile(file: unknown): string
  /** 注册拖入的视频并读取元数据。 */
  registerVideo(path: string): Promise<VideoMetadata>
  /** 注册拖入的图片并读取元数据。 */
  registerImages(paths: string[]): Promise<ImageMetadata[]>
  /** 生成缩放裁剪预览。 */
  previewResize(path: string, options: ImageResizeOptions): Promise<ImagePreviewResult>
  /** 生成抠图预览。 */
  previewMatting(path: string, options: ImageMattingOptions): Promise<ImagePreviewResult>
  /** 保存 data URL 图片。 */
  saveDataUrl(suggestedName: string, dataUrl: string): Promise<boolean>
  /** 检测 FFmpeg。 */
  ffmpegStatus(): Promise<FfmpegStatus>
  /** 启动视频抽帧。 */
  startFrameExtract(options: FrameExtractOptions): Promise<MediaJobStartResult>
  /** 启动视频抠图。 */
  startVideoMatting(options: VideoMattingOptions): Promise<MediaJobStartResult>
  /** 取消视频任务。 */
  cancelJob(jobId: string): Promise<void>
  /** 启动批量图片任务。 */
  startImageBatch(request: StartImageBatchRequest): Promise<BatchTaskSnapshot>
  /** 取消一个批次。 */
  cancelBatch(batchId: string): Promise<void>
  /** 重试一个失败或取消的单项。 */
  retryBatchItem(batchId: string, itemId: string): Promise<void>
  /** 监听视频任务事件。 */
  onJobEvent(callback: (event: MediaJobEvent) => void): () => void
  /** 监听批量图片任务事件。 */
  onBatchEvent(callback: (event: import('./batch-task').BatchTaskEvent) => void): () => void
}
