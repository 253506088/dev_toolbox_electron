import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { WechatCaptureEvent, WechatVoiceConversionStats } from '../src/shared/wechat-capture'

interface PreparationOptions {
  isCancelled: () => boolean
  onProgress: (message: string, stats: WechatVoiceConversionStats) => void
}

interface TestFrame { buffer: Buffer; width: number; height: number; fingerprint: Uint8Array; fingerprintWidth: number; fingerprintHeight: number }

// Keep native input, Electron capture and disk output behind observable boundaries.
// The capture services themselves run their real start/stop/output lifecycle.
const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  imageFile: vi.fn(),
  extract: vi.fn(),
  topInset: 0,
  getSources: vi.fn(),
  register: vi.fn(),
  unregister: vi.fn(),
  prepare: vi.fn<(options: PreparationOptions, frame: TestFrame) => Promise<TestFrame | null>>(),
  voiceFinish: vi.fn(),
  voiceStop: vi.fn(),
  position: vi.fn(),
  scroll: vi.fn(),
  scrollStop: vi.fn(),
  videoOpen: vi.fn(),
  videoClose: vi.fn(),
  finish: vi.fn(),
  frame: {
    buffer: Buffer.from('mock-png'),
    width: 100,
    height: 100,
    fingerprint: new Uint8Array(400),
    fingerprintWidth: 20,
    fingerprintHeight: 20
  }
}))

vi.mock('electron', () => ({
  app: { getPath: () => 'D:/capture-test' },
  desktopCapturer: { getSources: mocks.getSources },
  globalShortcut: { register: mocks.register, unregister: mocks.unregister }
}))

vi.mock('node:fs/promises', () => ({
  mkdir: mocks.mkdir,
  writeFile: mocks.writeFile,
  readFile: async () => mocks.frame.buffer
}))

vi.mock('sharp', () => ({
  default: () => {
    const pipeline = {
      metadata: async () => ({ width: 100, height: 100 }),
      extract: (region: unknown) => { mocks.extract(region); return pipeline },
      resize: () => pipeline,
      grayscale: () => pipeline,
      raw: () => pipeline,
      png: () => pipeline,
      composite: () => pipeline,
      toBuffer: async () => Buffer.alloc(10_000),
      toFile: mocks.imageFile
    }
    return pipeline
  }
}))

vi.mock('../src/main/services/capture-resolution', () => ({
  nativeCaptureSize: () => ({ width: 100, height: 100 })
}))

vi.mock('../src/main/services/wechat-scroll-controller', () => ({
  FRAME_STILL_THRESHOLD: 0.0035,
  WechatScrollController: {
    start: () => ({
      name: 'test-wheel', scroll: mocks.scroll, stop: mocks.scrollStop,
      isMinimized: async () => false
    })
  },
  scrollChatToTop: mocks.position,
  waitForStillFrame: async () => ({ frame: mocks.frame, still: true, samples: 1 }),
  TargetWindowMinimizedError: class extends Error {}
}))

vi.mock('../src/main/services/video-frame-source-service', () => ({
  VideoFrameSourceService: class {
    open = mocks.videoOpen
    close = mocks.videoClose
    dispose(): void {}
  }
}))

vi.mock('../src/main/services/capture-timing-log', () => ({
  CaptureTimingLog: {
    create: async () => ({
      record: () => undefined,
      measure: async <T>(_event: string, action: () => Promise<T>) => action(),
      finish: mocks.finish
    })
  }
}))

vi.mock('../src/main/services/wechat-voice-preparation', () => ({
  WechatVoicePreparation: class {
    constructor(private readonly options: PreparationOptions) {}
    prepare(frame: TestFrame): Promise<TestFrame | null> { return mocks.prepare(this.options, frame) }
    finish = mocks.voiceFinish
    get topInset(): number { return mocks.topInset }
    stop = mocks.voiceStop
  }
}))

import { WechatCaptureService } from '../src/main/services/wechat-capture-service'
import { WechatContinuousCaptureService } from '../src/main/services/wechat-continuous-capture-service'

