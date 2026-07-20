import { app, dialog, type WebContents } from 'electron'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type {
  DictionaryProgress,
  DictionarySnapshot,
  TagTranslation
} from '../../shared/electron-api'
import { readJsonFile, writeJsonAtomic } from './file-storage'
import { COMMON_SD_TAGS, mergeCommonTags } from '../../shared/dictionary-parser'
import { writeLog } from './logger'

const DICTIONARY_URL = 'https://raw.githubusercontent.com/Physton/sd-webui-prompt-all-in-one-assets/main/tags/danbooru.zh_CN.csv'

interface DictionaryMetadata {
  etag?: string
  lastModified?: string
  updatedAt?: string
}

/** 管理内置、在线和用户分层词典，并执行 GitHub 条件更新。 */
export class DictionaryService {
  private abortController?: AbortController
  private parseWorker?: Worker

  /** 读取所有层并返回用户最终看到的合并词典。 */
  async load(): Promise<DictionarySnapshot> {
    const builtIn = await this.readDictionary(this.builtInPath)
    const online = await this.readDictionary(this.onlinePath)
    const legacyFull = await this.readDictionary(this.legacyFullPath)
    const incremental = await this.readDictionary(this.incrementalPath)
    const metadata = await readJsonFile<DictionaryMetadata>(this.metadataPath, {})
    const entries = { ...builtIn, ...online, ...COMMON_SD_TAGS, ...legacyFull, ...incremental }
    return {
      entries,
      status: {
        builtInCount: Object.keys(builtIn).length,
        totalCount: Object.keys(entries).length,
        updatedAt: metadata.updatedAt,
        updating: Boolean(this.abortController)
      }
    }
  }

  /** 检查 GitHub 词典，远端变化时解析、校验并原子替换在线基础层。 */
  async checkAndUpdate(sender: WebContents): Promise<DictionarySnapshot> {
    if (this.abortController) throw new Error('词典更新正在进行中')
    this.abortController = new AbortController()
    const metadata = await readJsonFile<DictionaryMetadata>(this.metadataPath, {})
    try {
      this.sendProgress(sender, { stage: 'download', percent: 0, message: '正在连接 GitHub...' })
      const headers: Record<string, string> = {}
      if (metadata.etag) headers['If-None-Match'] = metadata.etag
      if (metadata.lastModified) headers['If-Modified-Since'] = metadata.lastModified
      const response = await fetch(DICTIONARY_URL, { headers, signal: this.abortController.signal })
      if (response.status === 304) {
        this.sendProgress(sender, { stage: 'complete', percent: 100, message: '当前已是最新词典' })
        return await this.load()
      }
      if (!response.ok) throw new Error(`GitHub 返回 HTTP ${response.status}`)
      const csvText = await readResponseText(response, (percent) => {
        this.sendProgress(sender, { stage: 'download', percent, message: '正在下载 GitHub 词典...' })
      })
      this.sendProgress(sender, { stage: 'parse', percent: null, message: '正在解析并校验词典...' })
      const remoteEntries = await this.parseCsv(csvText)
      this.sendProgress(sender, { stage: 'save', percent: 90, message: '正在安全保存新词典...' })
      await writeJsonAtomic(this.onlinePath, mergeCommonTags(remoteEntries))
      const nextMetadata: DictionaryMetadata = {
        etag: response.headers.get('etag') ?? undefined,
        lastModified: response.headers.get('last-modified') ?? undefined,
        updatedAt: new Date().toISOString()
      }
      await writeJsonAtomic(this.metadataPath, nextMetadata)
      await writeLog('SD 词典', `在线词典更新成功，共 ${Object.keys(remoteEntries).length} 条`)
      this.sendProgress(sender, { stage: 'complete', percent: 100, message: '词典更新完成' })
      return await this.load()
    } catch (error) {
      const cancelled = this.abortController?.signal.aborted
      this.sendProgress(sender, {
        stage: cancelled ? 'cancelled' : 'error',
        percent: null,
        message: cancelled ? '已取消更新，继续使用原词典' : `更新失败：${error instanceof Error ? error.message : String(error)}`
      })
      await writeLog('SD 词典', cancelled ? '用户取消词典更新' : '词典更新失败，保留原词典', error)
      if (!cancelled) throw error
      return await this.load()
    } finally {
      this.abortController = undefined
      this.parseWorker = undefined
    }
  }

  /** 中断下载或解析，不触碰原有正式词典。 */
  cancelUpdate(): void {
    this.abortController?.abort()
    if (this.parseWorker) void this.parseWorker.terminate()
  }

