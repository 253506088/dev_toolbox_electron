import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderSizeEvent } from '../../shared/electron-api'
import type { FolderScanResult } from './folder-size-scanner'

const mock = vi.hoisted(() => ({ workers: [] as Array<EventEmitter & { terminate: ReturnType<typeof vi.fn> }> }))
vi.mock('node:worker_threads', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  return { Worker: class extends Emitter {
    terminate = vi.fn(async () => { this.emit('exit', 1); return 1 })
    postMessage = vi.fn()
    constructor() { super(); mock.workers.push(this) }
  } }
})
vi.mock('./logger', () => ({ writeLog: vi.fn(async () => undefined) }))
import { FolderSizePool } from './folder-size-pool'

function result(size: number, identity = 'disk:shared', extra = 0): FolderScanResult {
  return { size: size + extra, logicalSize: size + extra, hardlinks: [{ identity, size }], skippedEntries: 0 }
}

describe('目录统计导航级硬链接去重', () => {
  beforeEach(() => { mock.workers.length = 0 })

  it('跨子目录去重并按入队顺序归属，不依赖并发完成顺序', () => {
    const pool = new FolderSizePool()
    const events: FolderSizeEvent[] = []
    for (const path of ['A', 'B']) pool.enqueue({ requestId: 'scan', path, onResult: (event) => events.push(event) })
    pool.finishRequest('scan')
    mock.workers[1].emit('message', result(100, 'disk:shared', 60))
    expect(events).toEqual([])
    mock.workers[0].emit('message', { ...result(100), logicalSize: 200 })
    expect(events.map((event) => [event.path, event.size, event.logicalSize])).toEqual([['A', 100, 200], ['B', 60, 160]])
  })

  it('根目录硬链接文件也加入同一去重空间，不与子目录重复计数', () => {
    const pool = new FolderSizePool()
    const events: FolderSizeEvent[] = []
    const onResult = (event: FolderSizeEvent): void => { events.push(event) }
    pool.enqueue({ requestId: 'scan', path: 'directory', onResult })
    pool.enqueueFile({ requestId: 'scan', path: 'root.bin', onResult }, result(100))
    pool.finishRequest('scan')
    expect(events).toEqual([])
    mock.workers[0].emit('message', result(100))
    expect(events.map((event) => event.size)).toEqual([100, 0])
    expect(events[1].logicalSize).toBe(100)
  })

  it('没有共享硬链接的目录提前完成后立即展示，不被前面的慢任务阻塞', () => {
    const pool = new FolderSizePool()
    const events: FolderSizeEvent[] = []
    for (const path of ['slow', 'fast']) pool.enqueue({ requestId: 'scan', path, onResult: (event) => events.push(event) })
    pool.finishRequest('scan')
    mock.workers[1].emit('message', { size: 7, logicalSize: 7, hardlinks: [], skippedEntries: 0 })
    expect(events.map((event) => event.path)).toEqual(['fast'])
    mock.workers[0].emit('message', result(100))
    expect(events.map((event) => event.path)).toEqual(['fast', 'slow'])
    expect(events.reduce((sum, event) => sum + (event.size ?? 0), 0)).toBe(107)
  })

  it('每次导航独立统计，两个目录各自打开时都显示其完整内容', () => {
    const pool = new FolderSizePool()
    const events: FolderSizeEvent[] = []
    for (const requestId of ['first', 'second']) {
      pool.enqueueFile({ requestId, path: 'shared.bin', onResult: (event) => events.push(event) }, result(100))
      pool.finishRequest(requestId)
    }
    expect(events.map((event) => event.size)).toEqual([100, 100])
  })

  it('部分读取状态保留已统计数值；其他卷上的相同编号不会相互扣除', () => {
    const pool = new FolderSizePool()
    const events: FolderSizeEvent[] = []
    const onResult = (event: FolderSizeEvent): void => { events.push(event) }
    pool.enqueueFile({ requestId: 'scan', path: 'A', onResult }, { ...result(100, 'one:9'), skippedEntries: 3 })
    pool.enqueueFile({ requestId: 'scan', path: 'B', onResult }, result(200, 'two:9'))
    pool.finishRequest('scan')
    expect(events.map((event) => event.size)).toEqual([100, 200])
    expect(events[0].skippedEntries).toBe(3)
  })

  it('线程error与exit只报告一次，并继续释放并发位处理后续任务', () => {
    const pool = new FolderSizePool()
    const events: FolderSizeEvent[] = []
    for (const path of ['A', 'B', 'C', 'D']) pool.enqueue({ requestId: 'scan', path, onResult: (event) => events.push(event) })
    expect(mock.workers).toHaveLength(3)
    mock.workers[0].emit('error', new Error('read denied'))
    mock.workers[0].emit('exit', 1)
    expect(events).toHaveLength(1)
    expect(events[0].error).toBe('read denied')
    expect(mock.workers).toHaveLength(4)
    mock.workers[1].emit('exit', 0)
    expect(events).toHaveLength(2)
    expect(events[1].error).toContain('未返回结果')
    pool.cancel('scan')
  })

  it('取消会丢弃排队与晚到结果，新导航仍能运行', () => {
    const pool = new FolderSizePool()
    const events: FolderSizeEvent[] = []
    for (const path of ['A', 'B', 'C', 'D']) pool.enqueue({ requestId: 'old', path, onResult: (event) => events.push(event) })
    pool.cancel('old')
    mock.workers[0].emit('message', result(100))
    expect(events).toEqual([])
    expect(mock.workers).toHaveLength(3)
    pool.enqueue({ requestId: 'new', path: 'E', onResult: (event) => events.push(event) })
    mock.workers[3].emit('message', result(100))
    pool.finishRequest('new')
    expect(events.map((event) => event.requestId)).toEqual(['new'])
  })
})