const stats: WechatVoiceConversionStats = { scannedPages: 3, converted: 2, alreadyConverted: 1, failed: 0 }
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
const common = {
  sourceId: 'window:1234:0', sourceName: '微信', outputDirectory: 'D:/capture-test',
  crop: { left: 0, top: 0, right: 0, bottom: 0 }, startFromTop: true,
  convertVoiceToText: true
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function createSession(mode: 'paged' | 'continuous', stopAtCapture = 1) {
  const events: WechatCaptureEvent[] = []
  const service = mode === 'paged' ? new WechatCaptureService() : new WechatContinuousCaptureService()
  const sender = {
    isDestroyed: () => false,
    send: (_channel: string, event: WechatCaptureEvent) => {
      events.push(event)
      // One captured screen is sufficient to verify the transition and saved output.
      if (event.stage === 'capturing' && event.screenCount >= stopAtCapture) service.stop()
    }
  } as unknown as WebContents
  return {
    events,
    stop: () => service.stop(),
    start: (overrides: Partial<typeof common> = {}) => {
      const request = { ...common, ...overrides }
      return service instanceof WechatCaptureService
        ? service.start({ ...request, scrollStep: 1, settleDelayMs: 200, maxScreens: 2 }, sender)
        : service.start({ ...request, frameIntervalMs: 60, scrollIntervalMs: 120, maxFrames: 20,
            expectedSize: { width: 100, height: 100 } }, sender)
    }
  }
}

function writtenImages(): string[] {
  return [...mocks.writeFile.mock.calls, ...mocks.imageFile.mock.calls]
    .map((call) => String(call[0])).filter((path) => path.endsWith('.png'))
}

async function finished(): Promise<void> {
  await vi.waitFor(() => expect(mocks.finish).toHaveBeenCalledOnce())
}

describe.each(['paged', 'continuous'] as const)('%s 逐屏语音处理与截图生命周期', (mode) => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.topInset = 0
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    mocks.mkdir.mockResolvedValue(undefined)
    mocks.writeFile.mockResolvedValue(undefined)
    mocks.imageFile.mockResolvedValue(undefined)
    mocks.register.mockReturnValue(true)
    mocks.scroll.mockResolvedValue(undefined)
    mocks.scrollStop.mockResolvedValue(undefined)
    mocks.voiceStop.mockResolvedValue(undefined)
    mocks.voiceFinish.mockResolvedValue(undefined)
    mocks.getSources.mockResolvedValue([{ id: common.sourceId, thumbnail: { isEmpty: () => false, toPNG: () => Buffer.from('png') } }])
    mocks.videoOpen.mockResolvedValue({ width: 100, height: 100, meetsMinimumSize: true })
    mocks.videoClose.mockResolvedValue(undefined)
    mocks.finish.mockResolvedValue(undefined)
    mocks.position.mockImplementation(async () => mocks.frame)
    mocks.prepare.mockImplementation(async (options, frame) => { options.onProgress('本屏检查完成', stats); return frame })
  })

  afterEach(() => { Object.defineProperty(process, 'platform', platformDescriptor) })

  it('关闭自动转写时沿用原有截图输出流程', async () => {
    const session = createSession(mode)
    await session.start({ convertVoiceToText: false })
    await finished()
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(writtenImages()).not.toHaveLength(0)
    expect(session.events.some((event) => event.stage === 'capturing')).toBe(true)
    expect(session.events.some((event) => event.stage === 'error')).toBe(false)
    expect(session.events.at(-1)?.markdownPath).toMatch(/\.md$/)
  })

  it('先定位所选起点，当前屏转写完成前不写图像，完成后立即截图', async () => {
    const gate = deferred<TestFrame | null>()
    mocks.prepare.mockImplementation(async (options) => {
      options.onProgress('正在转写', stats)
      return gate.promise
    })
    const session = createSession(mode)
    await session.start()
    await vi.waitFor(() => expect(mocks.prepare).toHaveBeenCalledOnce())
    expect(writtenImages()).toEqual([])
    expect(mocks.position).toHaveBeenCalledOnce()
    expect(session.events.at(-1)?.stage).toBe('transcribing')

    gate.resolve(mocks.frame)
    await finished()
    expect(writtenImages().length).toBeGreaterThan(0)
    expect(session.events.find((event) => event.stage === 'capturing')?.voiceConversion).toEqual(stats)
    expect(session.events.at(-1)?.voiceConversion).toEqual(stats)
    expect(mocks.voiceStop).toHaveBeenCalled()
    expect(mocks.voiceFinish).toHaveBeenCalledWith('stopped', undefined)
    expect(mocks.scrollStop).toHaveBeenCalled()
    expect(mocks.unregister).toHaveBeenCalledWith('CommandOrControl+E')
  })

  it('首屏语音处理期间停止会取消转换且不写入未完成画面', async () => {
    const gate = deferred<TestFrame | null>()
    mocks.prepare.mockReturnValue(gate.promise)
    mocks.voiceStop.mockImplementation(async () => { gate.resolve(null) })
    const session = createSession(mode)
    await session.start()
    await vi.waitFor(() => expect(mocks.prepare).toHaveBeenCalledOnce())
    session.stop()
    await finished()
    expect(mocks.voiceStop).toHaveBeenCalled()
    expect(writtenImages()).toEqual([])
    expect(session.events.at(-1)).toMatchObject({ stage: 'stopped', screenCount: 0 })
    expect(session.events.some((event) => event.stage === 'capturing')).toBe(false)
  })

  it('首屏语音处理失败反馈错误且不写入未完成画面', async () => {
    mocks.prepare.mockRejectedValue(new Error('微信语音转写超时'))
    const session = createSession(mode)
    await session.start()
    await finished()
    expect(writtenImages()).toEqual([])
    expect(session.events.at(-1)).toMatchObject({ stage: 'error', message: '微信语音转写超时', screenCount: 0 })
    expect(mocks.voiceFinish).toHaveBeenCalledWith('error', '微信语音转写超时')
    expect(mocks.scrollStop).toHaveBeenCalled()
  })

  it('停止后即使在途本屏处理返回成功也不恢复采集', async () => {
    const gate = deferred<TestFrame | null>()
    mocks.prepare.mockReturnValue(gate.promise)
    const session = createSession(mode)
    await session.start()
    await vi.waitFor(() => expect(mocks.prepare).toHaveBeenCalledOnce())
    session.stop()
    gate.resolve(mocks.frame)
    await finished()
    expect(writtenImages()).toEqual([])
    expect(session.events.at(-1)?.stage).toBe('stopped')
  })

  it.each([false, undefined])('起点参数为 %s 时从当前位置逐屏自动转写，不回到聊天顶部', async (startFromTop) => {
    const session = createSession(mode)
    await session.start({ startFromTop })
    await finished()
    expect(mocks.position).not.toHaveBeenCalled()
    expect(mocks.prepare).toHaveBeenCalledOnce()
    expect(writtenImages().length).toBeGreaterThan(0)
    expect(session.events.at(-1)?.markdownPath).toMatch(/\.md$/)
  })

  it('拒绝非布尔起点参数，防止字符串 false 触发意外回顶', async () => {
    const session = createSession(mode)
    await expect(session.start({ startFromTop: 'false' as unknown as boolean })).rejects.toThrow('截图起点参数无效')
    expect(mocks.mkdir).not.toHaveBeenCalled()
    expect(mocks.position).not.toHaveBeenCalled()
    expect(mocks.prepare).not.toHaveBeenCalled()
  })

  it('后续屏转写中停止仍保存之前完成的长图和 Markdown', async () => {
    const gate = deferred<TestFrame | null>()
    mocks.prepare.mockImplementationOnce(async (_options, frame) => frame).mockReturnValue(gate.promise)
    const session = createSession(mode, 99)
    await session.start()
    await vi.waitFor(() => expect(mocks.prepare).toHaveBeenCalledTimes(2))
    session.stop()
    gate.resolve(null)
    await finished()
    expect(session.events.at(-1)).toMatchObject({ stage: 'stopped', screenCount: 1 })
    expect(session.events.at(-1)?.markdownPath).toMatch(/\.md$/)
    expect(writtenImages().some((path) => path.includes('long'))).toBe(true)
  })

  it('后续屏转写失败保留已完成截图且最终报告错误', async () => {
    mocks.prepare.mockImplementationOnce(async (_options, frame) => frame).mockRejectedValue(new Error('第二屏语音转换失败'))
    const session = createSession(mode, 99)
    await session.start()
    await finished()
    expect(session.events.at(-1)?.stage).toBe('error')
    expect(session.events.at(-1)?.message).toContain('第二屏语音转换失败')
    expect(session.events.at(-1)?.markdownPath).toMatch(/\.md$/)
  })

  it('首屏局部恢复多露出的旧内容被裁掉，保持用户选择的截图起点', async () => {
    mocks.topInset = 20
    const session = createSession(mode)
    await session.start()
    await finished()
    expect(mocks.extract).toHaveBeenCalledWith({ left: 0, top: 20, width: 100, height: mode === 'paged' ? 80 : 50 })
    expect(session.events.at(-1)?.stage).toBe('stopped')
  })
})
