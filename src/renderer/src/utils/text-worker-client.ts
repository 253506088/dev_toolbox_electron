import TextWorker from '../workers/text.worker?worker'
import { executeTextOperation, type TextOperation } from './text-operations'
import type { TextWorkerResponse } from '../workers/text.worker'

export const LARGE_TEXT_THRESHOLD = 1_000_000

let worker: Worker | undefined
let requestId = 0
const pendingRequests = new Map<
  number,
  { resolve: (value: string) => void; reject: (reason: Error) => void }
>()

/**
 * 根据文本大小选择当前线程或 Worker 执行转换。
 */
export async function runTextOperation(
  operation: TextOperation,
  input: string
): Promise<string> {
  if (input.length < LARGE_TEXT_THRESHOLD) {
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
    pendingRequests.set(id, { resolve, reject })
    activeWorker.postMessage({ id, operation, input })
  })
}

/**
 * 延迟创建 Worker，并统一处理返回结果和异常。
 */
function getWorker(): Worker {
  if (worker) return worker

  worker = new TextWorker()
  worker.onmessage = (event: MessageEvent<TextWorkerResponse>) => {
    const request = pendingRequests.get(event.data.id)
    if (!request) return
    pendingRequests.delete(event.data.id)
    if (event.data.error) {
      request.reject(new Error(event.data.error))
    } else {
      request.resolve(event.data.result ?? '')
    }
  }
  worker.onerror = (event) => {
    const error = new Error(`大文本处理线程异常：${event.message}`)
    pendingRequests.forEach((request) => request.reject(error))
    pendingRequests.clear()
    worker?.terminate()
    worker = undefined
  }
  return worker
}
