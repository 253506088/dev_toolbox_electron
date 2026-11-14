import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VoiceText } from '../src/shared/wechat-voice'

const native = vi.hoisted(() => ({
  commands: [] as Array<Record<string, unknown>>,
  respond: (_command: Record<string, unknown>): Record<string, unknown> | undefined => ({}),
  exits: 0
}))

vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events')
  return { spawn: vi.fn(() => {
    const child = new EventEmitter() as any
    child.stdout = new EventEmitter()
    child.stdout.setEncoding = (): void => undefined
    child.stderr = new EventEmitter()
    child.stderr.setEncoding = (): void => undefined
    child.stdin = new EventEmitter()
    child.exitCode = null
    child.killed = false
    child.kill = (): void => { child.killed = true; child.exitCode = 0; native.exits += 1; child.emit('exit', 0) }
    child.stdin.write = (input: string, callback?: (error?: Error) => void): boolean => {
      const command = JSON.parse(input)
      native.commands.push(command)
      queueMicrotask(() => {
        callback?.()
        if (command.command === 'quit') { child.exitCode = 0; native.exits += 1; child.emit('exit', 0); return }
        const reply = native.respond(command)
        if (reply !== undefined) child.stdout.emit('data', 'VOICE ' + JSON.stringify(reply) + '\n')
      })
      return true
    }
    return child
  }) }
})

import { WechatVoiceController } from '../src/main/services/wechat-voice-controller'

const controllers: WechatVoiceController[] = []
const text = (value: string, y: number, id?: string): VoiceText => ({ text: value, x: 100, y, width: 80, height: 20, id })
const snapshot = (words: VoiceText[], hash = 'before', elements: VoiceText[] = []): Record<string, unknown> => ({
  words, elements, hash, ocrAvailable: true, crop: { x: 0, y: 0, width: 800, height: 600 }
})
const start = (): WechatVoiceController => {
  const controller = WechatVoiceController.start('window:123:0', { left: 0, top: 0, right: 0, bottom: 0 })
  controllers.push(controller)
  return controller
}

