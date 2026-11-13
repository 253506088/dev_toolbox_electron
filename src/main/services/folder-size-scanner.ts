import { lstat, readdir } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import { join } from 'node:path'

/** 仅多链接文件需要在不同统计任务之间交换身份，普通文件无需建立全量索引。 */
export interface HardlinkedFile {
  identity: string
  size: number
}

export interface FolderScanResult {
  /** 本任务内部按文件身份去重后的内容大小。 */
  size: number
  /** 所有文件路径的逻辑大小之和，保留原始口径供界面对照。 */
  logicalSize: number
  hardlinks: HardlinkedFile[]
  skippedEntries: number
}

export function fileSizeResult(info: BigIntStats): FolderScanResult {
  if (!info.isFile() || info.isSymbolicLink()) return emptyResult()
  const size = Number(info.size)
  return {
    size,
    logicalSize: size,
    hardlinks: info.nlink > 1n && info.ino !== 0n
      ? [{ identity: `${info.dev}:${info.ino}`, size }]
      : [],
    skippedEntries: 0
  }
}

/**
 * 累计文件内容大小；符号链接和联接点不跟随，同一硬链接文件只计一次。
 * inode 必须使用 bigint：NTFS 的 64 位文件编号转为 number 会丢失精度。
 * 无法读取的子项会显式计数，调用方可显示“部分结果”。
 */
export async function calculateDirectorySize(directoryPath: string): Promise<FolderScanResult> {
  const root = await lstat(directoryPath, { bigint: true })
  if (root.isSymbolicLink()) return emptyResult()
  if (!root.isDirectory()) throw new Error('统计目标不是文件夹')
  const result = emptyResult()
  const seen = new Set<string>()
  const directories = [directoryPath]
  while (directories.length) {
    const directory = directories.pop()!
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (directory === directoryPath) throw error
      result.skippedEntries += 1
      continue
    }
    for (const entry of entries) {
      const entryPath = join(directory, entry.name)
      try {
        // lstat 再确认一次类型，避免枚举后目录被替换为联接点而越出统计范围。
        const info = await lstat(entryPath, { bigint: true })
        if (info.isSymbolicLink()) continue
        if (info.isDirectory()) {
          directories.push(entryPath)
          continue
        }
        if (!info.isFile()) continue
        const file = fileSizeResult(info)
        result.logicalSize += file.logicalSize
        const hardlink = file.hardlinks[0]
        if (hardlink) {
          if (seen.has(hardlink.identity)) continue
          seen.add(hardlink.identity)
          result.hardlinks.push(hardlink)
        }
        result.size += file.size
      } catch {
        result.skippedEntries += 1
      }
    }
  }
  return result
}

function emptyResult(): FolderScanResult {
  return { size: 0, logicalSize: 0, hardlinks: [], skippedEntries: 0 }
}
