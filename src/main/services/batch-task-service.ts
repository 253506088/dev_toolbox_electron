import { randomUUID } from 'node:crypto'
import { access, mkdir } from 'node:fs/promises'
import { cpus } from 'node:os'
import { join, parse } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { WebContents } from 'electron'
import { summarizeBatch, type BatchTaskEvent, type BatchTaskItem, type BatchTaskSnapshot } from '../../shared/batch-task'
import type { StartImageBatchRequest } from '../../shared/media-api'
import { assertImagePath, validateMattingOptions, validateResizeOptions } from './image-service'
import { writeLog } from './logger'

interface BatchContext {
  id: string
  request: StartImageBatchRequest
  owner: WebContents
  items: BatchTaskItem[]
  cancelled: boolean
}

interface ActiveTask {
  batch: BatchContext
  item: BatchTaskItem
  worker: Worker
}

/** 以有限并发执行图片批处理，并提供取消和单项重试。 */
export class BatchTaskService {
  private readonly concurrency = Math.min(4, Math.max(1, cpus().length - 1))
  private readonly batches = new Map<string, BatchContext>()
  private readonly queue: Array<{ batch: BatchContext; item: BatchTaskItem }> = []
  private readonly active = new Map<string, ActiveTask>()

  /** 创建批次、生成不覆盖的输出路径并启动执行。 */
  async start(request: StartImageBatchRequest, owner: WebContents): Promise<BatchTaskSnapshot> {
    await this.validateRequest(request)
    this.pruneFinishedBatches()
    const batchId = randomUUID()
    const reserved = new Set<string>()
    const items: BatchTaskItem[] = []
    for (const inputPath of request.inputPaths) {
      const outputPath = await this.createOutputPath(inputPath, request.outputDirectory, request.kind, reserved)
      items.push({
        id: randomUUID(),
        batchId,
        kind: request.kind,
        inputPath,
        outputPath,
        status: 'queued',
        progress: 0,
        stage: '等待处理'
      })
    }
    const batch: BatchContext = { id: batchId, request: structuredClone(request), owner, items, cancelled: false }
    this.batches.set(batchId, batch)
    this.queue.push(...items.map((item) => ({ batch, item })))
    setImmediate(() => this.runNext())
    return { batchId, items: structuredClone(items), summary: summarizeBatch(batchId, items) }
  }

