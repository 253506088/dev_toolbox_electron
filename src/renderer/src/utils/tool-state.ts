import { ref, type Ref } from 'vue'
import { runTextOperation } from './text-worker-client'
import type { TextOperation } from './text-operations'

export interface OperationState {
  busy: Ref<boolean>
  error: Ref<string>
  run(operation: TextOperation, input: string, isCurrent?: () => boolean): Promise<string | undefined>
}

/**
 * 提供文本工具共用的忙碌状态和中文错误处理。
 */
export function useOperationState(): OperationState {
  const busy = ref(false)
  const error = ref('')

  /** 执行转换，失败时保留原文并返回空结果。 */
  async function run(operation: TextOperation, input: string, isCurrent: () => boolean = () => true): Promise<string | undefined> {
    if (busy.value) return undefined
    error.value = ''
    if (!input.trim()) return ''
    busy.value = true
    try {
      return await runTextOperation(operation, input)
    } catch (reason) {
      const summary = formatOperationError(reason, operation)
      if (isCurrent()) error.value = summary
      console.error(`文本转换失败，操作：${operation}`, summary)
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
export function formatOperationError(reason: unknown, operation?: TextOperation): string {
  const message = reason instanceof Error ? reason.message : String(reason)
  // sql-formatter can emit tens of thousands of parser-state characters for one missing ')'.
  // Keep a useful line/column summary instead of allowing that diagnostic to consume the page.
  const summary = message.split(/\r?\n/, 1)[0].replace(/\s+/g, ' ').slice(0, 240)
  if (operation?.startsWith('sql-')) return `SQL 处理失败：${summary}。原文已保留，可以修改后重试。`
  if (/JSON|Unexpected token|Expected property|position/i.test(message)) {
    return `内容不是有效的 JSON：${summary}`
  }
  if (/base64|character encoding|encoded data|UTF-8/i.test(message)) {
    return `Base64 内容无效或不是 UTF-8 文本：${summary}`
  }
  if (/URI malformed/i.test(message)) {
    return 'URL 编码内容不完整，请检查百分号后的十六进制字符。'
  }
  return `处理失败：${summary}`
}
