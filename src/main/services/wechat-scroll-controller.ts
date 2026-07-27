import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { normalizedImageDifference } from '../../shared/wechat-capture'
import type { WechatCaptureCrop } from '../../shared/wechat-capture'

/** 判定“画面已停稳”的指纹差异阈值，与顶部判定共用。 */
export const FRAME_STILL_THRESHOLD = 0.0035

export interface ScrollDriver {
  readonly name: string
  scroll(notches: number): Promise<void>
  isMinimized(): Promise<boolean>
  stop(): Promise<void>
}

export function parseWindowHandle(sourceId: string): string | null {
  return /^window:(\d+):/.exec(sourceId)?.[1] ?? null
}

/**
 * 常驻 PowerShell 滚动进程：启动时编译一次 Win32 调用，此后通过
 * `scroll <格数>` 命令握手滚动（正数向上、负数向下），避免逐次 spawn 的开销。
 */
export class WechatScrollController implements ScrollDriver {
  readonly name = 'foreground-wheel'
  private readonly pending: Array<{ resolve: (response: string) => void; reject: (error: Error) => void }> = []
  private outputBuffer = ''
  private errorText = ''
  private failure: Error | null = null

  static start(sourceId: string, crop: WechatCaptureCrop): WechatScrollController {
    const hwnd = parseWindowHandle(sourceId)
    if (!hwnd) throw new Error('无法识别目标窗口句柄')
    const script = persistentScrollScript(hwnd, crop)
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', encoded],
      { windowsHide: true }
    )
    return new WechatScrollController(child)
  }

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.consumeOutput(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.errorText = `${this.errorText}${chunk}`.trim().slice(-500)
    })
    child.once('error', (error) => this.fail(error))
    child.once('exit', (code) => {
      if (code !== 0 && !child.killed) {
        const message = this.errorText.replace(/^#< CLIXML\s*/i, '').trim()
        this.fail(new Error(message || `滚动控制进程退出，退出码 ${code ?? 'unknown'}`))
      } else {
        this.fail(new Error('滚动控制进程已结束'))
      }
    })
  }

  /** 滚动指定格数（1 格 = 120 wheel delta），正数向上、负数向下；等待进程回执后返回。 */
  scroll(notches: number): Promise<void> {
    const amount = Math.trunc(notches)
    return this.command(`scroll ${amount}`).then((response) => {
      if (response === 'minimized') throw new TargetWindowMinimizedError()
      if (response !== 'ok') throw new Error(`滚动控制器返回了未知状态：${response}`)
    })
  }

  async isMinimized(): Promise<boolean> {
    return await this.command('status') === 'minimized'
  }

  private command(command: string): Promise<string> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.child.exitCode !== null || this.child.killed) return Promise.reject(new Error('滚动控制进程未运行'))
    return new Promise<string>((resolve, reject) => {
      const item = { resolve, reject }
      this.pending.push(item)
      this.child.stdin.write(`${command}\n`, (error) => {
        if (!error) return
        const index = this.pending.indexOf(item)
        if (index >= 0) this.pending.splice(index, 1)
        reject(error)
      })
    })
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.killed) return
    this.child.stdin.write('quit\n')
    await Promise.race([
      new Promise<void>((resolve) => this.child.once('exit', () => resolve())),
      delay(500)
    ])
    if (this.child.exitCode === null && !this.child.killed) this.child.kill()
  }

  private consumeOutput(chunk: string): void {
    this.outputBuffer += chunk
    const lines = this.outputBuffer.split(/\r?\n/)
    this.outputBuffer = lines.pop() ?? ''
    for (const line of lines) {
      const response = line.trim()
      if (!['ok', 'ready', 'minimized'].includes(response)) continue
      this.pending.shift()?.resolve(response)
    }
  }

  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    for (const item of this.pending.splice(0)) item.reject(error)
  }
}

export interface StillFrameResult<T> {
  frame: T
  still: boolean
  samples: number
}

/**
 * 短轮询等待滚动动画结束：连续两帧指纹几乎一致即认为停稳。
 * 超时未停稳时返回最新一帧并标记 still=false，由调用方决定如何处理。
 */
export async function waitForStillFrame<T extends { fingerprint: Uint8Array }>(
  capture: () => Promise<T>,
  isCancelled: () => boolean,
  options: { pollDelayMs: number; timeoutMs: number; threshold?: number; initial?: T }
): Promise<StillFrameResult<T>> {
  const threshold = options.threshold ?? FRAME_STILL_THRESHOLD
  let samples = 0
  let previous = options.initial
  if (!previous) {
    previous = await capture()
    samples += 1
  }
  const deadline = Date.now() + options.timeoutMs
  while (!isCancelled() && Date.now() < deadline) {
    await delay(options.pollDelayMs)
    if (isCancelled()) break
    const current = await capture()
    samples += 1
    if (normalizedImageDifference(previous.fingerprint, current.fingerprint) < threshold) {
      return { frame: current, still: true, samples }
    }
    previous = current
  }
  return { frame: previous, still: false, samples }
}

