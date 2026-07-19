import { ref, type Ref } from 'vue'
import { runTextOperation } from './text-worker-client'
import type { TextOperation } from './text-operations'

export interface OperationState {
  busy: Ref<boolean>
  error: Ref<string>
  run(operation: TextOperation, input: string): Promise<string | undefined>
}

/**
 * 提供文本工具共用的忙碌状态和中文错误处理。
 */
export function useOperationState(): OperationState {
  const busy = ref(false)
  const error = ref('')

  /** 执行转换，失败时保留原文并返回空结果。 */
  async function run(operation: TextOperation, input: string): Promise<string | undefined> {
    if (!input.trim()) return ''
    busy.value = true
    error.value = ''
    try {
      return await runTextOperation(operation, input)
    } catch (reason) {
      error.value = formatOperationError(reason)
      console.error(`文本转换失败，操作：${operation}`, reason)
      return undefined
    } finally {
      busy.value = false
    }
  }

  return { busy, error, run }
}

/**
 * 把底层异常转换成适合界面展示的中文消息。
 */
function formatOperationError(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason)
  if (/JSON|Unexpected token|Expected property|position/i.test(message)) {
    return `内容不是有效的 JSON：${message}`
  }
  if (/base64|character encoding|encoded data|UTF-8/i.test(message)) {
    return `Base64 内容无效或不是 UTF-8 文本：${message}`
  }
  if (/URI malformed/i.test(message)) {
    return 'URL 编码内容不完整，请检查百分号后的十六进制字符。'
  }
  return `处理失败：${message}`
}