  /** 在线翻译生词并原子写入用户增量词典。 */
  async translateAndSave(tag: string): Promise<TagTranslation | null> {
    const source = tag.trim()
    if (!source) return null
    const snapshot = await this.load()
    const directKey = source.toLowerCase()
    if (snapshot.entries[directKey]) return { key: directKey, value: snapshot.entries[directKey] }
    const sourceIsChinese = /[\u3400-\u9fff]/.test(source)
    const targetLanguage = sourceIsChinese ? 'en' : 'zh-CN'
    const translated = await this.translate(source, targetLanguage)
    if (!translated || translated.toLowerCase() === source.toLowerCase()) return null
    const entry: TagTranslation = sourceIsChinese
      ? { key: translated.toLowerCase(), value: source }
      : { key: source.toLowerCase(), value: translated }
    const incremental = await this.readDictionary(this.incrementalPath)
    incremental[entry.key] = entry.value
    await writeJsonAtomic(this.incrementalPath, sortDictionary(incremental))
    await writeLog('SD 词典', `新增用户翻译：${entry.key}`)
    return entry
  }

  /** 弹出保存框导出用户增量词典。 */
  async exportIncremental(): Promise<boolean> {
    const incremental = await this.readDictionary(this.incrementalPath)
    const result = await dialog.showSaveDialog({ defaultPath: 'sd_tags_new.json', filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (result.canceled || !result.filePath) return false
    await writeJsonAtomic(result.filePath, sortDictionary(incremental))
    return true
  }

  /** 返回安装包内置词典路径。 */
  private get builtInPath(): string {
    return app.isPackaged
      ? join(process.resourcesPath, 'data', 'sd_tags.json')
      : join(app.getAppPath(), 'resources', 'data', 'sd_tags.json')
  }

  /** 返回在线基础词典路径。 */
  private get onlinePath(): string {
    return join(app.getPath('userData'), 'sd', 'sd-tags-online.json')
  }

  /** 返回在线更新元数据路径。 */
  private get metadataPath(): string {
    return join(app.getPath('userData'), 'sd', 'metadata.json')
  }

  /** 返回旧版完整词典兼容路径。 */
  private get legacyFullPath(): string {
    return join(app.getPath('documents'), 'sd_tags.json')
  }

  /** 返回用户增量词典兼容路径。 */
  private get incrementalPath(): string {
    return join(app.getPath('documents'), 'sd_tags_new.json')
  }

  /** 宽容读取一个对象型 JSON 词典并规范化键值。 */
  private async readDictionary(filePath: string): Promise<Record<string, string>> {
    const raw = await readJsonFile<Record<string, unknown>>(filePath, {})
    const normalized: Record<string, string> = {}
    for (const [key, value] of Object.entries(raw)) {
      const normalizedKey = key.trim().toLowerCase()
      const normalizedValue = String(value ?? '').trim()
      if (normalizedKey && normalizedValue) normalized[normalizedKey] = normalizedValue
    }
    return normalized
  }

  /** 在独立线程中解析大 CSV，避免卡住主窗口。 */
  private parseCsv(csvText: string): Promise<Record<string, string>> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(join(__dirname, 'dictionary-worker.js'))
      this.parseWorker = worker
      let settled = false
      worker.once('message', (message: { entries?: Record<string, string>; error?: string }) => {
        settled = true
        if (message.error || !message.entries) reject(new Error(message.error ?? '词典解析没有返回结果'))
        else resolve(message.entries)
        void worker.terminate()
      })
      worker.once('error', (error) => {
        settled = true
        reject(error)
      })
      worker.once('exit', (code) => {
        if (!settled) reject(new Error(this.abortController?.signal.aborted ? '词典解析已取消' : `词典解析线程退出码：${code}`))
      })
      worker.postMessage({ csvText })
    })
  }

  /** 调用谷歌免费翻译端点，失败时重试一次。 */
  private async translate(source: string, targetLanguage: string): Promise<string | null> {
    let lastError: unknown
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const url = new URL('https://translate.googleapis.com/translate_a/single')
        url.searchParams.set('client', 'gtx')
        url.searchParams.set('sl', 'auto')
        url.searchParams.set('tl', targetLanguage)
        url.searchParams.set('dt', 't')
        url.searchParams.set('q', source)
        const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
        if (!response.ok) throw new Error(`翻译接口返回 HTTP ${response.status}`)
        const body = (await response.json()) as Array<Array<Array<string>>>
        return body[0]?.map((part) => part[0]).join('').trim() || null
      } catch (error) {
        lastError = error
      }
    }
    await writeLog('SD 翻译', `翻译失败：${source}`, lastError)
    return null
  }

  /** 向仍然存活的页面发送词典进度。 */
  private sendProgress(sender: WebContents, progress: DictionaryProgress): void {
    if (!sender.isDestroyed()) sender.send('dictionary:progress', progress)
  }
}

/** 逐块读取响应正文并报告下载百分比。 */
async function readResponseText(response: Response, onProgress: (percent: number | null) => void): Promise<string> {
  if (!response.body) return await response.text()
  const total = Number(response.headers.get('content-length')) || 0
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.length
    onProgress(total > 0 ? Math.min(80, Math.round((received / total) * 80)) : null)
  }
  const merged = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return new TextDecoder().decode(merged)
}

/** 按键排序词典，便于人工查看和稳定导出。 */
function sortDictionary(dictionary: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(dictionary).sort(([left], [right]) => left.localeCompare(right)))
}