export interface ScrollToTopOptions<T> {
  controller: Pick<ScrollDriver, 'scroll'>
  capture: () => Promise<T>
  isCancelled: () => boolean
  onProgress?: (burst: number) => void
  burstNotches?: number
  confirmRounds?: number
  maxBursts?: number
  pollDelayMs?: number
  settleTimeoutMs?: number
  /** 视频流路径可提供基于合成器重绘信号的低成本判稳。 */
  settle?: () => Promise<StillFrameResult<T>>
}

/**
 * 快速定位内容顶部：大突发向上滚动，短轮询判稳后与上一稳定帧对比；
 * 连续多轮画面不再变化即认定到顶。用户取消时返回 null。
 */
export async function scrollChatToTop<T extends { fingerprint: Uint8Array }>(
  options: ScrollToTopOptions<T>
): Promise<T | null> {
  const burstNotches = options.burstNotches ?? 240
  const confirmRounds = options.confirmRounds ?? 3
  const maxBursts = options.maxBursts ?? 300
  const pollDelayMs = options.pollDelayMs ?? 90
  const settleTimeoutMs = options.settleTimeoutMs ?? 2000
  if (options.isCancelled()) return null
  let reference = await options.capture()
  let confirmations = 0
  for (let burst = 0; burst < maxBursts && confirmations < confirmRounds; burst += 1) {
    if (options.isCancelled()) return null
    options.onProgress?.(burst)
    try {
      await options.controller.scroll(burstNotches)
    } catch (error) {
      if (options.isCancelled()) return null
      throw error
    }
    const settled = options.settle
      ? await options.settle()
      : await waitForStillFrame(options.capture, options.isCancelled, { pollDelayMs, timeoutMs: settleTimeoutMs })
    if (options.isCancelled()) return null
    const unchanged =
      settled.still &&
      normalizedImageDifference(reference.fingerprint, settled.frame.fingerprint) < FRAME_STILL_THRESHOLD
    confirmations = unchanged ? confirmations + 1 : 0
    reference = settled.frame
  }
  if (options.isCancelled()) return null
  if (confirmations < confirmRounds) throw new Error('未能确认内容顶部，请检查截图区域是否覆盖可滚动内容')
  return reference
}

function persistentScrollScript(hwnd: string, crop: WechatCaptureCrop): string {
  const xRatio = ((crop.left + (100 - crop.right)) / 200).toFixed(4)
  const yRatio = ((crop.top + (100 - crop.bottom)) / 200).toFixed(4)
  return `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WechatScrollNative {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extraInfo);
}
'@
$handle = [IntPtr]::new([Int64]${hwnd})
while ($true) {
  $command = [Console]::In.ReadLine()
  if ($null -eq $command -or $command -eq 'quit') { break }
  $parts = $command.Trim().Split(' ')
  if ($parts[0] -eq 'status') {
    if ([WechatScrollNative]::IsIconic($handle)) { [Console]::Out.WriteLine('minimized') } else { [Console]::Out.WriteLine('ready') }
    [Console]::Out.Flush()
    continue
  }
  if ($parts[0] -ne 'scroll' -or $parts.Length -lt 2) { continue }
  if ([WechatScrollNative]::IsIconic($handle)) {
    [Console]::Out.WriteLine('minimized')
    [Console]::Out.Flush()
    continue
  }
  $notches = 0
  if (-not [int]::TryParse($parts[1], [ref]$notches)) { continue }
  $rect = New-Object WechatScrollNative+RECT
  if (-not [WechatScrollNative]::GetWindowRect($handle, [ref]$rect)) { break }
  $x = [int]($rect.Left + ($rect.Right - $rect.Left) * ${xRatio})
  $y = [int]($rect.Top + ($rect.Bottom - $rect.Top) * ${yRatio})
  [WechatScrollNative]::SetForegroundWindow($handle) | Out-Null
  [WechatScrollNative]::SetCursorPos($x, $y) | Out-Null
  $sign = [Math]::Sign($notches)
  $remaining = [Math]::Abs($notches)
  while ($remaining -gt 0) {
    $chunk = [Math]::Min(12, $remaining)
    [WechatScrollNative]::mouse_event(0x0800, 0, 0, 120 * $sign * $chunk, [UIntPtr]::Zero)
    $remaining -= $chunk
    if ($remaining -gt 0) { Start-Sleep -Milliseconds 8 }
  }
  [Console]::Out.WriteLine('ok')
  [Console]::Out.Flush()
}
`
}

export class TargetWindowMinimizedError extends Error {
  constructor() {
    super('目标窗口已最小化')
    this.name = 'TargetWindowMinimizedError'
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
