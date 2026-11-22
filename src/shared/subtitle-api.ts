/** 外挂字幕封装工具支持的文件格式。 */
export const SUBTITLE_VIDEO_EXTENSIONS = ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v', 'ts', 'm2ts', 'wmv', 'flv', 'mpg', 'mpeg'] as const
export const SUBTITLE_EXTENSIONS = ['srt', 'ass', 'ssa', 'vtt'] as const

export type SubtitleConfidence = 'high' | 'medium' | 'low'
export type SubtitleEncoding = 'auto' | 'utf8' | 'gb18030' | 'big5' | 'shift_jis'
export type SubtitleOutputFormat = 'mkv' | 'mp4'

export interface SubtitleCandidate {
  path: string
  name: string
  score: number
  confidence: SubtitleConfidence
  reason: string
}

export interface SubtitleMatchRow {
  id: string
  videoPath: string
  videoName: string
  episode?: string
  subtitlePath: string | null
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
  rows: SubtitleMatchRow[]
}

export interface SubtitleBatchRequest {
  scanId: string
  items: Array<{ rowId: string; subtitlePath: string }>
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
  subtitleName: string
  outputPath: string
  status: SubtitleItemStatus
  progress: number
  message: string
  error?: string
}

export interface SubtitleBatchSnapshot {
  batchId: string
  outputDirectory: string
  status: 'running' | 'completed' | 'cancelled'
  items: SubtitleBatchItem[]
  startedAt: string
  finishedAt?: string
}

export interface SubtitleApi {
  selectFolder(): Promise<SubtitleScanResult | null>
  selectVideo(): Promise<SubtitleScanResult | null>
  scanPath(path: string): Promise<SubtitleScanResult>
  selectSubtitle(scanId: string, rowId: string): Promise<SubtitleCandidate | null>
  start(request: SubtitleBatchRequest): Promise<SubtitleBatchSnapshot>
  cancel(batchId: string): Promise<void>
  snapshot(): Promise<SubtitleBatchSnapshot | null>
  openOutput(batchId: string): Promise<void>
  onEvent(callback: (snapshot: SubtitleBatchSnapshot) => void): () => void
}
