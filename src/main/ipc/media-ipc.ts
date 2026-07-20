import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { dialog, ipcMain } from 'electron'
import { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, type FrameExtractOptions, type ImageMattingOptions, type ImageResizeOptions, type StartImageBatchRequest, type VideoMattingOptions, type VideoOutputFormat } from '../../shared/media-api'
import { BatchTaskService } from '../services/batch-task-service'
import { FfmpegService } from '../services/ffmpeg-service'
import { ImageService } from '../services/image-service'

/** 注册第三期图片、批量任务和视频处理接口。 */
export function registerMediaIpc(images: ImageService, batches: BatchTaskService, ffmpeg: FfmpegService): void {
  ipcMain.handle('media:select-images', async (_event, multiple: boolean) => {
    const result = await dialog.showOpenDialog({
      properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: [{ name: '图片', extensions: [...IMAGE_EXTENSIONS] }]
    })
    if (result.canceled) return []
    return Promise.all(result.filePaths.map((filePath) => images.metadata(filePath)))
  })
  ipcMain.handle('media:select-video', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: '视频', extensions: [...VIDEO_EXTENSIONS] }] })
    if (result.canceled || result.filePaths.length === 0) return null
    return ffmpeg.metadata(result.filePaths[0])
  })
  ipcMain.handle('media:select-directory', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })
  ipcMain.handle('media:select-video-output', async (_event, format: VideoOutputFormat, suggestedName: string) => {
    if (!['webm', 'mov', 'mp4'].includes(format)) throw new Error('输出格式无效')
    const safeName = basename(suggestedName).replace(/[<>:"/\\|?*]/g, '_')
    const result = await dialog.showSaveDialog({ defaultPath: safeName, filters: [{ name: `${format.toUpperCase()} 视频`, extensions: [format] }] })
    return result.canceled || !result.filePath ? null : result.filePath
  })
  ipcMain.handle('media:register-video', (_event, filePath: string) => ffmpeg.metadata(filePath))
  ipcMain.handle('media:register-images', (_event, filePaths: string[]) => {
    if (!Array.isArray(filePaths) || filePaths.length > 1000) throw new Error('图片数量无效')
    return Promise.all(filePaths.map((filePath) => images.metadata(filePath)))
  })
  ipcMain.handle('media:preview-resize', (_event, filePath: string, options: ImageResizeOptions) => images.previewResize(filePath, options))
  ipcMain.handle('media:preview-matting', (_event, filePath: string, options: ImageMattingOptions) => images.previewMatting(filePath, options))
  ipcMain.handle('media:save-data-url', async (_event, suggestedName: string, dataUrl: string) => {
    const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
    if (!match) throw new Error('只允许保存 PNG 图片')
    const result = await dialog.showSaveDialog({ defaultPath: basename(suggestedName), filters: [{ name: 'PNG 图片', extensions: ['png'] }] })
    if (result.canceled || !result.filePath) return false
    await writeFile(result.filePath, Buffer.from(match[1], 'base64'))
    return true
  })
  ipcMain.handle('media:ffmpeg-status', () => ffmpeg.status())
  ipcMain.handle('media:start-frame-extract', (event, options: FrameExtractOptions) => ffmpeg.startFrameExtract(options, event.sender))
  ipcMain.handle('media:start-video-matting', (event, options: VideoMattingOptions) => ffmpeg.startVideoMatting(options, event.sender))
  ipcMain.handle('media:cancel-job', (_event, jobId: string) => ffmpeg.cancel(jobId))
  ipcMain.handle('media:start-image-batch', (event, request: StartImageBatchRequest) => batches.start(request, event.sender))
  ipcMain.handle('media:cancel-batch', (_event, batchId: string) => batches.cancel(batchId))
  ipcMain.handle('media:retry-batch-item', (_event, batchId: string, itemId: string) => batches.retry(batchId, itemId))
}
