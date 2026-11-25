/** 外挂字幕封装工具支持的文件格式。 */
export const SUBTITLE_VIDEO_EXTENSIONS = ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v', 'ts', 'm2ts', 'wmv', 'flv', 'mpg', 'mpeg'] as const
export const SUBTITLE_EXTENSIONS = ['srt', 'ass', 'ssa', 'vtt'] as const

export type SubtitleConfidence = 'high' | 'medium' | 'low'
export type SubtitleEncoding = 'auto' | 'utf8' | 'gb18030' | 'big5' | 'shift_jis'
export type SubtitleOutputFormat = 'mkv' | 'mp4'
/** 烧录字幕直接成为画面；内置字幕轨需要播放器支持。 */
export type SubtitleEmbedMode = 'burn' | 'soft'
export type SubtitleAcceleration = 'auto' | 'cpu-fast'
export type SubtitleResolution = 'source' | '1080p'
export type SubtitleProcessingPhase = 'preparing' | 'probing' | 'encoding' | 'finalizing'

/** 实际机器信息及真实编码探测结果，不依据编码器列表推断可用。 */
export interface SubtitleHardwareStatus {
  cpuName?: string
  gpuName?: string
  driverVersion?: string
  qsvAvailable: boolean
  message: string
  checkedAt: string
}

/** 字幕来源必须明确区分真实外挂路径与当前视频内的流索引。 */
export type SubtitleInputSource =
  | { kind: 'external'; path: string }
  | { kind: 'embedded'; streamIndex: number }

export interface EmbeddedSubtitleTrack {
  streamIndex: number
  subtitleIndex: number
  codec: string
  language?: string
  title?: string
  default: boolean
  forced?: boolean
  supported: boolean
}

export interface SubtitleCandidate {
  /** 外挂为真实路径；内置轨为空，通过 source 字段选择，绝不当文件路径使用。 */
  path: string
  source?: SubtitleInputSource
  name: string
  score: number
  confidence: SubtitleConfidence
  reason: string
  supported?: boolean
}

export interface SubtitleMatchRow {
  id: string
  videoPath: string
  videoName: string
  episode?: string
  subtitlePath: string | null
  subtitleSource?: SubtitleInputSource
  embeddedTracks?: EmbeddedSubtitleTrack[]
  embeddedFontCount?: number
  scanError?: string
  candidates: SubtitleCandidate[]
  confidence: SubtitleConfidence | null
  reason: string
}

export interface SubtitleScanResult {
  scanId: string
  directory: string
  outputDirectory: string
  mode: 'folder' | 'video'
  subtitleCount: number
  embeddedSubtitleCount?: number
  rows: SubtitleMatchRow[]
}

export interface SubtitleScanProgress {
  completed: number
  total: number
  videoName: string
}

export interface SubtitleBatchRequest {
  scanId: string
  items: Array<{ rowId: string; subtitlePath?: string; source?: SubtitleInputSource }>
  /** 缺省使用烧录，确保普通播放器直接显示字幕。 */
  mode?: SubtitleEmbedMode
  acceleration?: SubtitleAcceleration
  resolution?: SubtitleResolution
  format: SubtitleOutputFormat
  encoding: SubtitleEncoding
  offsetSeconds: number
}

export type SubtitleItemStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface SubtitleBatchItem {
  id: string
  videoPath: string
  videoName: string
  subtitlePath: string
  source?: SubtitleInputSource
  subtitleName: string
  outputPath: string
  status: SubtitleItemStatus
  progress: number
  message: string
  error?: string
  actualEncoder?: string
  actualDecoder?: string
  fps?: number
  speed?: number
  elapsedSeconds?: number
  estimatedRemainingSeconds?: number
  phase?: SubtitleProcessingPhase
  sourceWidth?: number
  sourceHeight?: number
  outputWidth?: number
  outputHeight?: number
}

export interface SubtitleBatchSnapshot {
  batchId: string
  mode: SubtitleEmbedMode
  acceleration: SubtitleAcceleration
  resolution: SubtitleResolution
  outputDirectory: string
  status: 'running' | 'completed' | 'cancelled'
  items: SubtitleBatchItem[]
  startedAt: string
  finishedAt?: string
}

export interface SubtitleApi {
  hardwareStatus(force?: boolean): Promise<SubtitleHardwareStatus>
  selectFolder(): Promise<SubtitleScanResult | null>
  selectVideo(): Promise<SubtitleScanResult | null>
  scanPath(path: string): Promise<SubtitleScanResult>
  selectSubtitle(scanId: string, rowId: string): Promise<SubtitleCandidate | null>
  start(request: SubtitleBatchRequest): Promise<SubtitleBatchSnapshot>
  cancel(batchId: string): Promise<void>
  snapshot(): Promise<SubtitleBatchSnapshot | null>
  openOutput(batchId: string): Promise<void>
  onEvent(callback: (snapshot: SubtitleBatchSnapshot) => void): () => void
  onScanProgress(callback: (progress: SubtitleScanProgress) => void): () => void
}
