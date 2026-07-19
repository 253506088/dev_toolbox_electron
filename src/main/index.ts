import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { registerTextIpc } from './ipc/text-ipc'

/**
 * 创建应用主窗口，并限制网页只能在系统浏览器中打开外部链接。
 */
function createWindow(): void {
  const window = new BrowserWindow({
    title: '开发者工具箱',
    width: 1280,
    height: 720,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  window.once('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  console.info('开发者工具箱主进程已启动')
  registerTextIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
