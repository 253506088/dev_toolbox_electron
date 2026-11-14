import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaptureTimingLog } from '../src/main/services/capture-timing-log'
import type { VoiceConversionOptions, VoiceConversionProgress } from '../src/main/services/wechat-voice-controller'
import type { VoiceScanFrame } from '../src/main/services/wechat-voice-viewport'

const dependencies = vi.hoisted(() => ({
  start: vi.fn(), validate: vi.fn(), convertVisible: vi.fn(), stop: vi.fn(),
  waitForStillFrame: vi.fn(), writeFile: vi.fn()
}))
vi.mock('node:fs/promises', () => ({ writeFile: dependencies.writeFile }))
vi.mock('../src/main/services/wechat-voice-controller', () => ({ WechatVoiceController: { start: dependencies.start } }))
vi.mock('../src/main/services/wechat-scroll-controller', () => ({ waitForStillFrame: dependencies.waitForStillFrame }))
import { WechatVoicePreparation } from '../src/main/services/wechat-voice-preparation'

const result = (converted = 0, alreadyConverted = 0, failed = 0): VoiceConversionProgress => ({
  detected: converted + alreadyConverted + failed, converted, alreadyConverted, failed,
  changed: converted > 0, warnings: []
})
function makeFrame(seed = 1): VoiceScanFrame {
  const fingerprint = new Uint8Array(64 * 100).fill(245)
  for (let row = 10; row < 16; row += 1) {
    for (let column = 0; column < 64; column += 1) fingerprint[row * 64 + column] = (row * 31 + column * 73 + seed * 59) % 256
  }
  return { fingerprint, width: 640, height: 1000, fingerprintWidth: 64, fingerprintHeight: 100 }
}
function setup(frame = makeFrame()) {
  let cancelled = false
  const log = { measure: vi.fn(async (_event: string, action: () => Promise<unknown>) => action()), record: vi.fn() }
  const options = {
    sourceId: 'window:123:0', crop: { left: 30, top: 10, right: 2, bottom: 20 },
    outputDirectory: 'D:/capture-output', capture: vi.fn(async () => frame),
    scroll: vi.fn(async (_notches: number) => undefined), isCancelled: () => cancelled, onProgress: vi.fn(),
    log: log as unknown as CaptureTimingLog
  }
  return { frame, preparation: new WechatVoicePreparation(options), options, log, cancel: () => { cancelled = true } }
}
function report(): Record<string, unknown> {
  const call = dependencies.writeFile.mock.calls.at(-1)
  expect(call?.[0]).toMatch(/voice-conversion-report\.json$/)
  expect(call?.[2]).toBe('utf8')
  return JSON.parse(String(call?.[1]))
}
const candidate = { text: '3″', x: 100, y: 500, width: 80, height: 100, seconds: 3, source: 'ocr' as const }
const viewport = { x: 0, y: 0, width: 640, height: 1000 }
beforeEach(() => {
  vi.resetAllMocks()
  dependencies.start.mockReturnValue({ validate: dependencies.validate, convertVisible: dependencies.convertVisible, stop: dependencies.stop })
  dependencies.validate.mockResolvedValue(undefined)
  dependencies.convertVisible.mockResolvedValue(result())
  dependencies.stop.mockResolvedValue(undefined)
  dependencies.writeFile.mockResolvedValue(undefined)
  dependencies.waitForStillFrame.mockImplementation(async (capture: () => Promise<VoiceScanFrame>) => ({ frame: await capture(), still: true, samples: 2 }))
})

