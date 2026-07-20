export interface DictionarySearchResult {
  key: string
  value: string
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
}

/** 封装 SD 词典 Web Worker 的初始化和搜索请求。 */
export class SdDictionaryClient {
  private readonly worker = new Worker(new URL('../workers/sd-dictionary.worker.ts', import.meta.url), { type: 'module' })
  private readonly pending = new Map<number, PendingRequest>()
  private requestId = 0

  /** 创建客户端并接收 Worker 回包。 */
  constructor() {
    this.worker.onmessage = (event: MessageEvent<{ id: number; results?: DictionarySearchResult[]; count?: number }>) => {
      const request = this.pending.get(event.data.id)
      if (!request) return
      this.pending.delete(event.data.id)
      request.resolve(event.data.results ?? event.data.count ?? 0)
    }
    this.worker.onerror = (event) => {
      for (const request of this.pending.values()) request.reject(new Error(event.message))
      this.pending.clear()
    }
  }

  /** 重建 Worker 内搜索索引。 */
  initialize(dictionary: Record<string, string>): Promise<number> {
    return this.send<number>({ type: 'init', dictionary })
  }

  /** 搜索中英文词条。 */
  search(query: string): Promise<DictionarySearchResult[]> {
    return this.send<DictionarySearchResult[]>({ type: 'search', query })
  }

  /** 终止 Worker 并拒绝尚未完成的请求。 */
  dispose(): void {
    this.worker.terminate()
    for (const request of this.pending.values()) request.reject(new Error('SD 词典 Worker 已关闭'))
    this.pending.clear()
  }

  /** 发送带编号请求并等待对应回包。 */
  private send<T>(message: { type: 'init' | 'search'; dictionary?: Record<string, string>; query?: string }): Promise<T> {
    const id = ++this.requestId
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject })
      this.worker.postMessage({ id, ...message })
    })
  }
}
