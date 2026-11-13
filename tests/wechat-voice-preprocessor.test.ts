import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  preprocessWechatVoices,
  type VoiceScanFrame,
  type WechatVoicePreprocessorOptions
} from '../src/main/services/wechat-voice-preprocessor'

function frame(offset = 0, seed = 1): VoiceScanFrame {
  const fingerprintWidth = 12
  const fingerprintHeight = 40
  return {
    width: 120,
    height: 400,
    fingerprintWidth,
    fingerprintHeight,
    fingerprint: Uint8Array.from({ length: fingerprintWidth * fingerprintHeight }, (_, index) => {
      const row = Math.floor(index / fingerprintWidth) + offset
      const column = index % fingerprintWidth
      return (row * 73 + row * row * 11 + column * 29 + seed * 51) % 256
    })
  }
}

function harness(frames: VoiceScanFrame[] = [frame()]) {
  let index = 0
  const options: WechatVoicePreprocessorOptions<VoiceScanFrame> = {
    capture: vi.fn(async () => frames[Math.min(index++, frames.length - 1)]),
    scroll: vi.fn(async () => undefined),
    convertVisible: vi.fn(async () => ({ converted: 0, alreadyConverted: 0, failed: 0 })),
    isCancelled: vi.fn(() => false),
    onProgress: vi.fn()
  }
  options.settle = vi.fn(async () => ({ frame: await options.capture(), still: true }))
  return options
}

afterEach(() => vi.useRealTimers())

describe('微信语音转写预处理遍历', () => {
  it('确认三次静止才结束，单屏只转换一次', async () => {
    const options = harness()
    options.maxPages = 1
    vi.mocked(options.convertVisible).mockResolvedValue({ converted: 2, alreadyConverted: 1, failed: 0 })
    expect(await preprocessWechatVoices(options)).toEqual({ scannedPages: 1, converted: 2, alreadyConverted: 1, failed: 0 })
    expect(options.convertVisible).toHaveBeenCalledTimes(1)
    expect(options.scroll).toHaveBeenCalledTimes(3)
    expect(vi.mocked(options.scroll).mock.calls).toEqual([[-1], [-1], [-1]])
  })

  it('每次转写完成后重新建立基准，允许文本展开造成完全不同的排版', async () => {
    const original = frame()
    const expanded = frame(0, 2)
    const moved = frame(4, 2)
    const expandedAgain = frame(0, 3)
    const options = harness([original, expanded, moved, expandedAgain])
    vi.mocked(options.convertVisible)
      .mockResolvedValueOnce({ converted: 1, alreadyConverted: 0, failed: 0 })
      .mockResolvedValueOnce({ converted: 2, alreadyConverted: 1, failed: 0 })

    expect(await preprocessWechatVoices(options)).toEqual({ scannedPages: 2, converted: 3, alreadyConverted: 1, failed: 0 })
    expect(options.convertVisible).toHaveBeenCalledTimes(2)
    expect(options.scroll).toHaveBeenCalledTimes(4)
    expect(vi.mocked(options.onProgress!).mock.calls.map(([stats]) => stats.converted)).toEqual([1, 3])
  })

  it('滚动短暂静止后又移动时重置到底确认计数', async () => {
    const first = frame()
    const moved = frame(4)
    const options = harness([first, first, first, moved, moved])
    const result = await preprocessWechatVoices(options)
    expect(result?.scannedPages).toBe(2)
    expect(options.scroll).toHaveBeenCalledTimes(5)
  })

  it('拒绝失去连续性的跳屏，避免跳过未转写语音', async () => {
    const first = frame()
    const options = harness([first, first, frame(28)])
    await expect(preprocessWechatVoices(options)).rejects.toThrow('无法确认连续内容')
    expect(options.convertVisible).toHaveBeenCalledTimes(1)
  })

  it('达到扫描上限但仍能向下移动时明确失败', async () => {
    const first = frame()
    const options = harness([first, first, frame(4)])
    options.maxPages = 1
    await expect(preprocessWechatVoices(options)).rejects.toThrow('尚未确认聊天底部')
    expect(options.convertVisible).toHaveBeenCalledTimes(1)
  })

  it('转写失败会报告统计并停止，不能继续截图', async () => {
    const options = harness()
    vi.mocked(options.convertVisible).mockResolvedValue({ converted: 1, alreadyConverted: 0, failed: 2 })
    await expect(preprocessWechatVoices(options)).rejects.toThrow('2 条语音未能确认转写完成')
    expect(options.scroll).not.toHaveBeenCalled()
    expect(options.onProgress).toHaveBeenCalledWith({ scannedPages: 1, converted: 1, alreadyConverted: 0, failed: 2 })
  })

  it('画面不稳时不执行右击或滚动', async () => {
    const options = harness()
    vi.mocked(options.settle!).mockResolvedValue({ frame: frame(), still: false })
    await expect(preprocessWechatVoices(options)).rejects.toThrow('等待画面稳定超时')
    expect(options.convertVisible).not.toHaveBeenCalled()
    expect(options.scroll).not.toHaveBeenCalled()
  })

  it('窗口尺寸变化会停止，不混用两种截图坐标', async () => {
    const first = frame()
    const resized = { ...first, width: 240 }
    const options = harness([first, resized])
    await expect(preprocessWechatVoices(options)).rejects.toThrow('窗口尺寸发生变化')
    expect(options.scroll).not.toHaveBeenCalled()
  })

  it('已取消的任务不会触碰原生控制器', async () => {
    const options = harness()
    options.isCancelled = () => true
    expect(await preprocessWechatVoices(options)).toBeNull()
    expect(options.capture).not.toHaveBeenCalled()
    expect(options.convertVisible).not.toHaveBeenCalled()
    expect(options.scroll).not.toHaveBeenCalled()
  })

  it('转写中取消后直接返回，原生退出异常不会变成截图错误', async () => {
    const options = harness()
    let cancelled = false
    options.isCancelled = () => cancelled
    options.convertVisible = vi.fn(async () => {
      cancelled = true
      throw new Error('controller stopped')
    })
    expect(await preprocessWechatVoices(options)).toBeNull()
    expect(options.scroll).not.toHaveBeenCalled()
  })

  it('滚动期间取消后不会再截图或转写', async () => {
    const options = harness()
    let cancelled = false
    options.isCancelled = () => cancelled
    options.scroll = vi.fn(async () => { cancelled = true })
    expect(await preprocessWechatVoices(options)).toBeNull()
    expect(options.capture).toHaveBeenCalledTimes(2)
    expect(options.convertVisible).toHaveBeenCalledTimes(1)
  })

  it('未提供视频流判稳时连续确认两个静止间隔', async () => {
    vi.useFakeTimers()
    const options = harness()
    delete options.settle
    const result = preprocessWechatVoices(options)
    await vi.runAllTimersAsync()
    expect(await result).toMatchObject({ scannedPages: 1, failed: 0 })
    // 初始、转写后、三次滚动后，各需要三帧。
    expect(options.capture).toHaveBeenCalledTimes(15)
  })

  it('拒绝损坏的指纹和无效计数', async () => {
    const broken = harness([{ ...frame(), fingerprint: new Uint8Array(3) }])
    await expect(preprocessWechatVoices(broken)).rejects.toThrow('有效的聊天画面')
    const invalid = harness()
    vi.mocked(invalid.convertVisible).mockResolvedValue({ converted: Number.NaN, alreadyConverted: 0, failed: 0 })
    await expect(preprocessWechatVoices(invalid)).rejects.toThrow('无效统计')
  })
})
