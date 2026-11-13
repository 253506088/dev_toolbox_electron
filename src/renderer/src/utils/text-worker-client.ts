import TextWorker from '../workers/text.worker?worker'
import { executeTextOperation, type TextOperation } from './text-operations'
import type { TextWorkerResponse } from '../workers/text.worker'

export const LARGE_TEXT_THRESHOLD = 1_000_000
export const TEXT_OPERATION_TIMEOUT_MS = 30_000

let worker: Worker | undefined
let requestId = 0
const pendingRequests = new Map<
  number,
  { resolve: (value: string) => void; reject: (reason: Error) => void; worker: Worker; timer: ReturnType<typeof setTimeout> }
>()

/**
 * 根据文本大小选择当前线程或 Worker 执行转换。
 */
export async function runTextOperation(
  operation: TextOperation,
  input: string
): Promise<string> {
  // SQL parsing can be expensive even for a short malformed statement. Keep it off the UI thread.
  if (operation !== 'sql-format' && input.length < LARGE_TEXT_THRESHOLD) {
    return executeTextOperation(operation, input)
  }
  return runInWorker(operation, input)
}

/**
 * 把大文本任务发送给复用的 Worker，并等待对应结果。
 */
function runInWorker(operation: TextOperation, input: string): Promise<string> {
  const activeWorker = getWorker()
  const id = ++requestId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => failWorker(activeWorker, new Error('文本处理超时，原文已保留；请检查语法或缩小内容后重试。')), TEXT_OPERATION_TIMEOUT_MS)
    pendingRequests.set(id, { resolve, reject, worker: activeWorker, timer })
    try {
      activeWorker.postMessage({ id, operation, input })
    } catch (error) {
      clearTimeout(timer)
      pendingRequests.delete(id)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

/**
 * 延迟创建 Worker，并统一处理返回结果和异常。
 */
function getWorker(): Worker {
  if (worker) return worker

  const activeWorker = new TextWorker()
  worker = activeWorker
  activeWorker.onmessage = (event: MessageEvent<TextWorkerResponse>) => {
    const request = pendingRequests.get(event.data.id)
    if (!request || request.worker !== activeWorker) return
    clearTimeout(request.timer)
    pendingRequests.delete(event.data.id)
    if (event.data.error) {
      request.reject(new Error(event.data.error))
    } else {
      request.resolve(event.data.result ?? '')
    }
  }
  activeWorker.onerror = (event) => {
    const error = new Error(`大文本处理线程异常：${event.message}`)
    failWorker(activeWorker, error)
  }
  activeWorker.onmessageerror = () => failWorker(activeWorker, new Error('文本处理线程返回了无效数据，请重试。'))
  return activeWorker
}

function failWorker(target: Worker, error: Error): void {
  target.terminate()
  if (worker === target) worker = undefined
  for (const [id, request] of pendingRequests) {
    if (request.worker !== target) continue
    clearTimeout(request.timer)
    pendingRequests.delete(id)
    request.reject(error)
  }
}
