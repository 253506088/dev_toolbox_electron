import { join } from 'node:path'
import { BrowserWindow, ipcMain, powerSaveBlocker, type IpcMainEvent } from 'electron'
import type {
  CaptureFrameSourceCommand,
  CaptureFrameSourceFrame,
  CaptureFrameSourceOpenRequest,
  CaptureFrameSourceResult,
  CaptureFrameSourceSettleResult
} from '../../shared/capture-frame-source'

const RPC_TIMEOUT_MS = 5000

/** 主进程到隐藏采集页的窄接口；采集页持有视频流，主进程只接收缩略指纹和按需 PNG。 */
export class VideoFrameSourceService {
  private window: BrowserWindow | null = null
  private powerSaveBlockerId: number | null = null
  private readonly pending = new Map<string, {
    resolve: (value: CaptureFrameSourceResult) => void
    reject: (error: Error) => void
    timeout: NodeJS.Timeout
  }>()

  constructor() {
    ipcMain.on('capture-frame-source:result', this.handleResult)
  }

  async open(request: CaptureFrameSourceOpenRequest): Promise<void> {
    await this.ensureWindow()
    try {
      await this.command({ id: crypto.randomUUID(), method: 'open', payload: request })
      if (this.powerSaveBlockerId === null) this.powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension')
    } catch (error) {
      this.stopPowerSaveBlocker()
      throw error
    }
  }

  async fingerprint(): Promise<CaptureFrameSourceFrame> {
    const result = await this.command({ id: crypto.randomUUID(), method: 'fingerprint' })
    return result as CaptureFrameSourceFrame
  }

  async encode(frameId: number): Promise<Buffer> {
    const result = await this.command({ id: crypto.randomUUID(), method: 'encode', payload: { frameId } })
    return Buffer.from(result as Uint8Array)
  }

  async waitForSettle(quietMs: number, maxMs: number): Promise<CaptureFrameSourceSettleResult> {
    const result = await this.command({
      id: crypto.randomUUID(),
      method: 'settle',
      payload: { quietMs, maxMs }
    })
    return result as CaptureFrameSourceSettleResult
  }

  async close(): Promise<void> {
    if (!this.window || this.window.isDestroyed()) {
      this.stopPowerSaveBlocker()
      return
    }
    try {
      await this.command({ id: crypto.randomUUID(), method: 'close' })
    } catch {
      // 销毁窗口仍能可靠停止媒体轨道。
    }
    this.window.destroy()
    this.window = null
    this.stopPowerSaveBlocker()
    this.rejectPending(new Error('视频采集窗口已关闭'))
  }

  dispose(): void {
    ipcMain.removeListener('capture-frame-source:result', this.handleResult)
    if (this.window && !this.window.isDestroyed()) this.window.destroy()
    this.window = null
    this.stopPowerSaveBlocker()
    this.rejectPending(new Error('视频采集服务已释放'))
  }

  private async ensureWindow(): Promise<void> {
    if (this.window && !this.window.isDestroyed()) return
    const window = new BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })
    this.window = window
    window.on('closed', () => {
      if (this.window === window) this.window = null
      this.stopPowerSaveBlocker()
      this.rejectPending(new Error('视频采集窗口意外关闭'))
    })
    if (!process.env.ELECTRON_RENDERER_URL) {
      await window.loadFile(join(__dirname, '../renderer/capture.html'))
      return
    }
    const base = process.env.ELECTRON_RENDERER_URL.endsWith('/')
      ? process.env.ELECTRON_RENDERER_URL
      : `${process.env.ELECTRON_RENDERER_URL}/`
    await window.loadURL(new URL('capture.html', base).toString())
  }

  private async command(command: CaptureFrameSourceCommand): Promise<unknown> {
    if (!this.window || this.window.isDestroyed()) throw new Error('视频采集窗口不可用')
    const result = await new Promise<CaptureFrameSourceResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(command.id)
        reject(new Error(`视频采集命令 ${command.method} 超时`))
      }, RPC_TIMEOUT_MS)
      this.pending.set(command.id, { resolve, reject, timeout })
      this.window!.webContents.send('capture-frame-source:command', command)
    })
    if (!result.ok) throw new Error(result.error)
    return result.value
  }

  private readonly handleResult = (event: IpcMainEvent, result: CaptureFrameSourceResult): void => {
    if (!this.window || event.sender !== this.window.webContents || !result || typeof result.id !== 'string') return
    const pending = this.pending.get(result.id)
    if (!pending) return
    clearTimeout(pending.timeout)
    this.pending.delete(result.id)
    pending.resolve(result)
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private stopPowerSaveBlocker(): void {
    if (this.powerSaveBlockerId === null) return
    if (powerSaveBlocker.isStarted(this.powerSaveBlockerId)) powerSaveBlocker.stop(this.powerSaveBlockerId)
    this.powerSaveBlockerId = null
  }
}
