/** 提醒类型。 */
export type ReminderType = 'once' | 'dateRange' | 'workday'

/** MD5 支持的文本字符编码。 */
export type Md5Encoding =
  | 'utf8'
  | 'utf16-le'
  | 'utf16-be'
  | 'gb18030'
  | 'gbk'
  | 'big5'
  | 'shift_jis'
  | 'windows-1252'
  | 'iso-8859-1'
  | 'ascii'

/** MD5 工具的编码选项，供界面展示和主进程白名单校验共用。 */
export const MD5_ENCODINGS: ReadonlyArray<{ label: string; value: Md5Encoding }> = [
  { label: 'UTF-8', value: 'utf8' },
  { label: 'UTF-16 LE', value: 'utf16-le' },
  { label: 'UTF-16 BE', value: 'utf16-be' },
  { label: 'GB18030', value: 'gb18030' },
  { label: 'GBK', value: 'gbk' },
  { label: 'Big5', value: 'big5' },
  { label: 'Shift_JIS', value: 'shift_jis' },
  { label: 'Windows-1252', value: 'windows-1252' },
  { label: 'ISO-8859-1', value: 'iso-8859-1' },
  { label: 'ASCII', value: 'ascii' }
]

/** 便签提醒配置。 */
export interface NoteReminder {
  type: ReminderType
  hour: number
  minute: number
  onceDate?: string
  startDate?: string
  endDate?: string
  enabled: boolean
  lastTriggered?: string
}

/** 持久化便签。 */
export interface StickyNote {
  id: string
  content: string
  color: string
  imageNames: string[]
  createdAt: string
  updatedAt: string
  reminder?: NoteReminder
}

/** 新建或更新便签时使用的数据。 */
export interface NoteInput {
  content: string
  imageNames: string[]
  reminder?: NoteReminder
}

/** 月历中的一天。 */
export interface HolidayDay {
  date: string
  isWorkday: boolean
  fromFallback: boolean
}

/** Windows 磁盘信息。 */
export interface DriveInfo {
  path: string
  totalBytes: number
  freeBytes: number
}

/** 文件管理器中的一项。 */
export interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number | null
  modifiedAt: string | null
  sizeState: 'ready' | 'pending' | 'error'
}

/** 目录分批读取事件。 */
export interface DirectoryBatchEvent {
  requestId: string
  path: string
  entries: FileEntry[]
  done: boolean
  error?: string
}

/** 文件夹大小计算事件。 */
export interface FolderSizeEvent {
  requestId: string
  path: string
  size: number | null
  error?: string
}

/** SD 词典当前状态。 */
export interface DictionaryStatus {
  builtInCount: number
  totalCount: number
  updatedAt?: string
  updating: boolean
}

/** SD 词典内容及状态。 */
export interface DictionarySnapshot {
  entries: Record<string, string>
  status: DictionaryStatus
}

/** SD 词典更新进度。 */
export interface DictionaryProgress {
  stage: 'download' | 'parse' | 'validate' | 'save' | 'complete' | 'cancelled' | 'error'
  percent: number | null
  message: string
}

/** 在线翻译结果。 */
export interface TagTranslation {
  key: string
  value: string
}

/** 渲染进程允许调用的安全接口。 */
export interface ElectronApi {
  /** 按指定字符编码计算文本的 32 位小写 MD5。 */
  calculateMd5(text: string, encoding?: Md5Encoding): Promise<string>
  notes: {
    /** 读取全部便签。 */
    list(): Promise<StickyNote[]>
    /** 新建便签。 */
    create(input: NoteInput): Promise<StickyNote>
    /** 更新便签。 */
    update(id: string, input: NoteInput): Promise<StickyNote>
    /** 删除便签。 */
    delete(id: string): Promise<void>
    /** 清空全部便签。 */
    clear(): Promise<void>
    /** 保存便签图片并返回受控文件名。 */
    saveImage(dataUrl: string): Promise<string>
    /** 删除尚未被便签引用的临时图片。 */
    deleteTempImage(imageName: string): Promise<void>
    /** 监听提醒触发事件。 */
    onReminder(callback: (note: StickyNote) => void): () => void
  }
  holiday: {
    /** 读取指定月份的工作日信息。 */
    getMonth(year: number, month: number): Promise<HolidayDay[]>
  }
  files: {
    /** 列出可用 Windows 磁盘。 */
    listDrives(): Promise<DriveInfo[]>
    /** 开始分批读取目录。 */
    listDirectory(path: string, requestId: string): Promise<void>
    /** 取消旧目录的读取和大小计算。 */
    cancel(requestId: string): Promise<void>
    /** 在系统文件管理器中打开目录。 */
    openInExplorer(path: string): Promise<void>
    /** 监听目录批次。 */
    onDirectoryBatch(callback: (event: DirectoryBatchEvent) => void): () => void
    /** 监听文件夹大小。 */
    onFolderSize(callback: (event: FolderSizeEvent) => void): () => void
  }
  clipboard: {
    /** 读取剪贴板图片。 */
    readImage(): Promise<string | null>
    /** 写入剪贴板图片。 */
    writeImage(dataUrl: string): Promise<void>
    /** 写入剪贴板文字。 */
    writeText(text: string): Promise<void>
  }
  dialog: {
    /** 把二进制内容保存到用户选择的位置。 */
    saveBinary(suggestedName: string, bytes: Uint8Array): Promise<boolean>
    /** 选择一张图片并返回数据。 */
    openImage(): Promise<{ name: string; dataUrl: string } | null>
  }
  dictionary: {
    /** 读取合并后的 SD 词典。 */
    load(): Promise<DictionarySnapshot>
    /** 检查并更新 GitHub 词典。 */
    checkAndUpdate(): Promise<DictionarySnapshot>
    /** 取消正在进行的词典更新。 */
    cancelUpdate(): Promise<void>
    /** 在线翻译并保存用户增量词条。 */
    translateAndSave(tag: string): Promise<TagTranslation | null>
    /** 导出用户增量词典。 */
    exportIncremental(): Promise<boolean>
    /** 监听词典更新进度。 */
    onProgress(callback: (progress: DictionaryProgress) => void): () => void
  }
  media: MediaApi
}
import type { MediaApi } from './media-api'
