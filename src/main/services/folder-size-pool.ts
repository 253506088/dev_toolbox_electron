import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { FolderSizeEvent } from '../../shared/electron-api'
import type { FolderScanResult } from './folder-size-scanner'
import { writeLog } from './logger'

interface FolderTask {
  requestId: string
  path: string
  onResult: (event: FolderSizeEvent) => void
}

type WorkerResult = FolderScanResult | { error: string }
interface PendingTask extends FolderTask {
  result?: WorkerResult
  delivered?: boolean
}
interface RequestState {
  items: Array<PendingTask | undefined>
  next: number
  seen: Set<string>
  closed: boolean
}

/** 以固定三并发执行文件夹大小统计，并支持按请求代次取消。 */
export class FolderSizePool {
  private readonly concurrency = 3
  private readonly queue: PendingTask[] = []
  private readonly active = new Map<Worker, PendingTask>()
  private readonly cancelled = new Set<string>()
  private readonly requests = new Map<string, RequestState>()

  /** 把一个目录加入统计队列。 */
  enqueue(task: FolderTask): void {
    if (this.cancelled.has(task.requestId)) return
    const pending = this.addTask(task)
    this.queue.push(pending)
    this.runNext()
  }

  /** 根目录内的硬链接文件与子目录共用同一份去重集合。 */
  enqueueFile(task: FolderTask, result: FolderScanResult): void {
    if (this.cancelled.has(task.requestId)) return
    this.acceptResult(this.addTask(task), result)
  }

  /** 所有目录批次已入队；最后一个结果提交后释放本次导航的文件身份索引。 */
  finishRequest(requestId: string): void {
    const state = this.requests.get(requestId)
    if (!state) return
    state.closed = true
    this.flushResults(requestId)
  }

  private addTask(task: FolderTask): PendingTask {
    let state = this.requests.get(task.requestId)
    if (!state) {
      state = { items: [], next: 0, seen: new Set(), closed: false }
      this.requests.set(task.requestId, state)
    }
    const pending: PendingTask = { ...task }
    state.items.push(pending)
    return pending
  }

  private acceptResult(task: PendingTask, result: WorkerResult): void {
    task.result = result
    // 普通目录和失败结果不涉及共享实体归属，无需等待前面的慢目录。
    if ('error' in result) {
      task.delivered = true
      task.onResult({ requestId: task.requestId, path: task.path, size: null, error: result.error })
    } else if (result.hardlinks.length === 0) {
      task.delivered = true
      task.onResult({ requestId: task.requestId, path: task.path, size: result.size, logicalSize: result.logicalSize, skippedEntries: result.skippedEntries })
    }
    this.flushResults(task.requestId)
  }

  /** 按目录列表顺序归属共享文件，结果不受三个 Worker 的完成顺序影响。 */
  private flushResults(requestId: string): void {
    const state = this.requests.get(requestId)
    if (!state || this.cancelled.has(requestId)) return
    while (state.next < state.items.length) {
      const task = state.items[state.next]
      if (!task?.result) break
      state.items[state.next++] = undefined
      const result = task.result
      if (task.delivered) continue
      if ('error' in result) {
        task.onResult({ requestId, path: task.path, size: null, error: result.error })
        continue
      }
      let size = result.size
      for (const file of result.hardlinks) {
        if (state.seen.has(file.identity)) size -= file.size
        else state.seen.add(file.identity)
      }
      task.onResult({ requestId, path: task.path, size: Math.max(0, size), logicalSize: result.logicalSize, skippedEntries: result.skippedEntries })
    }
    if (state.closed && state.next === state.items.length) this.requests.delete(requestId)
  }

  /** 取消指定导航代次的排队和运行任务。 */
  cancel(requestId: string): void {
    this.cancelled.add(requestId)
    this.requests.delete(requestId)
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      if (this.queue[index].requestId === requestId) this.queue.splice(index, 1)
    }
    for (const [worker, task] of this.active) {
      if (task.requestId === requestId) void worker.terminate()
    }
  }

  /** 在有空闲并发位时启动后续任务。 */
  private runNext(): void {
    while (this.active.size < this.concurrency && this.queue.length > 0) {
      const task = this.queue.shift()
      if (!task || this.cancelled.has(task.requestId)) continue
      this.startWorker(task)
    }
  }

  /** 为一个目录创建独立 Worker，并统一处理成功、失败和退出。 */
  private startWorker(task: PendingTask): void {
    let worker: Worker
    try {
      worker = new Worker(join(__dirname, 'folder-size-worker.js'))
    } catch (error) {
      this.acceptResult(task, { error: error instanceof Error ? error.message : String(error) })
      return
    }
    this.active.set(worker, task)
    let completed = false
    const complete = (result: WorkerResult): void => {
      if (completed) return
      completed = true
      if (!this.cancelled.has(task.requestId)) {
        this.acceptResult(task, result)
      }
    }
    worker.once('message', (message: WorkerResult) => {
      complete(message)
      void worker.terminate()
    })
    worker.once('error', (error) => {
      void writeLog('文件夹统计', `统计失败：${task.path}`, error)
      complete({ error: error instanceof Error ? error.message : String(error) })
    })
    worker.once('exit', (code) => {
      this.active.delete(worker)
      if (!completed) complete({ error: `统计线程未返回结果，退出码：${code}` })
      this.runNext()
    })
    try {
      worker.postMessage({ path: task.path })
    } catch (error) {
      complete({ error: error instanceof Error ? error.message : String(error) })
      void worker.terminate()
    }
  }
}
