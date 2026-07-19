import { contextBridge, ipcRenderer } from 'electron'
import type { ElectronApi } from '../shared/electron-api'

const api: ElectronApi = {
  /** 通过主进程安全计算 MD5。 */
  calculateMd5: (text) => ipcRenderer.invoke('text:md5', text)
}

contextBridge.exposeInMainWorld('electronApi', api)
