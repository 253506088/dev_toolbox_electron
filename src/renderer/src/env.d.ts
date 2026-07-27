/// <reference types="vite/client" />

import type { ElectronApi } from '../../shared/electron-api'
import type { CaptureFrameSourceBridge } from '../../shared/capture-frame-source'

declare global {
  interface Window {
    electronApi: ElectronApi
    captureFrameSource: CaptureFrameSourceBridge
  }
}

export {}
