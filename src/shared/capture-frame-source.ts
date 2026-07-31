import type { WechatCaptureCrop } from './wechat-capture'

export interface CaptureFrameSourceOpenRequest {
  sourceId: string
  crop: WechatCaptureCrop
  maxSize: { width: number; height: number }
  /** 窗口枚举预览尺寸；视频流低于它说明清晰度发生了回退。 */
  minimumSize?: { width: number; height: number }
  fingerprintWidth?: number
}

export interface CaptureFrameSourceOpenResult {
  width: number
  height: number
  meetsMinimumSize: boolean
}

export interface CaptureFrameSourceFrame {
  frameId: number
  width: number
  height: number
  fingerprint: Uint8Array
  fingerprintWidth: number
  fingerprintHeight: number
}

export interface CaptureFrameSourceSettleResult {
  repaints: number
  elapsedMs: number
  timedOut: boolean
}

export type CaptureFrameSourceCommand =
  | { id: string; method: 'open'; payload: CaptureFrameSourceOpenRequest }
  | { id: string; method: 'fingerprint' }
  | { id: string; method: 'settle'; payload: { quietMs: number; maxMs: number } }
  | { id: string; method: 'encode'; payload: { frameId: number } }
  | { id: string; method: 'close' }

export type CaptureFrameSourceResult =
  | { id: string; ok: true; value?: CaptureFrameSourceOpenResult | CaptureFrameSourceFrame | CaptureFrameSourceSettleResult | Uint8Array }
  | { id: string; ok: false; error: string }

export interface CaptureFrameSourceBridge {
  onCommand(callback: (command: CaptureFrameSourceCommand) => void): () => void
  reply(result: CaptureFrameSourceResult): void
}