describe.skipIf(process.platform !== 'win32')('微信语音控制流程（原生协议模拟）', () => {
  beforeEach(() => {
    native.commands = []
    native.exits = 0
    native.respond = () => ({})
  })
  afterEach(async () => {
    await Promise.all(controllers.splice(0).map((controller) => controller.stop()))
    vi.useRealTimers()
  })

  it('疑似时长没有语音菜单时关闭菜单，绝不左击其他操作', async () => {
    native.respond = (command) => command.command === 'snapshot'
      ? snapshot([text('3″', 100)]) : command.command === 'open' ? { action: 'none' } : {}
    const result = await start().convertVisible({ isCancelled: () => false })
    expect(result.converted).toBe(0)
    expect(result.warnings).toHaveLength(1)
    expect(native.commands.map((command) => command.command)).not.toContain('select')
    expect(native.commands.map((command) => command.command)).toContain('close')
  })

  it('每次展开后重新定位下一条语音，等待新增文字稳定后才计入成功', async () => {
    vi.useFakeTimers()
    let converted = 0
    native.respond = (command) => {
      if (command.command === 'snapshot') {
        const secondY = converted ? 340 : 240
        const elements = [text('[语音]3秒', 100, 'one'), text('[语音]7秒', secondY, 'two')]
        const words = [text('3″', 100), text('7″', secondY)]
        if (converted >= 1) words.push(text('第一条转写文本', 150))
        if (converted >= 2) words.push(text('第二条转写文本', 390))
        return snapshot(words, `frame-${converted}`, elements)
      }
      if (command.command === 'open') return { action: 'transcribe' }
      if (command.command === 'select') converted += 1
      return {}
    }
    const pending = start().convertVisible({ isCancelled: () => false })
    await vi.advanceTimersByTimeAsync(4000)
    expect((await pending).converted).toBe(2)
    expect(native.commands.filter((command) => command.command === 'open').map((command) => command.y)).toEqual([110, 350])
  })

  it('已展开的语音只检查菜单并关闭，不重复触发转换', async () => {
    native.respond = (command) => command.command === 'snapshot'
      ? snapshot([text('3″', 100)]) : command.command === 'open' ? { action: 'expanded' } : {}
    const controller = start()
    expect((await controller.convertVisible({ isCancelled: () => false })).alreadyConverted).toBe(1)
    expect((await controller.convertVisible({ isCancelled: () => false })).alreadyConverted).toBe(1)
    expect(native.commands.filter((command) => command.command === 'open')).toHaveLength(2)
    expect(native.commands.some((command) => command.command === 'select')).toBe(false)
  })

  it('当前屏没有语音时只读取一次，不打开右键菜单', async () => {
    native.respond = (command) => command.command === 'snapshot'
      ? snapshot([text('普通文字消息', 100)]) : {}
    const result = await start().convertVisible({ isCancelled: () => false })
    expect(result).toMatchObject({ detected: 0, converted: 0, alreadyConverted: 0, failed: 0 })
    expect(native.commands.map((command) => command.command)).toEqual(['snapshot'])
  })

  it('动态检测转换后新出现的同秒数语音，不用旧坐标点击或漏掉后续消息', async () => {
    vi.useFakeTimers()
    let converted = 0
    native.respond = (command) => {
      if (command.command === 'snapshot') {
        const words = [text('3″', 100)]
        if (converted >= 1) words.push(text('第一条文字', 150), text('3″', 340))
        if (converted >= 2) words.push(text('第二条文字', 390))
        return snapshot(words, `frame-${converted}`)
      }
      if (command.command === 'open') return { action: 'transcribe' }
      if (command.command === 'select') converted += 1
      return {}
    }
    const beforeConvert = vi.fn(async () => undefined)
    const pending = start().convertVisible({ isCancelled: () => false, beforeConvert })
    await vi.advanceTimersByTimeAsync(4000)
    expect(await pending).toMatchObject({ detected: 2, converted: 2, failed: 0 })
    expect(native.commands.filter((command) => command.command === 'open').map((command) => command.y)).toEqual([110, 350])
    expect(beforeConvert).toHaveBeenCalledWith(expect.objectContaining({ seconds: 3, y: 100 }), { x: 0, y: 0, width: 800, height: 600 })
    expect(beforeConvert).toHaveBeenCalledWith(expect.objectContaining({ seconds: 3, y: 340 }), { x: 0, y: 0, width: 800, height: 600 })
  })

  it('长转写把语音挤出屏幕时先恢复本屏锚点，再确认完成', async () => {
    vi.useFakeTimers()
    let selected = false
    let restored = false
    native.respond = (command) => {
      if (command.command === 'snapshot') {
        if (selected && !restored) return snapshot([text('被挤到屏外的语音文字', 300)], 'shifted')
        return snapshot(
          selected ? [text('3″', 100), text('长语音转写文字', 150)] : [text('3″', 100)],
          selected ? 'expanded' : 'before', [text('[语音]3秒', 100, 'voice-one')]
        )
      }
      if (command.command === 'open') return { action: selected ? 'expanded' : 'transcribe' }
      if (command.command === 'select') selected = true
      return {}
    }
    const restoreViewport = vi.fn(async () => { if (selected) restored = true })
    const beforeConvert = vi.fn(async () => {
      expect(native.commands.at(-1)?.command).toBe('snapshot')
    })
    const pending = start().convertVisible({ isCancelled: () => false, beforeConvert, restoreViewport })
    await vi.advanceTimersByTimeAsync(2500)
    expect(await pending).toMatchObject({ converted: 1, failed: 0 })
    expect(beforeConvert).toHaveBeenCalledOnce()
    expect(restoreViewport).toHaveBeenCalled()
    expect(native.commands.filter((command) => command.command === 'select')).toHaveLength(1)
  })

  it('准备本屏锚点期间取消时不再打开菜单或选择语音', async () => {
    let cancelled = false
    native.respond = (command) => command.command === 'snapshot' ? snapshot([text('3″', 100)]) : {}
    const result = await start().convertVisible({
      isCancelled: () => cancelled,
      beforeConvert: async () => { cancelled = true }
    })
    expect(result.converted).toBe(0)
    expect(native.commands.map((command) => command.command)).toEqual(['snapshot'])
  })

  it('局部回滚多露出内容时按净位移定位同秒语音，已检查记录随视口移动', async () => {
    vi.useFakeTimers()
    let converted = 0
    let baselineShift = 0
    const totalShift = (): number => converted === 0 ? 0 : converted === 1 ? 60 : 100
    native.respond = (command) => {
      if (command.command === 'snapshot') {
        const offset = totalShift()
        const secondY = (converted ? 340 : 240) + offset
        const words = [text('3″', 100 + offset), text('3″', secondY)]
        if (converted >= 1) words.push(text('第一条转写文字', 150 + offset))
        if (converted >= 2) words.push(text('第二条转写文字', secondY + 50))
        return snapshot(words, `frame-${converted}`)
      }
      if (command.command === 'open') return { action: 'transcribe' }
      if (command.command === 'select') converted += 1
      return {}
    }
    const pending = start().convertVisible({
      isCancelled: () => false,
      beforeConvert: async () => { baselineShift = totalShift() },
      restoreViewport: async () => totalShift() - baselineShift
    })
    await vi.advanceTimersByTimeAsync(4000)
    expect(await pending).toMatchObject({ converted: 2, detected: 2, failed: 0 })
    expect(native.commands.filter((command) => command.command === 'open').map((command) => command.y)).toEqual([110, 410])
    expect(native.commands.filter((command) => command.command === 'select')).toHaveLength(2)
  })

  it('不断变化的候选达到本屏上限后明确停止，避免无限扫描', async () => {
    let snapshots = 0
    native.respond = (command) => command.command === 'snapshot'
      ? snapshot([], `frame-${++snapshots}`, [text('[语音]3秒', 100, `moving-${snapshots}`)])
      : command.command === 'open' ? { action: 'expanded' } : {}
    await expect(start().convertVisible({ isCancelled: () => false })).rejects.toThrow('本屏语音位置持续变化')
    expect(native.commands.filter((command) => command.command === 'open')).toHaveLength(120)
  })

  it('转写文字与已有文字重复时，通过收起文字菜单确认成功', async () => {
    vi.useFakeTimers()
    let selected = false
    native.respond = (command) => {
      if (command.command === 'snapshot') return snapshot(
        [text('3″', 100), text('收到', selected ? 150 : 300)], selected ? 'expanded' : 'before'
      )
      if (command.command === 'open') return { action: selected ? 'expanded' : 'transcribe' }
      if (command.command === 'select') selected = true
      return {}
    }
    const pending = start().convertVisible({ isCancelled: () => false })
    await vi.advanceTimersByTimeAsync(2500)
    expect((await pending).converted).toBe(1)
    expect(native.commands.filter((command) => command.command === 'open')).toHaveLength(2)
    expect(native.commands.filter((command) => command.command === 'select')).toHaveLength(1)
  })

  it('底边语音的文字展开在截图区域外时，通过菜单确认完成而不等待可见新增文字', async () => {
    vi.useFakeTimers()
    let selected = false
    native.respond = (command) => {
      if (command.command === 'snapshot') return snapshot([text('3″', 570)], 'unchanged-crop')
      if (command.command === 'open') return { action: selected ? 'expanded' : 'transcribe' }
      if (command.command === 'select') selected = true
      return {}
    }
    const pending = start().convertVisible({ isCancelled: () => false })
    await vi.advanceTimersByTimeAsync(2500)
    expect(await pending).toMatchObject({ converted: 1, failed: 0 })
    expect(native.commands.filter((command) => command.command === 'select')).toHaveLength(1)
    expect(native.commands.filter((command) => command.command === 'open')).toHaveLength(2)
  })

  it('底边语音画面静止但菜单仍未展开时，不误报转写成功', async () => {
    vi.useFakeTimers()
    native.respond = (command) => command.command === 'snapshot'
      ? snapshot([text('3″', 570)], 'unchanged-crop')
      : command.command === 'open' ? { action: 'transcribe' } : {}
    const pending = start().convertVisible({ isCancelled: () => false, timeoutMs: 3000 })
    const rejected = expect(pending).rejects.toThrow('语音转文字超时')
    await vi.advanceTimersByTimeAsync(3500)
    await rejected
    expect(native.commands.filter((command) => command.command === 'select')).toHaveLength(1)
  })

  it('原生命令无响应会报错，不能被资源清理误判为用户取消', async () => {
    vi.useFakeTimers()
    native.respond = () => undefined
    const controller = start()
    const pending = controller.convertVisible({ isCancelled: () => false })
    const rejected = expect(pending).rejects.toThrow('无响应')
    await vi.advanceTimersByTimeAsync(21_000)
    await rejected
    expect(native.exits).toBe(1)
  })

  it('取消会中断挂起命令，并发stop共享同一个完成promise', async () => {
    vi.useFakeTimers()
    native.respond = () => undefined
    let cancelled = false
    const controller = start()
    const pending = controller.convertVisible({ isCancelled: () => cancelled })
    await vi.advanceTimersByTimeAsync(50)
    cancelled = true
    const firstStop = controller.stop()
    const secondStop = controller.stop()
    expect(firstStop).toBe(secondStop)
    await vi.advanceTimersByTimeAsync(200)
    await Promise.all([firstStop, secondStop])
    expect((await pending).converted).toBe(0)
    expect(native.exits).toBe(1)
  })
})
