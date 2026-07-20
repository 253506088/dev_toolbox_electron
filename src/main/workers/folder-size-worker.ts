import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { parentPort } from 'node:worker_threads'

/** 递归统计目录大小，跳过符号链接以避免循环。 */
async function calculateDirectorySize(directoryPath: string): Promise<number> {
  let total = 0
  const entries = await readdir(directoryPath, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = join(directoryPath, entry.name)
    try {
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) total += await calculateDirectorySize(entryPath)
      else total += (await lstat(entryPath)).size
    } catch {
      // 无权限或读取期间被删除的项目只跳过，不中断整个目录统计。
    }
  }
  return total
}

/** 接收一个目录任务并把结果返回主进程。 */
async function handleTask(message: { path: string }): Promise<void> {
  try {
    const size = await calculateDirectorySize(message.path)
    parentPort?.postMessage({ size })
  } catch (error) {
    parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}

parentPort?.once('message', (message: { path: string }) => void handleTask(message))
