import { ipcMain } from 'electron'
import type { NoteInput } from '../../shared/electron-api'
import { HolidayService } from '../services/holiday-service'
import { NoteService } from '../services/note-service'

/** 注册便签图片、便签 CRUD 和节假日接口。 */
export function registerNotesIpc(notes: NoteService, holidays: HolidayService): void {
  ipcMain.handle('notes:list', () => notes.list())
  ipcMain.handle('notes:create', (_event, input: NoteInput) => notes.create(input))
  ipcMain.handle('notes:update', (_event, id: string, input: NoteInput) => notes.update(id, input))
  ipcMain.handle('notes:delete', (_event, id: string) => notes.delete(id))
  ipcMain.handle('notes:clear', () => notes.clear())
  ipcMain.handle('notes:save-image', (_event, dataUrl: string) => notes.saveImage(dataUrl))
  ipcMain.handle('notes:delete-temp-image', (_event, imageName: string) => notes.deleteTempImage(imageName))
  ipcMain.handle('holiday:get-month', (_event, year: number, month: number) => holidays.getMonth(year, month))
}
