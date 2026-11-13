import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeWorker {
  onmessage?: (event: { data: { id: number; result?: string; error?: string } }) => void
  onerror?: (event: { message: string }) => void
  onmessageerror?: () => void
  postMessage: ReturnType<typeof vi.fn>
  terminate: ReturnType<typeof vi.fn>
}
const mocks = vi.hoisted(() => ({ workers: [] as FakeWorker[] }))
vi.mock('../src/renderer/src/workers/text.worker?worker', () => ({
  default: class {
    onmessage?: FakeWorker['onmessage']
    onerror?: FakeWorker['onerror']
    onmessageerror?: FakeWorker['onmessageerror']
    postMessage = vi.fn()
    terminate = vi.fn()
    constructor() { mocks.workers.push(this) }
  }
}))

describe('SQL 后台转换及 Worker 恢复', () => {
  beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); mocks.workers = [] })
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

  it('短 SQL 也在 Worker 中执行，不占用界面线程', async () => {
    const { runTextOperation } = await import('../src/renderer/src/utils/text-worker-client')
    const pending = runTextOperation('sql-format', 'select #{time}')
    const worker = mocks.workers[0]
    expect(worker.postMessage).toHaveBeenCalledWith({ id: 1, operation: 'sql-format', input: 'select #{time}' })
    worker.onmessage?.({ data: { id: 1, result: 'SELECT #{time}' } })
    expect(await pending).toBe('SELECT #{time}')
    expect(mocks.workers).toHaveLength(1)
  })

  it('语法错误不会损坏 Worker，修正后同一线程可以继续工作', async () => {
    const { runTextOperation } = await import('../src/renderer/src/utils/text-worker-client')
    const invalid = runTextOperation('sql-format', 'select (')
    const rejected = expect(invalid).rejects.toThrow('Unexpected EOF')
    const worker = mocks.workers[0]
    worker.onmessage?.({ data: { id: 1, error: 'Unexpected EOF' } })
    await rejected
    const valid = runTextOperation('sql-format', 'select #{time}')
    worker.onmessage?.({ data: { id: 2, result: 'SELECT #{time}' } })
    expect(await valid).toBe('SELECT #{time}')
    expect(worker.terminate).not.toHaveBeenCalled()
  })

  it('解析超时终止线程并释放任务，下一次操作使用新线程', async () => {
    const { runTextOperation, TEXT_OPERATION_TIMEOUT_MS } = await import('../src/renderer/src/utils/text-worker-client')
    const pending = runTextOperation('sql-format', 'select (')
    const rejected = expect(pending).rejects.toThrow('超时')
    await vi.advanceTimersByTimeAsync(TEXT_OPERATION_TIMEOUT_MS)
    await rejected
    expect(mocks.workers[0].terminate).toHaveBeenCalledOnce()
    const retry = runTextOperation('sql-format', 'select 1')
    expect(mocks.workers).toHaveLength(2)
    mocks.workers[1].onmessage?.({ data: { id: 2, result: 'SELECT 1' } })
    expect(await retry).toBe('SELECT 1')
  })

  it('线程崩溃后允许重建，旧线程的迟到消息不会影响新任务', async () => {
    const { runTextOperation } = await import('../src/renderer/src/utils/text-worker-client')
    const pending = runTextOperation('sql-format', 'select 1')
    const rejected = expect(pending).rejects.toThrow('线程异常')
    const old = mocks.workers[0]
    old.onerror?.({ message: 'worker crashed' })
    await rejected
    const retry = runTextOperation('sql-format', 'select 2')
    old.onmessage?.({ data: { id: 2, result: 'stale' } })
    mocks.workers[1].onmessage?.({ data: { id: 2, result: 'SELECT 2' } })
    expect(await retry).toBe('SELECT 2')
  })
})
