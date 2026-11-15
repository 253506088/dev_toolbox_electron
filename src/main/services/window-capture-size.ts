export interface CaptureSize { width: number; height: number }

export class CaptureSizeChangedError extends Error {
  constructor(previous: CaptureSize, current: CaptureSize) {
    super(`目标窗口尺寸或缩放已改变（${previous.width}×${previous.height} → ${current.width}×${current.height}），请保持窗口大小和缩放不变后重新截图`)
    this.name = 'CaptureSizeChangedError'
  }
}

/** The first cropped output frame fixes the geometry for this capture session. */
export function assertCaptureSize(run: { captureSize?: CaptureSize }, current: CaptureSize): void {
  const previous = run.captureSize
  if (previous && (previous.width !== current.width || previous.height !== current.height)) {
    throw new CaptureSizeChangedError(previous, current)
  }
  if (!previous) run.captureSize = { width: current.width, height: current.height }
}
