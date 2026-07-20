import { readFile, writeFile } from 'node:fs/promises'
import { clipboard, dialog, ipcMain, nativeImage } from 'electron'
import { extname } from 'node:path'

/** 注册剪贴板和受控文件对话框接口。 */
export function registerUtilityIpc(): void {
  ipcMain.handle('clipboard:read-image', () => {
    const image = clipboard.readImage()
    return image.isEmpty() ? null : image.toDataURL()
  })
  ipcMain.handle('clipboard:write-image', (_event, dataUrl: string) => {
    const image = nativeImage.createFromDataURL(dataUrl)
    if (image.isEmpty()) throw new Error('要复制的图片无效')
    clipboard.writeImage(image)
  })
  ipcMain.handle('clipboard:write-text', (_event, text: string) => clipboard.writeText(text))
  ipcMain.handle('dialog:save-binary', async (_event, suggestedName: string, bytes: Uint8Array) => {
    const result = await dialog.showSaveDialog({ defaultPath: suggestedName })
    if (result.canceled || !result.filePath) return false
    await writeFile(result.filePath, Buffer.from(bytes))
    return true
  })
  ipcMain.handle('dialog:open-image', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const filePath = result.filePaths[0]
    const bytes = await readFile(filePath)
    const extension = extname(filePath).toLowerCase()
    const mime = extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : `image/${extension.slice(1)}`
    return { name: filePath.split(/[\\/]/).pop() ?? '图片', dataUrl: `data:${mime};base64,${bytes.toString('base64')}` }
  })
}
