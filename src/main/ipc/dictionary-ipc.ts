import { ipcMain } from 'electron'
import { DictionaryService } from '../services/dictionary-service'

/** 注册 SD 词典读取、更新、翻译与导出接口。 */
export function registerDictionaryIpc(dictionary: DictionaryService): void {
  ipcMain.handle('dictionary:load', () => dictionary.load())
  ipcMain.handle('dictionary:check-and-update', (event) => dictionary.checkAndUpdate(event.sender))
  ipcMain.handle('dictionary:cancel-update', () => dictionary.cancelUpdate())
  ipcMain.handle('dictionary:translate-and-save', (_event, tag: string) => dictionary.translateAndSave(tag))
  ipcMain.handle('dictionary:export-incremental', () => dictionary.exportIncremental())
}
