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
