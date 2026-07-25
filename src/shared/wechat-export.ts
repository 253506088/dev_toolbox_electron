/** 微信截图后处理（MD 转 PDF / PDF OCR / 图片瘦身）的共享类型。 */

/** MD 转 PDF 请求。 */
export interface WechatMarkdownToPdfRequest {
  markdownPath: string
  /** 是否跳过“无缝长图”章节，只嵌入分屏图（默认 true，可显著减小体积）。 */
  onlyScreens: boolean
  /** 嵌入图片的最大宽度（像素）。 */
  imageWidth: number
  /** JPEG 压缩质量 1~100。 */
  jpegQuality: number
}

export interface WechatMarkdownToPdfResult {
  pdfPath: string
  pdfBytes: number
  imageCount: number
}

/** 图片瘦身请求。 */
export interface WechatSlimImagesRequest {
  inputDirectory: string
  format: 'webp' | 'jpeg'
  maxWidth: number
  quality: number
}

export interface WechatSlimImagesResult {
  outputDirectory: string
  fileCount: number
  inputBytes: number
  outputBytes: number
}

/** PDF OCR 会话。 */
export interface WechatOcrBeginResult {
  sessionId: string
}

export interface WechatOcrPageResult {
  pageIndex: number
  messageCount: number
}

export interface WechatOcrFinishResult {
  transcriptPath: string
  messageCount: number
}

/** 图片目录 OCR：主进程后台执行，进度与结果通过事件推送。 */
export interface WechatOcrDirectoryRequest {
  directory: string
}

export interface WechatOcrDirectoryStartResult {
  runId: string
  fileCount: number
}

/** 后处理任务进度事件。 */
export interface WechatExportEvent {
  task: 'pdf' | 'slim' | 'ocr'
  stage: 'running' | 'complete' | 'stopped' | 'error'
  message: string
  current?: number
  total?: number
  /** complete 时携带产物路径（文稿/目录/PDF）。 */
  resultPath?: string
}
