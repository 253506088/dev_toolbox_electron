import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { app } from 'electron'
import { join } from 'node:path'

const MAX_LOG_BYTES = 5 * 1024 * 1024

/** 写入带时间和模块名的中文日志，单文件超过 5MB 时轮换。 */
export async function writeLog(moduleName: string, message: string, error?: unknown): Promise<void> {
  const logDirectory = join(app.getPath('userData'), 'logs')
  const logPath = join(logDirectory, 'app.log')
  try {
    await mkdir(logDirectory, { recursive: true })
    await rotateLogIfNeeded(logPath)
    const detail = error instanceof Error ? `\n${error.stack ?? error.message}` : error ? `\n${String(error)}` : ''
    await appendFile(logPath, `${new Date().toISOString()} [${moduleName}] ${message}${detail}\n`, 'utf8')
  } catch (reason) {
    console.error(`写入中文日志失败，模块：${moduleName}`, reason)
  }
}

/** 日志达到阈值时保留一份上一周期日志。 */
async function rotateLogIfNeeded(logPath: string): Promise<void> {
  try {
    const info = await stat(logPath)
    if (info.size >= MAX_LOG_BYTES) await rename(logPath, `${logPath}.1`)
  } catch {
    // 首次运行没有日志文件属于正常情况。
  }
}
