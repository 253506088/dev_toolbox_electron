import { dialog, ipcMain, shell } from 'electron'
import type { WechatCaptureRequest, WechatContinuousCaptureRequest } from '../../shared/wechat-capture'
import { WechatContinuousCaptureService } from '../services/wechat-continuous-capture-service'
import { WechatCaptureService } from '../services/wechat-capture-service'

/** 注册桌面窗口枚举、输出目录和自动滚动截图接口。 */
export function registerWechatCaptureIpc(service: WechatCaptureService, continuous: WechatContinuousCaptureService): void {
  ipcMain.handle('wechat-capture:list-windows', () => service.listWindows())
  ipcMain.handle('wechat-capture:default-output-directory', () => service.defaultOutputDirectory)
  ipcMain.handle('wechat-capture:select-output-directory', async () => {
    const result = await dialog.showOpenDialog({
      defaultPath: service.defaultOutputDirectory,
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })
  ipcMain.handle('wechat-capture:start', (event, request: WechatCaptureRequest) => service.start(request, event.sender))
  ipcMain.handle('wechat-capture:start-continuous', (event, request: WechatContinuousCaptureRequest) => continuous.start(request, event.sender))
  ipcMain.handle('wechat-capture:stop', () => {
    service.stop()
    continuous.stop()
  })
  ipcMain.handle('wechat-capture:open-output', async (_event, path: string) => {
    if (typeof path !== 'string' || path.trim().length === 0) throw new Error('输出目录无效')
    const error = await shell.openPath(path)
    if (error) throw new Error(error)
  })
}
