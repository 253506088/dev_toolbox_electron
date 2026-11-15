import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ sources: vi.fn(), list: vi.fn(), capture: vi.fn(), image: vi.fn() }))
vi.mock('electron', () => ({ desktopCapturer: { getSources: mocks.sources }, nativeImage: { createFromBuffer: mocks.image } }))
vi.mock('../src/main/services/capture-resolution', () => ({ nativeCaptureSize: () => ({ width: 3840, height: 2160 }) }))
vi.mock('../src/main/services/native-window-capture', () => ({ nativeWindowCapture: { list: mocks.list, capture: mocks.capture } }))

import { captureWindowPng, listWindowCaptureSources } from '../src/main/services/window-capture-source'

const png = Buffer.from('native-screen-png')
const image = (width = 1200, height = 900) => ({
  isEmpty: () => width === 0 || height === 0,
  getSize: () => ({ width, height }),
  toPNG: () => Buffer.from('chromium-window-png')
})
const nativeWindow = (state = 'ready', id = 'window:123:0') => ({ id, name: 'visible app', state, width: 1200, height: 900 })

beforeEach(() => {
  vi.resetAllMocks()
  mocks.list.mockResolvedValue([nativeWindow()])
  mocks.sources.mockResolvedValue([{ id: 'window:123:0', name: 'visible app', thumbnail: image(0, 0) }])
  mocks.capture.mockResolvedValue(png)
  mocks.image.mockReturnValue(image())
})

describe('窗口预览及多显示器兼容采集', () => {
  it('可见窗口缺少 Chromium 缩略图时取得屏幕预览，不误判为最小化', async () => {
    const [source] = await listWindowCaptureSources()
    expect(source.captureMethod).toBe('screen')
    expect(source.image?.getSize()).toEqual({ width: 1200, height: 900 })
    expect(source.unavailableReason).toBeUndefined()
    expect(mocks.capture).toHaveBeenCalledWith('window:123:0')
  })

  it('使用原生枚举补充 Chromium 未列出的另一显示器窗口', async () => {
    mocks.sources.mockResolvedValue([])
    expect(await listWindowCaptureSources()).toMatchObject([{ id: 'window:123:0', captureMethod: 'screen' }])
  })

  it('以真实最小化状态拒绝过期缩略图，且不读取桌面背景', async () => {
    mocks.list.mockResolvedValue([nativeWindow('minimized')])
    mocks.sources.mockResolvedValue([{ id: 'window:123:0', name: 'app', thumbnail: image() }])
    const [source] = await listWindowCaptureSources()
    expect(source.image).toBeUndefined()
    expect(source.unavailableReason).toContain('已最小化')
    expect(mocks.capture).not.toHaveBeenCalled()
  })

  it('遮挡、屏幕外等故障保留具体原因，不统称需要恢复窗口', async () => {
    mocks.capture.mockRejectedValue(new Error('目标窗口被遮挡，请保持完整可见后刷新'))
    const [source] = await listWindowCaptureSources()
    expect(source.image).toBeUndefined()
    expect(source.unavailableReason).toContain('被遮挡')
    expect(source.unavailableReason).not.toContain('最小化')
  })

  it('原生诊断失败仍能使用正常窗口缩略图', async () => {
    mocks.list.mockRejectedValue(new Error('helper unavailable'))
    mocks.sources.mockResolvedValue([{ id: 'window:123:0', name: 'app', thumbnail: image() }])
    expect(await listWindowCaptureSources()).toMatchObject([{ captureMethod: 'window' }])
    expect(mocks.capture).not.toHaveBeenCalled()
  })

  it('Chromium 枚举失败也可从真实窗口列表恢复预览', async () => {
    mocks.sources.mockRejectedValue(new Error('GPU capture failed'))
    expect(await listWindowCaptureSources()).toMatchObject([{ captureMethod: 'screen' }])
  })

  it('屏幕兼容模式持续使用同一物理边界，避免采集中途切换导致裁剪漂移', async () => {
    mocks.sources.mockResolvedValue([{ id: 'window:123:0', thumbnail: image() }])
    expect(await captureWindowPng('window:123:0', 'screen')).toBe(png)
    expect(mocks.sources).not.toHaveBeenCalled()
  })

  it('常规帧缺失时也使用兼容采集，预览可用之后不会在开始截图时直接失败', async () => {
    expect(await captureWindowPng('window:123:0')).toBe(png)
    expect(mocks.capture).toHaveBeenCalledWith('window:123:0')
  })

  it('有正常窗口帧时保持原生窗口采集', async () => {
    mocks.sources.mockResolvedValue([{ id: 'window:123:0', thumbnail: image() }])
    expect(await captureWindowPng('window:123:0')).toEqual(Buffer.from('chromium-window-png'))
    expect(mocks.capture).not.toHaveBeenCalled()
  })

  it('常规采集抛出 GPU 错误时仍尝试获取可见窗口画面', async () => {
    mocks.sources.mockRejectedValue(new Error('capture failed'))
    expect(await captureWindowPng('window:123:0')).toBe(png)
  })

  it('按 HWND 合并不同后缀的同一窗口，并保留 Chromium 的原始 ID', async () => {
    mocks.sources.mockResolvedValue([{ id: 'window:123:1', name: 'app', thumbnail: image() }])
    const sources = await listWindowCaptureSources()
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({ id: 'window:123:1', captureMethod: 'window' })
    expect(await captureWindowPng('window:123:0')).toEqual(Buffer.from('chromium-window-png'))
    expect(mocks.capture).not.toHaveBeenCalled()
  })

  it('窗口源后缀变化也不会丢失真实最小化状态', async () => {
    mocks.sources.mockResolvedValue([{ id: 'window:123:1', name: 'app', thumbnail: image() }])
    mocks.list.mockResolvedValue([nativeWindow('minimized')])
    const sources = await listWindowCaptureSources()
    expect(sources).toHaveLength(1)
    expect(sources[0].unavailableReason).toContain('已最小化')
    expect(sources[0].image).toBeUndefined()
  })
})
