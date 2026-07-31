import type {
  CaptureFrameSourceFrame,
  CaptureFrameSourceOpenRequest,
  CaptureFrameSourceOpenResult,
  CaptureFrameSourceSettleResult
} from '@shared/capture-frame-source'

const DEFAULT_FINGERPRINT_WIDTH = 320

/** 隐藏采集页内的一条常驻桌面视频流。每次指纹与随后编码的 PNG 来自同一张缓存画布。 */
export class FrameSource {
  private readonly video = document.createElement('video')
  private readonly frameCanvas = new OffscreenCanvas(1, 1)
  private readonly fingerprintCanvas = new OffscreenCanvas(1, 1)
  private stream: MediaStream | null = null
  private crop: CaptureFrameSourceOpenRequest['crop'] | null = null
  private fingerprintWidth = DEFAULT_FINGERPRINT_WIDTH
  private frameId = 0
  private cachedFrameId = 0

  async open(request: CaptureFrameSourceOpenRequest): Promise<CaptureFrameSourceOpenResult> {
    this.close()
    this.crop = request.crop
    this.fingerprintWidth = request.fingerprintWidth ?? DEFAULT_FINGERPRINT_WIDTH
    const videoConstraints = {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: request.sourceId,
        maxWidth: request.maxSize.width,
        maxHeight: request.maxSize.height,
        maxFrameRate: 30
      }
    } as unknown as MediaTrackConstraints
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraints })
    this.video.muted = true
    this.video.srcObject = this.stream
    await this.video.play()
    await waitForVideoDimensions(this.video, 3000)
    const meetsMinimumSize = !request.minimumSize || (
      this.video.videoWidth >= request.minimumSize.width &&
      this.video.videoHeight >= request.minimumSize.height
    )
    return { width: this.video.videoWidth, height: this.video.videoHeight, meetsMinimumSize }
  }

  fingerprint(): CaptureFrameSourceFrame {
    if (!this.stream || !this.crop) throw new Error('视频采集流尚未建立')
    const region = cropToPixels(this.crop, this.video.videoWidth, this.video.videoHeight)
    this.frameCanvas.width = region.width
    this.frameCanvas.height = region.height
    const frameContext = this.frameCanvas.getContext('2d', { alpha: false })
    if (!frameContext) throw new Error('无法创建视频帧画布')
    frameContext.drawImage(
      this.video,
      region.left, region.top, region.width, region.height,
      0, 0, region.width, region.height
    )

    const fingerprintHeight = Math.max(24, Math.round(region.height * this.fingerprintWidth / region.width))
    this.fingerprintCanvas.width = this.fingerprintWidth
    this.fingerprintCanvas.height = fingerprintHeight
    const fingerprintContext = this.fingerprintCanvas.getContext('2d', { alpha: false, willReadFrequently: true })
    if (!fingerprintContext) throw new Error('无法创建指纹画布')
    fingerprintContext.drawImage(this.frameCanvas, 0, 0, this.fingerprintWidth, fingerprintHeight)
    const rgba = fingerprintContext.getImageData(0, 0, this.fingerprintWidth, fingerprintHeight).data
    const gray = new Uint8Array(this.fingerprintWidth * fingerprintHeight)
    for (let source = 0, target = 0; target < gray.length; source += 4, target += 1) {
      gray[target] = Math.round(rgba[source] * 0.299 + rgba[source + 1] * 0.587 + rgba[source + 2] * 0.114)
    }
    this.cachedFrameId = ++this.frameId
    return {
      frameId: this.cachedFrameId,
      width: region.width,
      height: region.height,
      fingerprint: gray,
      fingerprintWidth: this.fingerprintWidth,
      fingerprintHeight
    }
  }

  async encode(frameId: number): Promise<Uint8Array> {
    if (frameId !== this.cachedFrameId) throw new Error('待编码视频帧已被更新，请重新采样')
    const blob = await this.frameCanvas.convertToBlob({ type: 'image/png' })
    return new Uint8Array(await blob.arrayBuffer())
  }

  /** 等到连续 quietMs 没有合成新帧；maxMs 只防止持续动画让任务永久等待。 */
  async waitForSettle(quietMs: number, maxMs: number): Promise<CaptureFrameSourceSettleResult> {
    if (!this.stream) throw new Error('视频采集流尚未建立')
    const startedAt = performance.now()
    let repaints = 0
    while (performance.now() - startedAt < maxMs) {
      const repainted = await this.waitForRepaint(quietMs)
      if (!repainted) return { repaints, elapsedMs: Math.round(performance.now() - startedAt), timedOut: false }
      repaints += 1
    }
    return { repaints, elapsedMs: Math.round(performance.now() - startedAt), timedOut: true }
  }

  close(): void {
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    this.stream = null
    this.video.srcObject = null
    this.crop = null
    this.cachedFrameId = 0
  }

  private waitForRepaint(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false
      let timeout: ReturnType<typeof setTimeout>
      const callbackId = this.video.requestVideoFrameCallback(() => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolve(true)
      })
      timeout = setTimeout(() => {
        if (settled) return
        settled = true
        this.video.cancelVideoFrameCallback(callbackId)
        resolve(false)
      }, timeoutMs)
    })
  }
}

function cropToPixels(crop: CaptureFrameSourceOpenRequest['crop'], width: number, height: number): { left: number; top: number; width: number; height: number } {
  const left = Math.round(width * crop.left / 100)
  const top = Math.round(height * crop.top / 100)
  const right = Math.round(width * crop.right / 100)
  const bottom = Math.round(height * crop.bottom / 100)
  return { left, top, width: width - left - right, height: height - top - bottom }
}

async function waitForVideoDimensions(video: HTMLVideoElement, timeoutMs: number): Promise<void> {
  const startedAt = performance.now()
  while (video.videoWidth < 1 || video.videoHeight < 1) {
    if (performance.now() - startedAt >= timeoutMs) throw new Error('视频流在限定时间内没有产生画面')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
