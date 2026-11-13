import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaptureTimingLog } from '../src/main/services/capture-timing-log'
import type { VoiceConversionOptions } from '../src/main/services/wechat-voice-controller'
import type { WechatVoicePreprocessorOptions, VoiceScanFrame } from '../src/main/services/wechat-voice-preprocessor'
import type { WechatVoiceConversionStats } from '../src/shared/wechat-capture'

const dependencies = vi.hoisted(() => ({
  start: vi.fn(),
  validate: vi.fn(),
  convertVisible: vi.fn(),
  stop: vi.fn(),
  scrollChatToTop: vi.fn(),
  preprocessWechatVoices: vi.fn(),
  writeFile: vi.fn()
}))

vi.mock('node:fs/promises', () => ({ writeFile: dependencies.writeFile }))
vi.mock('../src/main/services/wechat-voice-controller', () => ({
  WechatVoiceController: { start: dependencies.start }
}))
vi.mock('../src/main/services/wechat-scroll-controller', () => ({ scrollChatToTop: dependencies.scrollChatToTop }))
vi.mock('../src/main/services/wechat-voice-preprocessor', () => ({ preprocessWechatVoices: dependencies.preprocessWechatVoices }))

import { WechatVoicePreparation } from '../src/main/services/wechat-voice-preparation'

const zeroStats = (): WechatVoiceConversionStats => ({ scannedPages: 0, converted: 0, alreadyConverted: 0, failed: 0 })
const frame: VoiceScanFrame = { fingerprint: new Uint8Array(4), width: 20, height: 20, fingerprintWidth: 2, fingerprintHeight: 2 }

function setup() {
  let cancelled = false
  const log = {
    measure: vi.fn(async (_event: string, action: () => Promise<unknown>) => action()),
    record: vi.fn()
  }
  const options = {
    sourceId: 'window:123:0',
    crop: { left: 30, top: 10, right: 2, bottom: 20 },
    outputDirectory: 'D:/capture-output',
    capture: vi.fn(async () => frame),
    scroll: vi.fn(async () => undefined),
    isCancelled: () => cancelled,
    onProgress: vi.fn(),
    log: log as unknown as CaptureTimingLog
  }
  return { preparation: new WechatVoicePreparation(options), options, log, cancel: () => { cancelled = true } }
}

function report(): Record<string, unknown> {
  const call = dependencies.writeFile.mock.calls.at(-1)
  expect(call?.[0]).toMatch(/voice-conversion-report\.json$/)
  expect(call?.[2]).toBe('utf8')
  return JSON.parse(String(call?.[1]))
}

beforeEach(() => {
  vi.resetAllMocks()
  dependencies.start.mockReturnValue({ validate: dependencies.validate, convertVisible: dependencies.convertVisible, stop: dependencies.stop })
  dependencies.validate.mockResolvedValue(undefined)
  dependencies.stop.mockResolvedValue(undefined)
  dependencies.writeFile.mockResolvedValue(undefined)
  dependencies.scrollChatToTop.mockResolvedValue(frame)
  dependencies.preprocessWechatVoices.mockResolvedValue({ ...zeroStats(), scannedPages: 1 })
})

