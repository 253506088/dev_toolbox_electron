import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  children: [] as any[],
  requests: [] as Array<{ id: number; command: string; handle?: string }>,
  respond: (_request: { id: number; command: string; handle?: string }): unknown => undefined
}))

vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events')
  return { spawn: vi.fn(() => {
    const child = new EventEmitter() as any
    child.stdout = new EventEmitter()
    child.stdout.setEncoding = (): any => child.stdout
    child.stderr = new EventEmitter()
    child.stderr.setEncoding = (): any => child.stderr
    child.stdin = new EventEmitter()
    child.killed = false
    child.kill = (): void => { child.killed = true; child.emit('exit', 0) }
    child.stdin.write = (input: string, callback?: (error?: Error) => void): boolean => {
      const request = JSON.parse(input)
      native.requests.push(request)
      queueMicrotask(() => {
        callback?.()
        const response = native.respond(request)
        if (response === undefined) return
        const line = `WINDOW ${JSON.stringify({ id: request.id, ...response as object })}\r\n`
        child.stdout.emit('data', line.slice(0, 9))
        child.stdout.emit('data', line.slice(9))
      })
      return true
    }
    native.children.push(child)
    return child
  }) }
})

import { NativeWindowCapture } from '../src/main/services/native-window-capture'

const helpers: NativeWindowCapture[] = []
function start(): NativeWindowCapture {
  const helper = new NativeWindowCapture()
  helpers.push(helper)
  return helper
}

describe.skipIf(process.platform !== 'win32')('原生窗口采集协议', () => {
  beforeEach(() => {
    native.children = []
    native.requests = []
    native.respond = (request) => request.command === 'list' ? { windows: [] } : { png: Buffer.from('image').toString('base64') }
  })
  afterEach(() => {
    helpers.splice(0).forEach((helper) => helper.dispose())
    vi.useRealTimers()
  })

  it('空窗口列表与分片PNG响应可复用同一无窗口子进程', async () => {
    const helper = start()
    expect(await helper.list()).toEqual([])
    expect(await helper.capture('window:123:0')).toEqual(Buffer.from('image'))
    expect(native.children).toHaveLength(1)
    expect(native.requests.map((request) => [request.command, request.handle])).toEqual([['list', undefined], ['capture', '123']])
  })

  it('保留原生最小化/遮挡诊断，不返回空图伪装成功', async () => {
    native.respond = () => ({ error: '目标窗口被遮挡' })
    await expect(start().capture('window:123:0')).rejects.toThrow('被遮挡')
    native.respond = () => ({})
    await expect(start().capture('window:123:0')).rejects.toThrow('未返回画面')
  })

  it('非法窗口ID在启动原生进程前就被拒绝', async () => {
    const helper = start()
    await expect(helper.capture('screen:1:0')).rejects.toThrow('无效')
    await expect(helper.capture('window:12;exit:0')).rejects.toThrow('无效')
    expect(native.children).toHaveLength(0)
  })

  it('子进程管道报错拒绝全部请求并允许下一次刷新恢复', async () => {
    native.respond = () => undefined
    const helper = start()
    const first = expect(helper.list()).rejects.toThrow('pipe failure')
    const second = expect(helper.capture('window:123:0')).rejects.toThrow('pipe failure')
    native.children[0].stdin.emit('error', new Error('pipe failure'))
    await Promise.all([first, second])
    expect(native.children[0].killed).toBe(true)
    native.respond = () => ({ windows: [] })
    expect(await helper.list()).toEqual([])
    expect(native.children).toHaveLength(2)
  })

  it('无回执超时结束整个旧会话，不遗留排队Promise', async () => {
    vi.useFakeTimers()
    native.respond = () => undefined
    const helper = start()
    const first = expect(helper.list()).rejects.toThrow('超时')
    const second = expect(helper.capture('window:123:0')).rejects.toThrow('超时')
    await vi.advanceTimersByTimeAsync(15_001)
    await Promise.all([first, second])
    expect(native.children[0].killed).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('旧进程迟到的输出和退出事件不破坏重启后的会话', async () => {
    native.respond = () => undefined
    const helper = start()
    const first = expect(helper.list()).rejects.toThrow('已关闭')
    const old = native.children[0]
    helper.dispose()
    await first
    const pending = helper.list()
    old.stdout.emit('data', 'WINDOW broken old reply\n')
    old.emit('exit', 1)
    const currentId = native.requests.at(-1)!.id
    native.children[1].stdout.emit('data', `WINDOW ${JSON.stringify({ id: currentId, windows: [] })}\n`)
    expect(await pending).toEqual([])
    expect(native.children[1].killed).toBe(false)
  })
})
