import { desktopCapturer, nativeImage, type NativeImage } from 'electron'
import { nativeCaptureSize } from './capture-resolution'
import { nativeWindowCapture, type NativeWindowInfo } from './native-window-capture'

export interface WindowCaptureSource {
  id: string
  name: string
  image?: NativeImage
  icon?: NativeImage | null
  captureMethod?: 'window' | 'screen'
  unavailableReason?: string
}

function usable(image?: NativeImage): image is NativeImage {
  if (!image || image.isEmpty()) return false
  const size = image.getSize()
  return size.width > 0 && size.height > 0
}

function windowKey(sourceId: string): string {
  // Chromium's trailing source discriminator is not part of the HWND identity.
  return /^window:(\d+):\d+$/.exec(sourceId)?.[1].replace(/^0+(?=\d)/, '') ?? sourceId
}

function unavailable(window?: NativeWindowInfo): string | undefined {
  if (window?.state === 'minimized') return '窗口已最小化，请恢复后刷新'
  if (window?.state === 'hidden') return '窗口当前不可见，请切换到所在桌面'
  if (window?.state === 'closed') return '窗口已关闭，请刷新列表'
  return undefined
}

/** Empty Chromium thumbnails are not evidence of minimization (especially across GPUs/monitors). */
export async function listWindowCaptureSources(): Promise<WindowCaptureSource[]> {
  const [desktop, native] = await Promise.allSettled([
    desktopCapturer.getSources({ types: ['window'], thumbnailSize: nativeCaptureSize(), fetchWindowIcons: true }),
    nativeWindowCapture.list()
  ])
  if (desktop.status === 'rejected' && native.status === 'rejected') throw new Error('无法读取桌面窗口，请稍后刷新')
  const nativeWindows = new Map((native.status === 'fulfilled' ? native.value : []).map((window) => [windowKey(window.id), window]))
  const sources: WindowCaptureSource[] = desktop.status === 'fulfilled'
    ? desktop.value.map((source) => ({ id: source.id, name: source.name, image: source.thumbnail, icon: source.appIcon })) : []
  const sourceIds = new Set(sources.map((source) => windowKey(source.id)))
  for (const window of nativeWindows.values()) {
    if (!sourceIds.has(windowKey(window.id))) sources.push({ id: window.id, name: window.name })
  }
  // Keep native screen reads serialized; they share one helper and full-resolution buffers.
  for (const source of sources) {
    const stateReason = unavailable(nativeWindows.get(windowKey(source.id)))
    if (stateReason) {
      source.image = undefined
      source.unavailableReason = stateReason
    } else if (usable(source.image)) {
      source.captureMethod = 'window'
    } else {
      source.image = undefined
      try {
        const image = nativeImage.createFromBuffer(await nativeWindowCapture.capture(source.id))
        if (!usable(image)) throw new Error('预览暂不可用，请刷新窗口')
        source.image = image
        source.captureMethod = 'screen'
      } catch (error) {
        source.unavailableReason = error instanceof Error ? error.message : '预览暂不可用，请刷新窗口'
      }
    }
  }
  return sources
}

/** Share the same fallback between previews and both capture modes, preserving the chosen geometry. */
export async function captureWindowPng(sourceId: string, method?: 'window' | 'screen'): Promise<Buffer> {
  if (method !== 'screen') {
    try {
      const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: nativeCaptureSize() })
      const source = sources.find((candidate) => windowKey(candidate.id) === windowKey(sourceId))
      if (source && usable(source.thumbnail)) return source.thumbnail.toPNG()
    } catch {
      // GPU/Chromium enumeration can fail while the other monitor is rendering normally.
    }
  }
  return nativeWindowCapture.capture(sourceId)
}
