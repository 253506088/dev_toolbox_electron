import { dialog, ipcMain, shell } from 'electron'
import type { WechatMarkdownToPdfRequest, WechatOcrDirectoryRequest, WechatSlimImagesRequest } from '../../shared/wechat-export'
import type { WechatExportService } from '../services/wechat-export-service'

/** 注册微信截图后处理接口：MD 转 PDF、图片瘦身、PDF OCR。 */
export function registerWechatExportIpc(service: WechatExportService): void {
  ipcMain.handle('wechat-export:pick-markdown', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择截图 Markdown',
      filters: [{ name: 'Markdown', extensions: ['md'] }],
      properties: ['openFile']
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })
  ipcMain.handle('wechat-export:pick-pdf', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择 PDF 文件',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      properties: ['openFile']
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })
  ipcMain.handle('wechat-export:pick-directory', async () => {
    const result = await dialog.showOpenDialog({ title: '选择图片目录', properties: ['openDirectory'] })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })
  ipcMain.handle('wechat-export:markdown-to-pdf', (event, request: WechatMarkdownToPdfRequest) =>
    service.markdownToPdf(request, event.sender)
  )
  ipcMain.handle('wechat-export:slim-images', (event, request: WechatSlimImagesRequest) =>
    service.slimImages(request, event.sender)
  )
  ipcMain.handle('wechat-export:ocr-begin', (event, pdfPath: string) => service.ocrBegin(pdfPath, event.sender))
  ipcMain.handle('wechat-export:ocr-directory', (event, request: WechatOcrDirectoryRequest) =>
    service.ocrDirectoryStart(request, event.sender)
  )
  ipcMain.handle('wechat-export:ocr-page', (event, sessionId: string, pageIndex: number, png: Uint8Array) =>
    service.ocrPage(sessionId, pageIndex, png, event.sender)
  )
  ipcMain.handle('wechat-export:ocr-finish', (event, sessionId: string) => service.ocrFinish(sessionId, event.sender))
  ipcMain.handle('wechat-export:ocr-cancel', (_event, sessionId: string) => service.ocrCancel(sessionId))
  ipcMain.handle('wechat-export:reveal-path', async (_event, path: string) => {
    if (typeof path !== 'string' || !path.trim()) throw new Error('路径无效')
    shell.showItemInFolder(path)
  })
}
