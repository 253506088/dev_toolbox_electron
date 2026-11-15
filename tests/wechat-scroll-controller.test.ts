import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  commands: [] as string[],
  respond: (_command: string): string | undefined => 'ready',
  writeError: undefined as Error | undefined,
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
      const command = input.trim()
      native.commands.push(command)
      queueMicrotask(() => {
        callback?.(native.writeError)
        if (native.writeError) return
        if (command === 'quit') { child.exitCode = 0; native.exits += 1; child.emit('exit', 0); return }
        const response = native.respond(command)
        if (response !== undefined) {
          // PowerShell can split a line across separate stdout chunks.
          child.stdout.emit('data', response.slice(0, 2))
          child.stdout.emit('data', response.slice(2) + '\r\n')
        }
      })
      return true
    }
    return child
  }) }
})

import { TargetWindowMinimizedError, WechatScrollController } from '../src/main/services/wechat-scroll-controller'

const controllers: WechatScrollController[] = []
function start(): WechatScrollController {
  const controller = WechatScrollController.start('window:123:0', { left: 10, top: 10, right: 10, bottom: 10 })
  controllers.push(controller)
  return controller
}

describe('原生窗口滚动协议', () => {
  beforeEach(() => {
    native.commands = []
    native.respond = (command) => command === 'status' ? 'ready' : 'ok'
    native.writeError = undefined
    native.exits = 0
  })
  afterEach(async () => {
    await Promise.all(controllers.splice(0).map((controller) => controller.stop()))
    vi.useRealTimers()
  })

  it('只有原生 IsIconic 状态才表示最小化，且保留拆分响应顺序', async () => {
    const controller = start()
    const status = controller.isMinimized()
    const scroll = controller.scroll(-2)
    expect(await status).toBe(false)
    await scroll
    native.respond = () => 'minimized'
    expect(await controller.isMinimized()).toBe(true)
    await expect(controller.scroll(1)).rejects.toBeInstanceOf(TargetWindowMinimizedError)
  })

  it.each([
    ['closed', '已关闭'], ['hidden', '已隐藏'], ['blocked', '未被遮挡'], ['failed', '滚动失败']
  ])('将 %s 与最小化区分，避免无限等待“恢复窗口”', async (status, message) => {
    native.respond = () => status
    const controller = start()
    await expect(controller.isMinimized()).rejects.toThrow(message)
    await expect(controller.scroll(-1)).rejects.toThrow(message)
  })

  it('拒绝非法滚动量，零格不发送原生输入', async () => {
    const controller = start()
    await expect(controller.scroll(Number.NaN)).rejects.toThrow('无效')
    await expect(controller.scroll(Infinity)).rejects.toThrow('无效')
    await expect(controller.scroll(3601)).rejects.toThrow('无效')
    await controller.scroll(0.2)
    expect(native.commands).toEqual([])
  })

  it('命令超时清空队列并停止子进程，后续命令立即报错', async () => {
    vi.useFakeTimers()
    native.respond = () => undefined
    const controller = start()
    const first = expect(controller.isMinimized()).rejects.toThrow('响应超时')
    const second = expect(controller.scroll(-1)).rejects.toThrow('响应超时')
    await vi.advanceTimersByTimeAsync(15_001)
    await Promise.all([first, second])
    expect(native.exits).toBe(1)
    await expect(controller.isMinimized()).rejects.toThrow('响应超时')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('管道写失败同时拒绝所有排队命令，不让回执错配', async () => {
    native.writeError = new Error('broken pipe')
    const controller = start()
    const first = expect(controller.isMinimized()).rejects.toThrow('broken pipe')
    const second = expect(controller.scroll(-1)).rejects.toThrow('broken pipe')
    await Promise.all([first, second])
    await expect(controller.scroll(-1)).rejects.toThrow('broken pipe')
  })

  it('停止时立即释放未完成命令，不等待 15 秒超时', async () => {
    native.respond = () => undefined
    const controller = start()
    const pending = expect(controller.scroll(-1)).rejects.toThrow('已停止')
    await controller.stop()
    await pending
    await expect(controller.isMinimized()).rejects.toThrow('已停止')
  })
})
