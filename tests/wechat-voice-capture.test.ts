import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { WechatCaptureEvent, WechatVoiceConversionStats } from '../src/shared/wechat-capture'

interface PreparationOptions {
  isCancelled: () => boolean
  onProgress: (message: string, stats: WechatVoiceConversionStats) => void
}

// Keep native input, Electron capture and disk output behind observable boundaries.
// The capture services themselves run their real start/stop/output lifecycle.
const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  imageFile: vi.fn(),
  getSources: vi.fn(),
  register: vi.fn(),
  unregister: vi.fn(),
  prepare: vi.fn<(options: PreparationOptions) => Promise<WechatVoiceConversionStats | null>>(),
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
      extract: () => pipeline,
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
    prepare(): Promise<WechatVoiceConversionStats | null> { return mocks.prepare(this.options) }
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

function createSession(mode: 'paged' | 'continuous') {
  const events: WechatCaptureEvent[] = []
  const service = mode === 'paged' ? new WechatCaptureService() : new WechatContinuousCaptureService()
  const sender = {
    isDestroyed: () => false,
    send: (_channel: string, event: WechatCaptureEvent) => {
      events.push(event)
      // One captured screen is sufficient to verify the transition and saved output.
      if (event.stage === 'capturing') service.stop()
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

describe.each(['paged', 'continuous'] as const)('%s 语音预处理与截图生命周期', (mode) => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    mocks.mkdir.mockResolvedValue(undefined)
    mocks.writeFile.mockResolvedValue(undefined)
    mocks.imageFile.mockResolvedValue(undefined)
    mocks.register.mockReturnValue(true)
    mocks.scroll.mockResolvedValue(undefined)
    mocks.scrollStop.mockResolvedValue(undefined)
    mocks.voiceStop.mockResolvedValue(undefined)
    mocks.videoOpen.mockResolvedValue({ width: 100, height: 100, meetsMinimumSize: true })
    mocks.videoClose.mockResolvedValue(undefined)
    mocks.finish.mockResolvedValue(undefined)
    mocks.position.mockImplementation(async () => mocks.frame)
    mocks.prepare.mockResolvedValue(stats)
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

  it('转写完成前不定位截图首帧、不写入图像或开启视频流，完成后保留统计', async () => {
    const gate = deferred<WechatVoiceConversionStats | null>()
    mocks.prepare.mockImplementation(async (options) => {
      options.onProgress('正在转写', stats)
      return gate.promise
    })
    const session = createSession(mode)
    await session.start()
    await vi.waitFor(() => expect(mocks.prepare).toHaveBeenCalledOnce())
    expect(writtenImages()).toEqual([])
    expect(mocks.position).not.toHaveBeenCalled()
    expect(mocks.videoOpen).not.toHaveBeenCalled()
    expect(session.events.at(-1)?.stage).toBe('transcribing')

    gate.resolve(stats)
    await finished()
    expect(writtenImages().length).toBeGreaterThan(0)
    expect(session.events.find((event) => event.stage === 'capturing')?.voiceConversion).toEqual(stats)
    expect(session.events.at(-1)?.voiceConversion).toEqual(stats)
    expect(mocks.voiceStop).toHaveBeenCalled()
    expect(mocks.scrollStop).toHaveBeenCalled()
    expect(mocks.unregister).toHaveBeenCalledWith('CommandOrControl+E')
  })

  it('预处理期间停止会取消转换并且不生成截图', async () => {
    const gate = deferred<WechatVoiceConversionStats | null>()
    mocks.prepare.mockReturnValue(gate.promise)
    mocks.voiceStop.mockImplementation(async () => { gate.resolve(null) })
    const session = createSession(mode)
    await session.start()
    await vi.waitFor(() => expect(mocks.prepare).toHaveBeenCalledOnce())
    session.stop()
    await finished()
    expect(mocks.voiceStop).toHaveBeenCalled()
    expect(mocks.videoOpen).not.toHaveBeenCalled()
    expect(writtenImages()).toEqual([])
    expect(session.events.at(-1)).toMatchObject({ stage: 'stopped', screenCount: 0 })
    expect(session.events.some((event) => event.stage === 'capturing')).toBe(false)
  })

  it('预处理失败反馈错误并且不开始采集', async () => {
    mocks.prepare.mockRejectedValue(new Error('微信语音转写超时'))
    const session = createSession(mode)
    await session.start()
    await finished()
    expect(writtenImages()).toEqual([])
    expect(mocks.videoOpen).not.toHaveBeenCalled()
    expect(mocks.position).not.toHaveBeenCalled()
    expect(session.events.at(-1)).toMatchObject({ stage: 'error', message: '微信语音转写超时', screenCount: 0 })
    expect(mocks.voiceStop).toHaveBeenCalled()
    expect(mocks.scrollStop).toHaveBeenCalled()
  })

  it('停止后即使在途预处理返回成功也不恢复采集', async () => {
    const gate = deferred<WechatVoiceConversionStats | null>()
    mocks.prepare.mockReturnValue(gate.promise)
    const session = createSession(mode)
    await session.start()
    await vi.waitFor(() => expect(mocks.prepare).toHaveBeenCalledOnce())
    session.stop()
    gate.resolve(stats)
    await finished()
    expect(mocks.videoOpen).not.toHaveBeenCalled()
    expect(mocks.position).not.toHaveBeenCalled()
    expect(writtenImages()).toEqual([])
    expect(session.events.at(-1)?.stage).toBe('stopped')
  })

  it('拒绝从当前位置截图与自动转写组合，且不会创建任务或操作窗口', async () => {
    const session = createSession(mode)
    await expect(session.start({ startFromTop: false })).rejects.toThrow('顶部')
    expect(mocks.mkdir).not.toHaveBeenCalled()
    expect(mocks.register).not.toHaveBeenCalled()
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.videoOpen).not.toHaveBeenCalled()
    expect(writtenImages()).toEqual([])
  })
})
