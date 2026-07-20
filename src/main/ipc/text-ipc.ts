import { ipcMain } from 'electron'
import { calculateTextMd5 } from '../services/md5-service'

/**
 * 注册文本工具所需的主进程接口。
 */
export function registerTextIpc(): void {
  ipcMain.handle('text:md5', (_event, text: unknown, encoding?: unknown) => {
    console.info(`收到 MD5 计算请求，编码：${String(encoding ?? 'utf8')}`)
    try {
      const result = calculateTextMd5(text, encoding)
      console.info('MD5 计算完成')
      return result
    } catch (error) {
      console.error(`MD5 计算失败：${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
  })
}