describe('微信语音预处理与采集衔接', () => {
  it('验证原生目标成功后才允许定位和扫描', async () => {
    let finishValidation!: () => void
    dependencies.validate.mockReturnValue(new Promise<void>((resolve) => { finishValidation = resolve }))
    const { preparation } = setup()
    const pending = preparation.prepare()
    expect(dependencies.start).toHaveBeenCalledTimes(1)
    expect(dependencies.scrollChatToTop).not.toHaveBeenCalled()
    expect(dependencies.preprocessWechatVoices).not.toHaveBeenCalled()
    finishValidation()
    expect(await pending).toEqual({ ...zeroStats(), scannedPages: 1 })
    expect(dependencies.scrollChatToTop).toHaveBeenCalledTimes(1)
    expect(dependencies.preprocessWechatVoices).toHaveBeenCalledTimes(1)
    expect(dependencies.stop).toHaveBeenCalledTimes(1)
    expect(report()).toMatchObject({ status: 'complete', passes: 1, scannedPages: 1 })
  })

  it('发生转写后回顶再检查，直到完整一轮没有新增转写', async () => {
    const passes = [
      { scannedPages: 3, converted: 2, alreadyConverted: 1, failed: 0 },
      { scannedPages: 4, converted: 1, alreadyConverted: 4, failed: 0 },
      { scannedPages: 4, converted: 0, alreadyConverted: 6, failed: 0 }
    ]
    const order: string[] = []
    dependencies.scrollChatToTop.mockImplementation(async () => { order.push('top'); return frame })
    dependencies.preprocessWechatVoices.mockImplementation(async (options: WechatVoicePreprocessorOptions<VoiceScanFrame>) => {
      order.push('scan')
      const result = passes.shift()!
      options.onProgress?.(result)
      return result
    })
    const { preparation } = setup()
    expect(await preparation.prepare()).toEqual({ scannedPages: 11, converted: 3, alreadyConverted: 11, failed: 0 })
    expect(order).toEqual(['top', 'scan', 'top', 'scan', 'top', 'scan'])
    expect(report()).toMatchObject({ status: 'complete', passes: 3, scannedPages: 11, converted: 3 })
    expect(dependencies.validate).toHaveBeenCalledTimes(1)
    expect(dependencies.stop).toHaveBeenCalledTimes(1)
  })

  it('本屏连续进度及整轮回执不会重复累加成功数量', async () => {
    dependencies.convertVisible.mockImplementation(async (options: VoiceConversionOptions) => {
      const base = { detected: 2, alreadyConverted: 0, failed: 0, changed: true, warnings: [] }
      options.onProgress?.({ ...base, converted: 1 })
      options.onProgress?.({ ...base, converted: 2 })
      return { ...base, converted: 2 }
    })
    dependencies.preprocessWechatVoices
      .mockImplementationOnce(async (options: WechatVoicePreprocessorOptions<VoiceScanFrame>) => {
        await options.convertVisible()
        options.onProgress?.({ scannedPages: 1, converted: 2, alreadyConverted: 0, failed: 0 })
        await options.convertVisible()
        const result = { scannedPages: 2, converted: 4, alreadyConverted: 0, failed: 0 }
        options.onProgress?.(result)
        return result
      })
      .mockImplementationOnce(async (options: WechatVoicePreprocessorOptions<VoiceScanFrame>) => {
        const result = { scannedPages: 3, converted: 0, alreadyConverted: 4, failed: 0 }
        options.onProgress?.(result)
        return result
      })
    const { preparation, options } = setup()
    expect(await preparation.prepare()).toEqual({ scannedPages: 5, converted: 4, alreadyConverted: 4, failed: 0 })
    const nativeProgress = options.onProgress.mock.calls.filter(([message]) => String(message).startsWith('正在展开语音文字'))
    expect(nativeProgress.map(([, stats]) => stats.converted)).toEqual([1, 2, 3, 4])
    expect(report()).toMatchObject({ converted: 4, passes: 2 })
  })

  it('本屏中途失败时保留之前轮次与本屏已有的成功及失败进度', async () => {
    dependencies.preprocessWechatVoices
      .mockResolvedValueOnce({ scannedPages: 2, converted: 3, alreadyConverted: 1, failed: 0 })
      .mockImplementationOnce(async (options: WechatVoicePreprocessorOptions<VoiceScanFrame>) => {
        options.onProgress?.({ scannedPages: 1, converted: 2, alreadyConverted: 1, failed: 0 })
        await options.convertVisible()
        throw new Error('unexpected success')
      })
    dependencies.convertVisible.mockImplementation(async (options: VoiceConversionOptions) => {
      options.onProgress?.({ detected: 2, converted: 1, alreadyConverted: 0, failed: 1, changed: true, warnings: [] })
      throw new Error('微信转写超时')
    })
    const { preparation, log } = setup()
    await expect(preparation.prepare()).rejects.toThrow('微信转写超时')
    expect(report()).toMatchObject({ status: 'error', passes: 2, scannedPages: 3, converted: 6, alreadyConverted: 2, failed: 1, error: '微信转写超时' })
    expect(dependencies.stop).toHaveBeenCalledTimes(1)
    expect(log.record).toHaveBeenCalledWith('voice.finished', undefined, expect.objectContaining({ status: 'error', converted: 6, failed: 1 }))
  })

  it('验证失败时不滚动聊天且清理原生进程并写报告', async () => {
    dependencies.validate.mockRejectedValue(new Error('不是微信窗口'))
    const { preparation } = setup()
    await expect(preparation.prepare()).rejects.toThrow('不是微信窗口')
    expect(dependencies.scrollChatToTop).not.toHaveBeenCalled()
    expect(dependencies.preprocessWechatVoices).not.toHaveBeenCalled()
    expect(dependencies.stop).toHaveBeenCalledTimes(1)
    expect(report()).toMatchObject({ status: 'error', passes: 0, error: '不是微信窗口' })
  })

  it('尚未启动即取消时不创建进程但记录停止结果', async () => {
    const { preparation, cancel } = setup()
    cancel()
    expect(await preparation.prepare()).toBeNull()
    expect(dependencies.start).not.toHaveBeenCalled()
    expect(dependencies.scrollChatToTop).not.toHaveBeenCalled()
    expect(report()).toMatchObject({ status: 'stopped', passes: 0 })
  })

  it('扫描返回时已取消则不启动下一轮，即使本轮转写了新语音', async () => {
    const { preparation, cancel } = setup()
    dependencies.preprocessWechatVoices.mockImplementation(async (options: WechatVoicePreprocessorOptions<VoiceScanFrame>) => {
      const stats = { scannedPages: 1, converted: 1, alreadyConverted: 0, failed: 0 }
      options.onProgress?.(stats)
      cancel()
      return stats
    })
    expect(await preparation.prepare()).toBeNull()
    expect(dependencies.scrollChatToTop).toHaveBeenCalledTimes(1)
    expect(dependencies.preprocessWechatVoices).toHaveBeenCalledTimes(1)
    expect(report()).toMatchObject({ status: 'stopped', passes: 1, converted: 1 })
    expect(dependencies.stop).toHaveBeenCalledTimes(1)
  })

  it('主动停止会关闭控制器并把取消期间的原生退出异常视为正常停止', async () => {
    let rejectScan!: (reason: Error) => void
    dependencies.preprocessWechatVoices.mockReturnValue(new Promise((_resolve, reject) => { rejectScan = reject }))
    const { preparation } = setup()
    const pending = preparation.prepare()
    await vi.waitFor(() => expect(dependencies.preprocessWechatVoices).toHaveBeenCalledTimes(1))
    await preparation.stop()
    rejectScan(new Error('原生进程退出'))
    expect(await pending).toBeNull()
    expect(dependencies.stop).toHaveBeenCalled()
    expect(report()).toMatchObject({ status: 'stopped', passes: 1 })
    expect(dependencies.scrollChatToTop).toHaveBeenCalledTimes(1)
  })

  it('八轮仍有新增转写时明确失败并保存累计统计', async () => {
    dependencies.preprocessWechatVoices.mockResolvedValue({ scannedPages: 2, converted: 1, alreadyConverted: 1, failed: 0 })
    const { preparation } = setup()
    await expect(preparation.prepare()).rejects.toThrow('多轮检查后仍有新增语音转写')
    expect(dependencies.scrollChatToTop).toHaveBeenCalledTimes(8)
    expect(dependencies.preprocessWechatVoices).toHaveBeenCalledTimes(8)
    expect(dependencies.stop).toHaveBeenCalledTimes(1)
    expect(report()).toMatchObject({ status: 'error', passes: 8, scannedPages: 16, converted: 8, alreadyConverted: 8 })
  })

  it('定位顶部失败时不扫描且照常结束控制器和写报告', async () => {
    dependencies.scrollChatToTop.mockRejectedValue(new Error('无法确认顶部'))
    const { preparation } = setup()
    await expect(preparation.prepare()).rejects.toThrow('无法确认顶部')
    expect(dependencies.preprocessWechatVoices).not.toHaveBeenCalled()
    expect(dependencies.stop).toHaveBeenCalledTimes(1)
    expect(report()).toMatchObject({ status: 'error', passes: 1, error: '无法确认顶部' })
  })

  it('控制器启动失败仍记录故障，且不会尝试滚动', async () => {
    dependencies.start.mockImplementation(() => { throw new Error('无法启动 PowerShell') })
    const { preparation } = setup()
    await expect(preparation.prepare()).rejects.toThrow('无法启动 PowerShell')
    expect(dependencies.stop).not.toHaveBeenCalled()
    expect(dependencies.scrollChatToTop).not.toHaveBeenCalled()
    expect(report()).toMatchObject({ status: 'error', passes: 0, error: '无法启动 PowerShell' })
  })

  it('控制器清理失败也尝试写报告并保留原始转写错误', async () => {
    dependencies.preprocessWechatVoices.mockRejectedValue(new Error('原始转写失败'))
    dependencies.stop.mockRejectedValue(new Error('临时目录被占用'))
    const { preparation } = setup()
    await expect(preparation.prepare()).rejects.toThrow('原始转写失败')
    expect(report()).toMatchObject({ status: 'error', error: '原始转写失败' })
  })

  it('报告落盘失败仍清理进程并记录日志，不把失败结果当作可截图的成功', async () => {
    dependencies.writeFile.mockRejectedValue(new Error('磁盘已满'))
    const { preparation, log } = setup()
    await expect(preparation.prepare()).rejects.toThrow('磁盘已满')
    expect(dependencies.stop).toHaveBeenCalledTimes(1)
    expect(log.record).toHaveBeenCalledWith('voice.report_failed', undefined, expect.objectContaining({ error: expect.stringContaining('磁盘已满') }))
    expect(log.record).toHaveBeenCalledWith('voice.finished', undefined, expect.any(Object))
  })

  it('报告与转写同时失败时保留原始转写原因', async () => {
    dependencies.preprocessWechatVoices.mockRejectedValue(new Error('微信转换失败'))
    dependencies.writeFile.mockRejectedValue(new Error('磁盘已满'))
    const { preparation, log } = setup()
    await expect(preparation.prepare()).rejects.toThrow('微信转换失败')
    expect(dependencies.stop).toHaveBeenCalledTimes(1)
    expect(log.record).toHaveBeenCalledWith('voice.finished', undefined, expect.objectContaining({ status: 'error', error: '微信转换失败' }))
  })
})
