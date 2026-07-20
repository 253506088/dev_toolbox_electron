import { ipcMain } from 'electron'
import { FileService } from '../services/file-service'

/** 注册磁盘、目录读取、取消和系统文件管理器接口。 */
export function registerFilesIpc(files: FileService): void {
  ipcMain.handle('files:list-drives', () => files.listDrives())
  ipcMain.handle('files:list-directory', (event, path: string, requestId: string) =>
    files.listDirectory(path, requestId, event.sender)
  )
  ipcMain.handle('files:cancel', (_event, requestId: string) => files.cancel(requestId))
  ipcMain.handle('files:open-in-explorer', (_event, path: string) => files.openInExplorer(path))
}
