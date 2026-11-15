import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { WebContents } from 'electron'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WechatCaptureEvent } from '../src/shared/wechat-capture'

const mocks = vi.hoisted(() => ({
  windowCapture: vi.fn(), videoOpen: vi.fn(), videoClose: vi.fn(), fingerprint: vi.fn(), encode: vi.fn(), finish: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => 'unused' },
  globalShortcut: { register: () => true, unregister: () => {} }
}))
vi.mock('../src/main/services/window-capture-source', () => ({
  captureWindowPng: mocks.windowCapture, listWindowCaptureSources: async () => []
}))
vi.mock('../src/main/services/capture-resolution', () => ({ nativeCaptureSize: () => ({ width: 3840, height: 2160 }) }))
vi.mock('../src/main/services/wechat-scroll-controller', () => ({
  FRAME_STILL_THRESHOLD: 0.0035,
  WechatScrollController: { start: () => ({ name: 'fixture', scroll: async () => {}, stop: async () => {}, isMinimized: async () => false }) },
  TargetWindowMinimizedError: class extends Error {},
  scrollChatToTop: async (options: { capture: () => Promise<unknown> }) => options.capture(),
  waitForStillFrame: async (capture: () => Promise<unknown>) => ({ frame: await capture(), still: true, samples: 1 })
}))
vi.mock('../src/main/services/video-frame-source-service', () => ({
  VideoFrameSourceService: class {
    open = mocks.videoOpen
    close = mocks.videoClose
    fingerprint = mocks.fingerprint
    encode = mocks.encode
    waitForSettle = async () => ({ timedOut: false })
    dispose(): void {}
  }
}))
vi.mock('../src/main/services/capture-timing-log', () => ({
  CaptureTimingLog: { create: async () => ({
    record: () => {}, measure: async <T>(_name: string, action: () => Promise<T>) => action(), finish: mocks.finish
  }) }
}))

import { WechatCaptureService } from '../src/main/services/wechat-capture-service'
import { WechatContinuousCaptureService } from '../src/main/services/wechat-continuous-capture-service'

const resultsRoot = resolve('test-results')
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
let directory: string
let currentSize: number
let small: Buffer
let large: Buffer
let service: WechatCaptureService | WechatContinuousCaptureService | undefined

beforeEach(async () => {
  vi.resetAllMocks()
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  await mkdir(resultsRoot, { recursive: true })
  directory = await mkdtemp(join(resultsRoot, 'capture-size-'))
  currentSize = 100
  small = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#abcdef' } }).png().toBuffer()
  large = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#abcdef' } }).png().toBuffer()
  mocks.windowCapture.mockImplementation(async () => currentSize === 100 ? small : large)
  mocks.videoOpen.mockRejectedValue(new Error('fixture uses compatible capture'))
  mocks.videoClose.mockResolvedValue(undefined)
  mocks.fingerprint.mockImplementation(async () => ({
    width: currentSize, height: currentSize, frameId: currentSize,
    fingerprintWidth: 20, fingerprintHeight: 20, fingerprint: new Uint8Array(400)
  }))
  mocks.encode.mockImplementation(async (id: number) => id === 100 ? small : large)
  mocks.finish.mockResolvedValue(undefined)
})

afterEach(async () => {
  service?.dispose()
  service = undefined
  Object.defineProperty(process, 'platform', platformDescriptor)
  if (!resolve(directory).startsWith(resultsRoot + sep)) throw new Error('Unsafe capture fixture cleanup path')
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})

const request = {
  sourceId: 'window:123:0', sourceName: '尺寸回归合成窗口', crop: { left: 0, top: 0, right: 0, bottom: 0 },
  startFromTop: false, convertVoiceToText: false
}

describe.each(['paged', 'continuous-compatible', 'continuous-screen', 'continuous-video', 'video-to-compatible'] as const)('%s 采集尺寸保护', (mode) => {
  it('同宽高比的DPI尺寸变化也会立即停止，并保存此前有效截图和Markdown', async () => {
    service = mode === 'paged' ? new WechatCaptureService() : new WechatContinuousCaptureService()
    if (mode.includes('video') || mode === 'video-to-compatible') {
      mocks.videoOpen.mockResolvedValue({ width: 100, height: 100, meetsMinimumSize: true })
    }
    const events: WechatCaptureEvent[] = []
    const sender = { isDestroyed: () => false, send: (_channel: string, event: WechatCaptureEvent) => {
      events.push(event)
      if (event.stage === 'capturing') {
        currentSize = 200
        if (mode === 'video-to-compatible') mocks.fingerprint.mockRejectedValue(new Error('simulated video GPU failure'))
      }
    } } as unknown as WebContents
    const common = { ...request, outputDirectory: directory, captureMethod: mode === 'continuous-screen' ? 'screen' as const : undefined }
    const started = service instanceof WechatCaptureService
      ? await service.start({ ...common, scrollStep: 1, settleDelayMs: 200, maxScreens: 5 }, sender)
      : await service.start({ ...common, frameIntervalMs: 60, scrollIntervalMs: 120, maxFrames: 20, expectedSize: { width: 100, height: 100 } }, sender)
    await vi.waitFor(() => expect(mocks.finish).toHaveBeenCalledOnce())
    expect(events.at(-1)?.stage).toBe('error')
    expect(events.at(-1)?.message).toContain('尺寸或缩放已改变')
    expect(events.at(-1)?.message).toContain('100×100 → 200×200')
    expect(events.at(-1)?.screenCount).toBe(1)
    expect(events.at(-1)?.markdownPath).toMatch(/\.md$/)
    expect(await readFile(events.at(-1)!.markdownPath!, 'utf8')).toContain('尺寸回归合成窗口')
    const outputs = await readdir(join(started.outputDirectory, 'long'))
    expect(outputs.length).toBeGreaterThan(0)
    for (const file of outputs) expect((await sharp(join(started.outputDirectory, 'long', file)).metadata()).width).toBe(100)
    if (mode === 'continuous-video') expect(mocks.windowCapture).not.toHaveBeenCalled()
    if (mode === 'video-to-compatible') expect(mocks.windowCapture).toHaveBeenCalledOnce()
    if (mode === 'continuous-screen') {
      expect(mocks.videoOpen).not.toHaveBeenCalled()
      expect(mocks.windowCapture).toHaveBeenCalledWith(request.sourceId, 'screen')
      expect(events.some((event) => event.message.includes('已降级'))).toBe(false)
    }
  })
})

it('新的截图会话可使用新尺寸，不继承前次会话的限制', async () => {
  service = new WechatCaptureService()
  const sender = { isDestroyed: () => false, send: (_channel: string, event: WechatCaptureEvent) => {
    if (event.stage === 'capturing') service!.stop()
  } } as unknown as WebContents
  for (const size of [100, 200]) {
    currentSize = size
    const started = await service.start({ ...request, outputDirectory: directory, scrollStep: 1, settleDelayMs: 200, maxScreens: 5 }, sender)
    await vi.waitFor(() => expect(mocks.finish).toHaveBeenCalledTimes(size === 100 ? 1 : 2))
    const metadata = await sharp(join(started.outputDirectory, 'screenshots', 'screen_0001.png')).metadata()
    expect(metadata.width).toBe(size)
  }
})
