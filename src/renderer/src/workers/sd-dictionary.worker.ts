interface DictionaryEntry {
  key: string
  value: string
}

let entries: DictionaryEntry[] = []

/** 用合并后的词典重建搜索数组。 */
function initialize(dictionary: Record<string, string>): void {
  entries = Object.entries(dictionary).map(([key, value]) => ({ key, value }))
}

/** 中英文搜索并按精确、前缀、包含三个等级返回前 50 条。 */
function search(query: string): DictionaryEntry[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return []
  const exact: DictionaryEntry[] = []
  const prefix: DictionaryEntry[] = []
  const contains: DictionaryEntry[] = []
  for (const entry of entries) {
    const english = entry.key.toLowerCase()
    const chinese = entry.value.toLowerCase()
    if (english === normalized || chinese === normalized) exact.push(entry)
    else if (prefix.length < 50 && (english.startsWith(normalized) || chinese.startsWith(normalized))) prefix.push(entry)
    else if (contains.length < 50 && (english.includes(normalized) || chinese.includes(normalized))) contains.push(entry)
  }
  return [...exact, ...prefix, ...contains].slice(0, 50)
}

/** 接收初始化和搜索请求。 */
self.onmessage = (event: MessageEvent<{ id: number; type: 'init' | 'search'; dictionary?: Record<string, string>; query?: string }>) => {
  if (event.data.type === 'init') {
    initialize(event.data.dictionary ?? {})
    self.postMessage({ id: event.data.id, count: entries.length })
  } else {
    self.postMessage({ id: event.data.id, results: search(event.data.query ?? '') })
  }
}
