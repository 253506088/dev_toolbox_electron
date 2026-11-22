import { dialog, ipcMain, shell } from 'electron'
import { SUBTITLE_EXTENSIONS, SUBTITLE_VIDEO_EXTENSIONS, type SubtitleBatchRequest } from '../../shared/subtitle-api'
import { SubtitleService } from '../services/subtitle-service'

/** 外挂字幕工具使用独立白名单 IPC，处理路径绑定创建会话的页面。 */
export function registerSubtitleIpc(service: SubtitleService): void {
  ipcMain.handle('subtitle:select-folder', async (event) => {
    const result = await dialog.showOpenDialog({ title: '选择视频和外挂字幕所在的文件夹', properties: ['openDirectory'] })
    return result.canceled || !result.filePaths[0] ? null : service.scanPath(result.filePaths[0], event.sender)
  })
  ipcMain.handle('subtitle:select-video', async (event) => {
    const result = await dialog.showOpenDialog({ title: '选择需要嵌入字幕的视频', properties: ['openFile'], filters: [{ name: '视频', extensions: [...SUBTITLE_VIDEO_EXTENSIONS] }] })
    return result.canceled || !result.filePaths[0] ? null : service.scanPath(result.filePaths[0], event.sender)
  })
  ipcMain.handle('subtitle:scan-path', (event, path: string) => service.scanPath(path, event.sender))
  ipcMain.handle('subtitle:select-subtitle', async (event, scanId: string, rowId: string) => {
    const result = await dialog.showOpenDialog({ title: '选择这个视频的外挂字幕', properties: ['openFile'], filters: [{ name: '字幕', extensions: [...SUBTITLE_EXTENSIONS] }] })
    return result.canceled || !result.filePaths[0] ? null : service.registerSubtitle(scanId, rowId, result.filePaths[0], event.sender)
  })
  ipcMain.handle('subtitle:start', (event, request: SubtitleBatchRequest) => service.start(request, event.sender))
  ipcMain.handle('subtitle:cancel', (event, batchId: string) => service.cancel(batchId, event.sender))
  ipcMain.handle('subtitle:snapshot', (event) => service.snapshot(event.sender))
  ipcMain.handle('subtitle:open-output', async (event, batchId: string) => {
    const error = await shell.openPath(service.outputDirectory(batchId, event.sender))
    if (error) throw new Error(`无法打开输出目录：${error}`)
  })
}
