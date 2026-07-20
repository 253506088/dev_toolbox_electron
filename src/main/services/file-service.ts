import { readdir, stat, statfs } from 'node:fs/promises'
import { shell, type WebContents } from 'electron'
import { isAbsolute, join, normalize, win32 } from 'node:path'
import type { DirectoryBatchEvent, DriveInfo, FileEntry, FolderSizeEvent } from '../../shared/electron-api'
import { FolderSizePool } from './folder-size-pool'
import { writeLog } from './logger'

const BATCH_SIZE = 500

/** 分批读取目录、统计文件夹大小并管理导航取消。 */
export class FileService {
  private readonly cancelled = new Set<string>()

  /** 创建文件服务。 */
  constructor(private readonly sizePool: FolderSizePool) {}

  /** 逐个检查 A 到 Z 盘并返回容量。 */
  async listDrives(): Promise<DriveInfo[]> {
    const drives: DriveInfo[] = []
    for (let code = 65; code <= 90; code += 1) {
      const path = `${String.fromCharCode(code)}:\\`
      try {
        const info = await statfs(path)
        drives.push({ path, totalBytes: info.blocks * info.bsize, freeBytes: info.bfree * info.bsize })
      } catch {
        // 未挂载盘符是正常情况。
      }
    }
    await writeLog('文件管理器', `发现 ${drives.length} 个可用磁盘`)
    return drives
  }

  /** 按文件夹优先、名称排序后分批推送目录元数据。 */
  async listDirectory(path: string, requestId: string, sender: WebContents): Promise<void> {
    this.cancelled.delete(requestId)
    const safePath = await validateDirectory(path)
    try {
      const directoryEntries = await readdir(safePath, { withFileTypes: true })
      directoryEntries.sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1
        return left.name.localeCompare(right.name, 'zh-CN', { numeric: true, sensitivity: 'base' })
      })
      for (let offset = 0; offset < directoryEntries.length; offset += BATCH_SIZE) {
        if (this.cancelled.has(requestId) || sender.isDestroyed()) return
        const slice = directoryEntries.slice(offset, offset + BATCH_SIZE)
        const entries = await Promise.all(slice.map(async (entry): Promise<FileEntry> => {
          const entryPath = join(safePath, entry.name)
          try {
            const info = await stat(entryPath)
            return {
              name: entry.name,
              path: entryPath,
              isDirectory: entry.isDirectory(),
              size: entry.isDirectory() ? null : info.size,
              modifiedAt: info.mtime.toISOString(),
              sizeState: entry.isDirectory() ? 'pending' : 'ready'
            }
          } catch {
            return {
              name: entry.name,
              path: entryPath,
              isDirectory: entry.isDirectory(),
              size: null,
              modifiedAt: null,
              sizeState: 'error'
            }
          }
        }))
        this.sendBatch(sender, { requestId, path: safePath, entries, done: offset + BATCH_SIZE >= directoryEntries.length })
        for (const entry of entries) {
          if (entry.isDirectory && entry.sizeState === 'pending') {
            this.sizePool.enqueue({
              requestId,
              path: entry.path,
              onResult: (event) => this.sendFolderSize(sender, event)
            })
          }
        }
      }
      if (directoryEntries.length === 0) this.sendBatch(sender, { requestId, path: safePath, entries: [], done: true })
      await writeLog('文件管理器', `目录读取完成：${safePath}，共 ${directoryEntries.length} 项`)
    } catch (error) {
      this.sendBatch(sender, {
        requestId,
        path: safePath,
        entries: [],
        done: true,
        error: error instanceof Error ? error.message : String(error)
      })
      await writeLog('文件管理器', `目录读取失败：${safePath}`, error)
    }
  }

  /** 取消一个导航代次。 */
  cancel(requestId: string): void {
    this.cancelled.add(requestId)
    this.sizePool.cancel(requestId)
  }

  /** 用系统文件管理器打开已经校验的目录。 */
  async openInExplorer(path: string): Promise<void> {
    const safePath = await validateDirectory(path)
    const error = await shell.openPath(safePath)
    if (error) throw new Error(error)
  }

  /** 安全推送目录批次。 */
  private sendBatch(sender: WebContents, event: DirectoryBatchEvent): void {
    if (!sender.isDestroyed() && !this.cancelled.has(event.requestId)) sender.send('files:directory-batch', event)
  }

  /** 安全推送文件夹大小。 */
  private sendFolderSize(sender: WebContents, event: FolderSizeEvent): void {
    if (!sender.isDestroyed() && !this.cancelled.has(event.requestId)) sender.send('files:folder-size', event)
  }
}

/** 校验路径必须是绝对路径且当前为目录。 */
async function validateDirectory(path: string): Promise<string> {
  const normalizedPath = normalize(path.trim())
  if (!isAbsolute(normalizedPath) && !win32.isAbsolute(normalizedPath)) throw new Error('请输入完整目录路径')
  const info = await stat(normalizedPath)
  if (!info.isDirectory()) throw new Error('目标路径不是文件夹')
  return normalizedPath
}
