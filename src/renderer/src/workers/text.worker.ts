import { executeTextOperation, type TextOperation } from '../utils/text-operations'

export interface TextWorkerRequest {
  id: number
  operation: TextOperation
  input: string
}

export interface TextWorkerResponse {
  id: number
  result?: string
  error?: string
}

/**
 * 在独立线程中执行大文本转换，避免阻塞界面绘制。
 */
self.onmessage = (event: MessageEvent<TextWorkerRequest>) => {
  const { id, operation, input } = event.data
  try {
    const result = executeTextOperation(operation, input)
    self.postMessage({ id, result } satisfies TextWorkerResponse)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    self.postMessage({ id, error: message } satisfies TextWorkerResponse)
  }
}
