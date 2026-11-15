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
  private readonly pending: Array<{ resolve: (response: string) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }> = []
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
    child.stdin.on('error', (error) => this.fail(error))
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
    if (!Number.isFinite(notches) || Math.abs(notches) > 3600) return Promise.reject(new Error('滚动格数无效'))
    const amount = Math.trunc(notches)
    if (amount === 0) return Promise.resolve()
    return this.command(`scroll ${amount}`).then((response) => {
      assertWindowResponse(response)
      if (response !== 'ok') throw new Error(`滚动控制器返回了未知状态：${response}`)
    })
  }

  async isMinimized(): Promise<boolean> {
    const response = await this.command('status')
    if (response === 'minimized') return true
    assertWindowResponse(response)
    if (response !== 'ready') throw new Error(`滚动控制器返回了未知状态：${response}`)
    return false
  }

  private command(command: string): Promise<string> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.child.exitCode !== null || this.child.killed) return Promise.reject(new Error('滚动控制进程未运行'))
    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.fail(new Error('滚动控制器响应超时，请重新开始截图'))
        this.child.kill()
      }, 15_000)
      const item = { resolve, reject, timeout }
      this.pending.push(item)
      this.child.stdin.write(`${command}\n`, (error) => {
        if (!error) return
        // A broken pipe invalidates the response order for every queued command.
        this.fail(error)
        this.child.kill()
      })
    })
  }

  async stop(): Promise<void> {
    this.fail(new Error('滚动控制进程已停止'))
    if (this.child.exitCode !== null || this.child.killed) return
    this.child.stdin.write('quit\n', () => {})
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
      if (!['ok', 'ready', 'minimized', 'closed', 'hidden', 'blocked', 'failed'].includes(response)) continue
      const item = this.pending.shift()
      if (item) {
        clearTimeout(item.timeout)
        item.resolve(response)
      }
    }
  }

  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    for (const item of this.pending.splice(0)) {
      clearTimeout(item.timeout)
      item.reject(error)
    }
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
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WechatScrollNative {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint flags; public uint time; public UIntPtr extraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public MOUSEINPUT mouse; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr process);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint sourceThread, uint targetThread, bool attach);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hWnd, uint attribute, out RECT rect, int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hWnd, uint attribute, out int value, int size);
  public static void EnableDpi() {
    try { SetThreadDpiAwarenessContext(new IntPtr(-4)); }
    catch (EntryPointNotFoundException) { SetProcessDPIAware(); }
  }
  public static string State(IntPtr hWnd) {
    if (!IsWindow(hWnd)) return "closed";
    if (IsIconic(hWnd)) return "minimized";
    if (!IsWindowVisible(hWnd)) return "hidden";
    int cloaked;
    if (DwmGetWindowAttribute(hWnd, 14, out cloaked, sizeof(int)) == 0 && cloaked != 0) return "hidden";
    return "ready";
  }
  public static bool Bounds(IntPtr hWnd, out RECT rect) {
    if (DwmGetWindowAttribute(hWnd, 9, out rect, Marshal.SizeOf(typeof(RECT))) != 0 && !GetWindowRect(hWnd, out rect)) return false;
    return rect.Right > rect.Left && rect.Bottom > rect.Top;
  }
  public static bool OwnsCursor(IntPtr hWnd, int x, int y) {
    POINT point;
    return GetCursorPos(out point) && point.X == x && point.Y == y && GetAncestor(WindowFromPoint(point), 2) == hWnd;
  }
  public static void Activate(IntPtr hWnd) {
    if (GetForegroundWindow() == hWnd || SetForegroundWindow(hWnd)) return;
    uint currentThread = GetCurrentThreadId();
    uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
    if (foregroundThread == 0 || foregroundThread == currentThread || !AttachThreadInput(currentThread, foregroundThread, true)) return;
    try { BringWindowToTop(hWnd); SetForegroundWindow(hWnd); }
    finally { AttachThreadInput(currentThread, foregroundThread, false); }
  }
  public static bool Wheel(int delta) {
    var input = new INPUT();
    input.mouse.mouseData = unchecked((uint)delta);
    input.mouse.flags = 0x0800;
    return SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT))) == 1;
  }
}
'@
[WechatScrollNative]::EnableDpi()
$handle = [IntPtr]::new([Int64]${hwnd})
function Respond([string]$value) { [Console]::Out.WriteLine($value); [Console]::Out.Flush() }
while ($true) {
  $command = [Console]::In.ReadLine()
  if ($null -eq $command -or $command -eq 'quit') { break }
  $parts = $command.Trim().Split(' ')
  if ($parts[0] -eq 'status') {
    Respond ([WechatScrollNative]::State($handle))
    continue
  }
  if ($parts[0] -ne 'scroll' -or $parts.Length -ne 2) { Respond 'failed'; continue }
  $state = [WechatScrollNative]::State($handle)
  if ($state -ne 'ready') { Respond $state; continue }
  $notches = 0
  if (-not [int]::TryParse($parts[1], [ref]$notches) -or [Math]::Abs([long]$notches) -gt 3600) { Respond 'failed'; continue }
  $rect = New-Object WechatScrollNative+RECT
  if (-not [WechatScrollNative]::Bounds($handle, [ref]$rect)) { Respond 'failed'; continue }
  $x = [int]($rect.Left + ($rect.Right - $rect.Left) * ${xRatio})
  $y = [int]($rect.Top + ($rect.Bottom - $rect.Top) * ${yRatio})
  if ([WechatScrollNative]::GetForegroundWindow() -ne $handle) {
    [WechatScrollNative]::Activate($handle)
    for ($attempt = 0; $attempt -lt 10 -and [WechatScrollNative]::GetForegroundWindow() -ne $handle; $attempt++) { Start-Sleep -Milliseconds 20 }
  }
  if ([WechatScrollNative]::GetForegroundWindow() -ne $handle) { Respond 'blocked'; continue }
  if (-not [WechatScrollNative]::SetCursorPos($x, $y) -or -not [WechatScrollNative]::OwnsCursor($handle, $x, $y)) { Respond 'blocked'; continue }
  $sign = [Math]::Sign($notches)
  $remaining = [Math]::Abs($notches)
  $result = 'ok'
  while ($remaining -gt 0) {
    $state = [WechatScrollNative]::State($handle)
    if ($state -ne 'ready') { $result = $state; break }
    if ([WechatScrollNative]::GetForegroundWindow() -ne $handle -or -not [WechatScrollNative]::OwnsCursor($handle, $x, $y)) { $result = 'blocked'; break }
    $chunk = [Math]::Min(12, $remaining)
    if (-not [WechatScrollNative]::Wheel(120 * $sign * $chunk)) { $result = 'failed'; break }
    $remaining -= $chunk
    if ($remaining -gt 0) { Start-Sleep -Milliseconds 8 }
  }
  Respond $result
}
`
}

export class TargetWindowMinimizedError extends Error {
  constructor() {
    super('目标窗口已最小化')
    this.name = 'TargetWindowMinimizedError'
  }
}

function assertWindowResponse(response: string): void {
  if (response === 'minimized') throw new TargetWindowMinimizedError()
  if (response === 'closed') throw new Error('目标窗口已关闭，请重新选择窗口')
  if (response === 'hidden') throw new Error('目标窗口已隐藏或位于其他虚拟桌面，请显示窗口后重试')
  if (response === 'blocked') throw new Error('无法在目标窗口中滚动，请确认窗口未被遮挡且允许切换到前台')
  if (response === 'failed') throw new Error('向目标窗口发送滚动失败，请检查窗口状态及权限')
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
