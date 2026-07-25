import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, net, protocol, shell } from 'electron'
import { registerDictionaryIpc } from './ipc/dictionary-ipc'
import { registerFilesIpc } from './ipc/files-ipc'
import { registerMediaIpc } from './ipc/media-ipc'
import { registerNotesIpc } from './ipc/notes-ipc'
import { registerTextIpc } from './ipc/text-ipc'
import { registerUtilityIpc } from './ipc/utility-ipc'
import { registerWechatCaptureIpc } from './ipc/wechat-capture-ipc'
import { registerWechatExportIpc } from './ipc/wechat-export-ipc'
import { DictionaryService } from './services/dictionary-service'
import { FileService } from './services/file-service'
import { FolderSizePool } from './services/folder-size-pool'
import { BatchTaskService } from './services/batch-task-service'
import { FfmpegService } from './services/ffmpeg-service'
import { HolidayService } from './services/holiday-service'
import { NoteService } from './services/note-service'
import { ReminderScheduler } from './services/reminder-scheduler'
import { ImageService } from './services/image-service'
import { MediaSourceService } from './services/media-source-service'
import { WechatCaptureService } from './services/wechat-capture-service'
import { WechatContinuousCaptureService } from './services/wechat-continuous-capture-service'
import { WechatExportService } from './services/wechat-export-service'

protocol.registerSchemesAsPrivileged([
  { scheme: 'note-image', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'media-file', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

let mainWindow: BrowserWindow | null = null
let reminderScheduler: ReminderScheduler | null = null
let batchTasks: BatchTaskService | null = null
let ffmpegService: FfmpegService | null = null
let wechatCapture: WechatCaptureService | null = null
let wechatContinuousCapture: WechatContinuousCaptureService | null = null
let wechatExport: WechatExportService | null = null

/** 创建应用主窗口，并限制网页只能在系统浏览器中打开外部链接。 */
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
  mainWindow = window
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })
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

/** 注册受控便签图片协议，页面无法读取 images 目录以外的文件。 */
function registerNoteImageProtocol(notes: NoteService): void {
  protocol.handle('note-image', (request) => {
    const imageName = decodeURIComponent(new URL(request.url).pathname.replace(/^\//, ''))
    return net.fetch(pathToFileURL(notes.getImagePath(imageName)).toString())
  })
}

/** 初始化服务、IPC、提醒调度器和主窗口。 */
async function bootstrap(): Promise<void> {
  const notes = new NoteService()
  const holidays = new HolidayService()
  const files = new FileService(new FolderSizePool())
  const dictionary = new DictionaryService()
  const mediaSources = new MediaSourceService()
  const images = new ImageService(mediaSources)
  batchTasks = new BatchTaskService()
  ffmpegService = new FfmpegService(mediaSources)
  wechatCapture = new WechatCaptureService()
  wechatContinuousCapture = new WechatContinuousCaptureService()
  wechatExport = new WechatExportService()
  await notes.initialize()
  registerTextIpc()
  registerNotesIpc(notes, holidays)
  registerFilesIpc(files)
  registerUtilityIpc()
  registerDictionaryIpc(dictionary)
  registerMediaIpc(images, batchTasks, ffmpegService)
  registerWechatCaptureIpc(wechatCapture, wechatContinuousCapture)
  registerWechatExportIpc(wechatExport)
  registerNoteImageProtocol(notes)
  mediaSources.registerProtocol()
  createWindow()
  reminderScheduler = new ReminderScheduler(notes, holidays, () => mainWindow)
  reminderScheduler.start()
  console.info('开发者工具箱主进程已启动')
}

app.whenReady().then(() => {
  void bootstrap()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  reminderScheduler?.stop()
  batchTasks?.stopAll()
  ffmpegService?.stopAll()
  wechatCapture?.dispose()
  wechatContinuousCapture?.dispose()
  wechatExport?.dispose()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
