import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { FolderSizeEvent } from '../../shared/electron-api'
import { writeLog } from './logger'

interface FolderTask {
  requestId: string
  path: string
  onResult: (event: FolderSizeEvent) => void
}

/** 以固定三并发执行文件夹大小统计，并支持按请求代次取消。 */
export class FolderSizePool {
  private readonly concurrency = 3
  private readonly queue: FolderTask[] = []
  private readonly active = new Map<Worker, FolderTask>()
  private readonly cancelled = new Set<string>()

  /** 把一个目录加入统计队列。 */
  enqueue(task: FolderTask): void {
    if (this.cancelled.has(task.requestId)) return
    this.queue.push(task)
    this.runNext()
  }

  /** 取消指定导航代次的排队和运行任务。 */
  cancel(requestId: string): void {
    this.cancelled.add(requestId)
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
  private startWorker(task: FolderTask): void {
    const worker = new Worker(join(__dirname, 'folder-size-worker.js'))
    this.active.set(worker, task)
    let completed = false
    worker.once('message', (message: { size?: number; error?: string }) => {
      completed = true
      if (!this.cancelled.has(task.requestId)) {
        task.onResult({ requestId: task.requestId, path: task.path, size: message.size ?? null, error: message.error })
      }
      void worker.terminate()
    })
    worker.once('error', (error) => {
      void writeLog('文件夹统计', `统计失败：${task.path}`, error)
      if (!this.cancelled.has(task.requestId)) {
        task.onResult({
          requestId: task.requestId,
          path: task.path,
          size: null,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    })
    worker.once('exit', (code) => {
      this.active.delete(worker)
      if (!completed && code !== 0 && !this.cancelled.has(task.requestId)) {
        task.onResult({ requestId: task.requestId, path: task.path, size: null, error: `统计线程退出码：${code}` })
      }
      this.runNext()
    })
    worker.postMessage({ path: task.path })
  }
}