describe('微信语音按当前截图视口处理', () => {
  it('先验证目标，再只检查当前屏；无语音时不滚动、不提前结束控制器', async () => {
    let finishValidation!: () => void
    dependencies.validate.mockReturnValue(new Promise<void>((resolve) => { finishValidation = resolve }))
    const { preparation, options, frame } = setup()
    const pending = preparation.prepare(frame)
    expect(dependencies.start).toHaveBeenCalledOnce()
    expect(dependencies.convertVisible).not.toHaveBeenCalled()
    finishValidation()
    expect(await pending).toBe(frame)
    expect(options.scroll).not.toHaveBeenCalled()
    expect(dependencies.convertVisible).toHaveBeenCalledOnce()
    expect(dependencies.stop).not.toHaveBeenCalled()
    await preparation.finish('complete')
    expect(dependencies.stop).toHaveBeenCalledOnce()
    expect(report()).toMatchObject({ mode: 'per-viewport', status: 'complete', scannedPages: 1, converted: 0 })
    expect(report()).not.toHaveProperty('passes')
  })
  it('连续底部静止帧跳过重复扫描，新画面复用同一控制器', async () => {
    const { preparation, options, frame } = setup()
    await preparation.prepare(frame)
    await preparation.prepare({ ...frame, fingerprint: frame.fingerprint.slice() })
    const next = makeFrame(2)
    options.capture.mockResolvedValue(next)
    await preparation.prepare(next)
    expect(dependencies.start).toHaveBeenCalledOnce()
    expect(dependencies.validate).toHaveBeenCalledOnce()
    expect(dependencies.convertVisible).toHaveBeenCalledTimes(2)
    await preparation.finish('complete')
    expect(report()).toMatchObject({ scannedPages: 2 })
  })
  it('本屏增量进度与最终回执只累计一次，跨屏数量连续', async () => {
    dependencies.convertVisible.mockImplementation(async (options: VoiceConversionOptions) => {
      options.onProgress?.(result(1, 1))
      options.onProgress?.(result(2, 1))
      return result(2, 1)
    })
    const { preparation, options, frame } = setup()
    await preparation.prepare(frame)
    const next = makeFrame(2)
    options.capture.mockResolvedValue(next)
    await preparation.prepare(next)
    await preparation.finish('complete')
    expect(report()).toMatchObject({ scannedPages: 2, converted: 4, alreadyConverted: 2, failed: 0 })
    const updates = options.onProgress.mock.calls.filter(([message]) => String(message).startsWith('正在处理本屏语音'))
    expect(updates.map(([, stats]) => stats.converted)).toEqual([1, 2, 3, 4])
  })
  it('转写中途失败保留之前成功数量，结束时清理并报告原始错误', async () => {
    dependencies.convertVisible.mockImplementation(async (options: VoiceConversionOptions) => {
      options.onProgress?.(result(1, 0, 1))
      throw new Error('微信转写超时')
    })
    const { preparation, frame } = setup()
    await expect(preparation.prepare(frame)).rejects.toThrow('微信转写超时')
    await preparation.finish('error', '微信转写超时')
    expect(dependencies.stop).toHaveBeenCalledOnce()
    expect(report()).toMatchObject({ status: 'error', scannedPages: 1, converted: 1, failed: 1, error: '微信转写超时' })
  })
  it('返回未确认转换或无效统计时不交付截图帧', async () => {
    dependencies.convertVisible.mockResolvedValueOnce(result(0, 0, 1))
    const first = setup()
    await expect(first.preparation.prepare(first.frame)).rejects.toThrow('未确认转写完成')
    dependencies.convertVisible.mockResolvedValueOnce(result(-1))
    const second = setup()
    await expect(second.preparation.prepare(second.frame)).rejects.toThrow('无效统计')
  })
  it('尚未开始即取消时不创建控制器，可写停止报告', async () => {
    const { preparation, frame, cancel } = setup()
    cancel()
    expect(await preparation.prepare(frame)).toBeNull()
    await preparation.finish('stopped')
    expect(dependencies.start).not.toHaveBeenCalled()
    expect(report()).toMatchObject({ status: 'stopped', scannedPages: 0 })
  })
  it('停止中的原生退出被当作取消，取消后不采集准备结果', async () => {
    let rejectScan!: (error: Error) => void
    dependencies.convertVisible.mockReturnValue(new Promise((_resolve, reject) => { rejectScan = reject }))
    const { preparation, frame } = setup()
    const pending = preparation.prepare(frame)
    await vi.waitFor(() => expect(dependencies.convertVisible).toHaveBeenCalledOnce())
    await preparation.stop()
    rejectScan(new Error('原生进程退出'))
    expect(await pending).toBeNull()
    await preparation.finish('stopped')
    expect(report()).toMatchObject({ status: 'stopped', scannedPages: 1 })
  })
  it('等待稳定超时或窗口尺寸改变时拒绝交付画面', async () => {
    const first = setup()
    dependencies.waitForStillFrame.mockResolvedValueOnce({ frame: first.frame, still: false, samples: 12 })
    await expect(first.preparation.prepare(first.frame)).rejects.toThrow('画面仍在变化')
    const second = setup()
    dependencies.waitForStillFrame.mockResolvedValueOnce({ frame: { ...second.frame, width: 800 }, still: true, samples: 2 })
    await expect(second.preparation.prepare(second.frame)).rejects.toThrow('尺寸发生变化')
  })
  it('已有已处理帧时也检查尺寸，不让相同指纹绕过窗口尺寸验证', async () => {
    const { preparation, frame } = setup()
    await preparation.prepare(frame)
    await expect(preparation.prepare({ ...frame, width: 800 })).rejects.toThrow('尺寸发生变化')
  })
  it('展开挤走顶部锚点时只回滚当前屏，找到原起点立即继续', async () => {
    const { preparation, options, frame } = setup()
    const moved = { ...frame, fingerprint: new Uint8Array(frame.fingerprint.length).fill(245) }
    options.capture.mockResolvedValueOnce(frame).mockResolvedValueOnce(moved).mockResolvedValue(frame)
    dependencies.convertVisible.mockImplementation(async (voiceOptions: VoiceConversionOptions) => {
      await voiceOptions.beforeConvert?.(candidate, viewport)
      await voiceOptions.restoreViewport?.()
      return result(1)
    })
    expect(await preparation.prepare(frame)).toBe(frame)
    expect(options.scroll.mock.calls).toEqual([[1]])
    expect(options.onProgress.mock.calls.some(([message]) => String(message).includes('恢复本屏起点'))).toBe(true)
  })
  it('本屏锚点无法恢复时有严格回滚上限', async () => {
    const { preparation, options, frame } = setup()
    let reads = 0
    options.capture.mockImplementation(async () => {
      if (reads++ === 0) return frame
      return { ...frame, fingerprint: new Uint8Array(frame.fingerprint.length).fill(reads % 2 ? 180 : 240) }
    })
    dependencies.convertVisible.mockImplementation(async (voiceOptions: VoiceConversionOptions) => {
      await voiceOptions.beforeConvert?.(candidate, viewport)
      await voiceOptions.restoreViewport?.()
      return result(1)
    })
    await expect(preparation.prepare(frame)).rejects.toThrow('超出本屏恢复范围')
    expect(options.scroll).toHaveBeenCalledTimes(40)
    expect(options.scroll.mock.calls.every(([notches]) => notches === 1)).toBe(true)
  })
  it('每条转换返回相对位移，首屏裁切量保留相对原始视口的总位移', async () => {
    const { preparation, options, frame } = setup()
    const translated = (rows: number): VoiceScanFrame => {
      const fingerprint = new Uint8Array(frame.fingerprint.length).fill(245)
      fingerprint.set(frame.fingerprint.subarray(0, (100 - rows) * 64), rows * 64)
      return { ...frame, fingerprint }
    }
    const shiftedTwice = translated(2)
    const shiftedFive = translated(5)
    options.capture.mockResolvedValueOnce(frame).mockResolvedValueOnce(shiftedTwice)
      .mockResolvedValueOnce(shiftedTwice).mockResolvedValue(shiftedFive)
    dependencies.convertVisible.mockImplementation(async (voiceOptions: VoiceConversionOptions) => {
      await voiceOptions.beforeConvert?.(candidate, viewport)
      expect(await voiceOptions.restoreViewport?.()).toBe(20)
      await voiceOptions.beforeConvert?.({ ...candidate, y: 700 }, viewport)
      expect(await voiceOptions.restoreViewport?.()).toBe(30)
      return result(2)
    })
    expect(await preparation.prepare(frame)).toBe(shiftedFive)
    expect(preparation.topInset).toBe(50)
    expect(options.scroll).not.toHaveBeenCalled()
  })
  it('无法再滚动且锚点丢失时立即报错，不空转至上限', async () => {
    const { preparation, options, frame } = setup()
    const moved = { ...frame, fingerprint: new Uint8Array(frame.fingerprint.length).fill(245) }
    options.capture.mockResolvedValueOnce(frame).mockResolvedValue(moved)
    dependencies.convertVisible.mockImplementation(async (voiceOptions: VoiceConversionOptions) => {
      await voiceOptions.beforeConvert?.(candidate, viewport)
      await voiceOptions.restoreViewport?.()
      return result(1)
    })
    await expect(preparation.prepare(frame)).rejects.toThrow('无法恢复本屏起点')
    expect(options.scroll).toHaveBeenCalledOnce()
  })
  it('最后判稳期间起点被延迟动画挤出画面时拒绝交付，避免默认为零裁切丢失内容', async () => {
    const { preparation, frame } = setup()
    const moved = { ...frame, fingerprint: new Uint8Array(frame.fingerprint.length).fill(245) }
    dependencies.convertVisible.mockImplementation(async (voiceOptions: VoiceConversionOptions) => {
      await voiceOptions.beforeConvert?.(candidate, viewport)
      return result(1)
    })
    dependencies.waitForStillFrame.mockResolvedValueOnce({ frame: moved, still: true, samples: 2 })
    await expect(preparation.prepare(frame)).rejects.toThrow('本屏起点再次移动')
  })
  it('下一条语音前丢失初始锚点时拒绝沿用旧坐标继续处理', async () => {
    const { preparation, options, frame } = setup()
    const moved = { ...frame, fingerprint: new Uint8Array(frame.fingerprint.length).fill(245) }
    options.capture.mockResolvedValueOnce(frame).mockResolvedValue(moved)
    dependencies.convertVisible.mockImplementation(async (voiceOptions: VoiceConversionOptions) => {
      await voiceOptions.beforeConvert?.(candidate, viewport)
      await voiceOptions.beforeConvert?.({ ...candidate, y: 700 }, viewport)
      return result(1)
    })
    await expect(preparation.prepare(frame)).rejects.toThrow('语音检查期间发生变化')
  })
  it('多次结束共享一次清理和报告写入', async () => {
    const { preparation, frame } = setup()
    await preparation.prepare(frame)
    const first = preparation.finish('complete')
    const second = preparation.finish('complete')
    expect(first).toBe(second)
    await first
    expect(dependencies.stop).toHaveBeenCalledOnce()
    expect(dependencies.writeFile).toHaveBeenCalledOnce()
  })
  it('验证失败时不滚动，结束报告包含原始原因', async () => {
    dependencies.validate.mockRejectedValue(new Error('不是微信窗口'))
    const { preparation, frame, options } = setup()
    await expect(preparation.prepare(frame)).rejects.toThrow('不是微信窗口')
    expect(dependencies.convertVisible).not.toHaveBeenCalled()
    expect(options.scroll).not.toHaveBeenCalled()
    await preparation.finish('error', '不是微信窗口')
    expect(report()).toMatchObject({ status: 'error', scannedPages: 0, error: '不是微信窗口' })
  })
  it('原始转写失败不被清理或写报告失败覆盖', async () => {
    const { preparation, frame, log } = setup()
    dependencies.convertVisible.mockRejectedValue(new Error('原始转写失败'))
    dependencies.stop.mockRejectedValue(new Error('控制器未退出'))
    dependencies.writeFile.mockRejectedValue(new Error('磁盘已满'))
    await expect(preparation.prepare(frame)).rejects.toThrow('原始转写失败')
    await expect(preparation.finish('error', '原始转写失败')).resolves.toBeUndefined()
    expect(log.record).toHaveBeenCalledWith('voice.finished', undefined, expect.objectContaining({ status: 'error', error: '原始转写失败' }))
  })
  it('正常采集后的清理失败会标为错误并返回真实失败', async () => {
    const { preparation, frame } = setup()
    await preparation.prepare(frame)
    dependencies.stop.mockRejectedValue(new Error('控制器未退出'))
    await expect(preparation.finish('complete')).rejects.toThrow('控制器未退出')
    expect(report()).toMatchObject({ status: 'error', error: '控制器未退出' })
  })
})
