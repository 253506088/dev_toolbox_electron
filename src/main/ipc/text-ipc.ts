import { createHash } from 'node:crypto'
import { ipcMain } from 'electron'

/**
 * 注册文本工具所需的主进程接口。
 */
export function registerTextIpc(): void {
  ipcMain.handle('text:md5', (_event, text: string) => {
    console.info(`开始计算 MD5，文本长度：${text.length}`)
    return createHash('md5').update(text, 'utf8').digest('hex')
  })
}
