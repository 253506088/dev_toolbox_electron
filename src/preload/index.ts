import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  DictionaryProgress,
  DirectoryBatchEvent,
  ElectronApi,
  FolderSizeEvent,
  StickyNote
} from '../shared/electron-api'
import type { BatchTaskEvent } from '../shared/batch-task'
import type { MediaJobEvent } from '../shared/media-api'
import type { WechatCaptureEvent } from '../shared/wechat-capture'

/** 订阅一个白名单 IPC 事件，并返回取消订阅函数。 */
function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: ElectronApi = {
  calculateMd5: (text, encoding) => ipcRenderer.invoke('text:md5', text, encoding),
  notes: {
    list: () => ipcRenderer.invoke('notes:list'),
    create: (input) => ipcRenderer.invoke('notes:create', input),
    update: (id, input) => ipcRenderer.invoke('notes:update', id, input),
    delete: (id) => ipcRenderer.invoke('notes:delete', id),
    clear: () => ipcRenderer.invoke('notes:clear'),
    saveImage: (dataUrl) => ipcRenderer.invoke('notes:save-image', dataUrl),
    deleteTempImage: (imageName) => ipcRenderer.invoke('notes:delete-temp-image', imageName),
    onReminder: (callback) => subscribe<StickyNote>('notes:reminder', callback)
  },
  holiday: {
    getMonth: (year, month) => ipcRenderer.invoke('holiday:get-month', year, month)
  },
  files: {
    listDrives: () => ipcRenderer.invoke('files:list-drives'),
    listDirectory: (path, requestId) => ipcRenderer.invoke('files:list-directory', path, requestId),
    cancel: (requestId) => ipcRenderer.invoke('files:cancel', requestId),
    openInExplorer: (path) => ipcRenderer.invoke('files:open-in-explorer', path),
    onDirectoryBatch: (callback) => subscribe<DirectoryBatchEvent>('files:directory-batch', callback),
    onFolderSize: (callback) => subscribe<FolderSizeEvent>('files:folder-size', callback)
  },
  clipboard: {
    readImage: () => ipcRenderer.invoke('clipboard:read-image'),
    writeImage: (dataUrl) => ipcRenderer.invoke('clipboard:write-image', dataUrl),
    writeText: (text) => ipcRenderer.invoke('clipboard:write-text', text)
  },
  dialog: {
    saveBinary: (suggestedName, bytes) => ipcRenderer.invoke('dialog:save-binary', suggestedName, bytes),
    openImage: () => ipcRenderer.invoke('dialog:open-image')
  },
  wechatCapture: {
    listWindows: () => ipcRenderer.invoke('wechat-capture:list-windows'),
    defaultOutputDirectory: () => ipcRenderer.invoke('wechat-capture:default-output-directory'),
    selectOutputDirectory: () => ipcRenderer.invoke('wechat-capture:select-output-directory'),
    start: (request) => ipcRenderer.invoke('wechat-capture:start', request),
    startContinuous: (request) => ipcRenderer.invoke('wechat-capture:start-continuous', request),
    stop: () => ipcRenderer.invoke('wechat-capture:stop'),
    openOutput: (path) => ipcRenderer.invoke('wechat-capture:open-output', path),
    onEvent: (callback) => subscribe<WechatCaptureEvent>('wechat-capture:event', callback)
  },
  dictionary: {
    load: () => ipcRenderer.invoke('dictionary:load'),
    checkAndUpdate: () => ipcRenderer.invoke('dictionary:check-and-update'),
    cancelUpdate: () => ipcRenderer.invoke('dictionary:cancel-update'),
    translateAndSave: (tag) => ipcRenderer.invoke('dictionary:translate-and-save', tag),
    exportIncremental: () => ipcRenderer.invoke('dictionary:export-incremental'),
    onProgress: (callback) => subscribe<DictionaryProgress>('dictionary:progress', callback)
  },
  media: {
    selectImages: (multiple) => ipcRenderer.invoke('media:select-images', multiple),
    selectVideo: () => ipcRenderer.invoke('media:select-video'),
    selectDirectory: () => ipcRenderer.invoke('media:select-directory'),
    selectVideoOutput: (format, suggestedName) => ipcRenderer.invoke('media:select-video-output', format, suggestedName),
    pathForFile: (file) => webUtils.getPathForFile(file as File),
    registerVideo: (path) => ipcRenderer.invoke('media:register-video', path),
    registerImages: (paths) => ipcRenderer.invoke('media:register-images', paths),
    previewResize: (path, options) => ipcRenderer.invoke('media:preview-resize', path, options),
    previewMatting: (path, options) => ipcRenderer.invoke('media:preview-matting', path, options),
    saveDataUrl: (suggestedName, dataUrl) => ipcRenderer.invoke('media:save-data-url', suggestedName, dataUrl),
    ffmpegStatus: () => ipcRenderer.invoke('media:ffmpeg-status'),
    startFrameExtract: (options) => ipcRenderer.invoke('media:start-frame-extract', options),
    startVideoMatting: (options) => ipcRenderer.invoke('media:start-video-matting', options),
    cancelJob: (jobId) => ipcRenderer.invoke('media:cancel-job', jobId),
    startImageBatch: (request) => ipcRenderer.invoke('media:start-image-batch', request),
    cancelBatch: (batchId) => ipcRenderer.invoke('media:cancel-batch', batchId),
    retryBatchItem: (batchId, itemId) => ipcRenderer.invoke('media:retry-batch-item', batchId, itemId),
    onJobEvent: (callback) => subscribe<MediaJobEvent>('media:job-event', callback),
    onBatchEvent: (callback) => subscribe<BatchTaskEvent>('media:batch-event', callback)
  }
}

contextBridge.exposeInMainWorld('electronApi', api)