  /** 取消指定批次中所有等待或运行的任务。 */
  cancel(batchId: string): void {
    const batch = this.batches.get(batchId)
    if (!batch) return
    batch.cancelled = true
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const queued = this.queue[index]
      if (queued.batch.id !== batchId) continue
      this.queue.splice(index, 1)
      this.finishItem(batch, queued.item, 'cancelled', '已取消')
    }
    for (const active of this.active.values()) {
      if (active.batch.id !== batchId) continue
      this.finishItem(batch, active.item, 'cancelled', '已取消')
      void active.worker.terminate()
    }
  }

  /** 把失败或取消的单项重新加入队列。 */
  retry(batchId: string, itemId: string): void {
    const batch = this.batches.get(batchId)
    const item = batch?.items.find((candidate) => candidate.id === itemId)
    if (!batch || !item || (item.status !== 'failed' && item.status !== 'cancelled')) throw new Error('该任务当前不能重试')
    batch.cancelled = false
    item.status = 'queued'
    item.progress = 0
    item.stage = '等待重试'
    delete item.error
    this.queue.push({ batch, item })
    this.emit(batch, item)
    this.runNext()
  }

  /** 终止全部图片任务，用于应用退出清理。 */
  stopAll(): void {
    for (const batch of this.batches.values()) this.cancel(batch.id)
  }

  /** 校验批次参数、输出目录和全部输入文件。 */
  private async validateRequest(request: StartImageBatchRequest): Promise<void> {
    if (!request || (request.kind !== 'image-resize' && request.kind !== 'image-matting')) throw new Error('批量任务类型无效')
    if (!Array.isArray(request.inputPaths) || request.inputPaths.length === 0 || request.inputPaths.length > 1000) throw new Error('每批必须包含 1 到 1000 张图片')
    if (typeof request.outputDirectory !== 'string' || !request.outputDirectory.trim()) throw new Error('请选择输出目录')
    await mkdir(request.outputDirectory, { recursive: true })
    if (request.kind === 'image-resize') {
      if (!request.resize) throw new Error('缺少缩放参数')
      validateResizeOptions(request.resize)
    } else {
      if (!request.matting) throw new Error('缺少抠图参数')
      validateMattingOptions(request.matting)
    }
    await Promise.all(request.inputPaths.map((filePath) => assertImagePath(filePath)))
  }

  /** 为输入文件生成不覆盖已有文件的 PNG 输出路径。 */
  private async createOutputPath(inputPath: string, outputDirectory: string, kind: StartImageBatchRequest['kind'], reserved: Set<string>): Promise<string> {
    const suffix = kind === 'image-resize' ? '缩放' : '抠图'
    const stem = parse(inputPath).name
    let index = 0
    while (true) {
      const name = `${stem}_${suffix}${index === 0 ? '' : `_${index}`}.png`
      const candidate = join(outputDirectory, name)
      const reservationKey = candidate.toLowerCase()
      if (!reserved.has(reservationKey) && !(await pathExists(candidate))) {
        reserved.add(reservationKey)
        return candidate
      }
      index += 1
    }
  }

  /** 有空闲并发位时持续取得后续任务。 */
  private runNext(): void {
    while (this.active.size < this.concurrency && this.queue.length > 0) {
      const next = this.queue.shift()
      if (!next || next.batch.cancelled || next.item.status !== 'queued') continue
      this.startWorker(next.batch, next.item)
    }
  }

  /** 删除已经全部结束的旧批次，避免长时间运行后持续占用内存。 */
  private pruneFinishedBatches(): void {
    for (const [batchId, batch] of this.batches) {
      if (batch.items.every((item) => item.status === 'succeeded' || item.status === 'failed' || item.status === 'cancelled')) this.batches.delete(batchId)
    }
  }

  /** 为单项创建 Worker，并统一处理进度、失败与退出。 */
  private startWorker(batch: BatchContext, item: BatchTaskItem): void {
    const worker = new Worker(join(__dirname, 'image-worker.js'))
    const active: ActiveTask = { batch, item, worker }
    this.active.set(item.id, active)
    item.status = 'running'
    item.progress = 0.02
    item.stage = '启动处理线程'
    this.emit(batch, item)

    worker.on('message', (message: { type: string; progress?: number; stage?: string; error?: string }) => {
      if (item.status !== 'running') return
      if (message.type === 'progress') {
        item.progress = Math.min(1, Math.max(0, message.progress ?? item.progress))
        item.stage = message.stage ?? item.stage
        this.emit(batch, item)
      } else if (message.type === 'completed') {
        this.finishItem(batch, item, 'succeeded', '处理完成')
        void worker.terminate()
      } else if (message.type === 'failed') {
        this.finishItem(batch, item, 'failed', '处理失败', message.error ?? '未知错误')
        void worker.terminate()
      }
    })
    worker.once('error', (error) => {
      void writeLog('图片批处理', `处理失败：${item.inputPath}`, error)
      if (item.status === 'running') this.finishItem(batch, item, 'failed', '处理线程异常', error instanceof Error ? error.message : String(error))
    })
    worker.once('exit', (code) => {
      this.active.delete(item.id)
      if (item.status === 'running') this.finishItem(batch, item, 'failed', '处理线程提前退出', `线程退出码：${code}`)
      this.runNext()
    })
    worker.postMessage({
      operation: item.kind,
      inputPath: item.inputPath,
      outputPath: item.outputPath,
      resize: batch.request.resize,
      matting: batch.request.matting
    })
  }

  /** 设置单项终态并推送最新快照。 */
  private finishItem(batch: BatchContext, item: BatchTaskItem, status: 'succeeded' | 'failed' | 'cancelled', stage: string, error?: string): void {
    item.status = status
    item.progress = status === 'succeeded' ? 1 : item.progress
    item.stage = stage
    item.error = error
    this.emit(batch, item)
  }

  /** 向创建批次的页面推送单项与汇总状态。 */
  private emit(batch: BatchContext, item: BatchTaskItem): void {
    if (batch.owner.isDestroyed()) return
    const event: BatchTaskEvent = {
      batchId: batch.id,
      item: structuredClone(item),
      summary: summarizeBatch(batch.id, batch.items)
    }
    batch.owner.send('media:batch-event', event)
  }
}

/** 判断路径是否已经存在。 */
async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}
