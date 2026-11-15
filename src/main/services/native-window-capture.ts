import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export interface NativeWindowInfo {
  id: string
  name: string
  state: 'ready' | 'minimized' | 'hidden' | 'closed'
  width: number
  height: number
}

interface NativeReply { id: number; windows?: NativeWindowInfo[]; png?: string; error?: string }

/** A single DPI-aware helper reads real HWND state and, when needed, visible screen pixels. */
export class NativeWindowCapture {
  private child: ChildProcessWithoutNullStreams | null = null
  private nextId = 0
  private output = ''
  private readonly pending = new Map<number, { resolve: (reply: NativeReply) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()

  async list(): Promise<NativeWindowInfo[]> {
    if (process.platform !== 'win32') return []
    return (await this.command('list')).windows ?? []
  }

  async capture(sourceId: string): Promise<Buffer> {
    const handle = /^window:(\d+):\d+$/.exec(sourceId)?.[1]
    if (!handle) throw new Error('无效的目标窗口句柄')
    const reply = await this.command('capture', handle)
    if (!reply.png) throw new Error('目标窗口未返回画面，请刷新窗口后重试')
    return Buffer.from(reply.png, 'base64')
  }

  dispose(): void {
    const child = this.child
    this.child = null
    child?.kill()
    this.output = ''
    this.rejectAll(new Error('窗口采集服务已关闭'))
  }

  private command(command: string, handle?: string): Promise<NativeReply> {
    this.ensureChild()
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rejectAll(new Error('读取窗口画面超时，请刷新后重试'))
        this.dispose()
      }, 15_000)
      this.pending.set(id, { resolve, reject, timer })
      this.child!.stdin.write(JSON.stringify({ id, command, handle }) + '\n', (error) => {
        if (!error) return
        const entry = this.pending.get(id)
        if (!entry) return
        clearTimeout(entry.timer)
        this.pending.delete(id)
        entry.reject(error)
      })
    })
  }

  private ensureChild(): void {
    if (this.child) return
    if (process.platform !== 'win32') throw new Error('屏幕兼容采集目前仅支持 Windows')
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
      Buffer.from(nativeWindowCaptureScript, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'pipe' })
    this.child = child
    let errorText = ''
    child.stderr.setEncoding('utf8').on('data', (value: string) => { errorText = (errorText + value).slice(-3000) })
    child.stdout.setEncoding('utf8').on('data', (value: string) => {
      if (this.child !== child) return
      this.output += value
      let end: number
      while ((end = this.output.indexOf('\n')) >= 0) {
        const line = this.output.slice(0, end).trim()
        this.output = this.output.slice(end + 1)
        if (!line.startsWith('WINDOW ')) continue
        try {
          const reply = JSON.parse(line.slice(7)) as NativeReply
          const entry = this.pending.get(reply.id)
          if (!entry) continue
          clearTimeout(entry.timer)
          this.pending.delete(reply.id)
          if (reply.error) entry.reject(new Error(reply.error))
          else entry.resolve(reply)
        } catch { this.dispose() }
      }
    })
    const fail = (error: Error): void => {
      if (this.child !== child) return
      this.child = null
      this.output = ''
      this.rejectAll(error)
      child.kill()
    }
    child.on('error', fail)
    child.stdin.on('error', fail)
    child.on('exit', () => fail(new Error(errorText.trim() || '窗口采集进程已退出')))
  }

  private rejectAll(error: Error): void {
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error) }
    this.pending.clear()
  }
}

export const nativeWindowCapture = new NativeWindowCapture()

// DWM frame bounds match Chromium window capture. Coordinates and monitor rectangles are physical pixels,
// including monitors to the left/above the primary monitor and mixed per-monitor scaling.
export const nativeWindowCaptureScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
public static class WindowCaptureNative {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public delegate bool WindowProc(IntPtr h, IntPtr p);
  public delegate bool MonitorProc(IntPtr h, IntPtr dc, ref RECT rect, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(WindowProc proc, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorProc proc, IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT rect);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT rect, int size);
  [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int GetCloaked(IntPtr h, int attr, out int value, int size);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("dwmapi.dll")] static extern int DwmFlush();
  public sealed class Info { public string id, name, state; public int width, height; }
  static void Dpi() {
    try { SetThreadDpiAwarenessContext(new IntPtr(-4)); }
    catch (EntryPointNotFoundException) { SetProcessDPIAware(); }
  }
  static bool Cloaked(IntPtr h) { int value; return GetCloaked(h, 14, out value, 4) == 0 && value != 0; }
  static Rectangle Bounds(IntPtr h) {
    RECT r;
    if (DwmGetWindowAttribute(h, 9, out r, 16) != 0 && !GetWindowRect(h, out r)) return Rectangle.Empty;
    return Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom);
  }
  static string State(IntPtr h) {
    if (!IsWindow(h)) return "closed";
    if (IsIconic(h)) return "minimized";
    if (!IsWindowVisible(h) || Cloaked(h)) return "hidden";
    return "ready";
  }
  public static Info[] List() {
    Dpi();
    var windows = new List<Info>();
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      if (!IsWindowVisible(h) || Cloaked(h) || (GetWindowLong(h, -20) & 0x80) != 0) return true;
      var name = new StringBuilder(2048);
      GetWindowText(h, name, name.Capacity);
      if (name.Length == 0) return true;
      var rect = Bounds(h);
      windows.Add(new Info { id = "window:" + h.ToInt64() + ":0", name = name.ToString(), state = State(h), width = rect.Width, height = rect.Height });
      return true;
    }, IntPtr.Zero);
    return windows.ToArray();
  }
  public static string Capture(long handle) {
    Dpi();
    var h = new IntPtr(handle);
    var state = State(h);
    if (state == "closed") throw new Exception("目标窗口已关闭，请刷新窗口列表");
    if (state == "minimized") throw new Exception("目标窗口已最小化，请恢复后刷新");
    if (state == "hidden") throw new Exception("目标窗口当前不可见，请切换到窗口所在桌面");
    var bounds = Bounds(h);
    if (bounds.Width < 1 || bounds.Height < 1 || (long)bounds.Width * bounds.Height > 64000000) throw new Exception("目标窗口尺寸无效");
    using (var missing = new Region(bounds)) {
      EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate(IntPtr monitor, IntPtr dc, ref RECT rect, IntPtr p) {
        missing.Exclude(Rectangle.FromLTRB(rect.Left, rect.Top, rect.Right, rect.Bottom)); return true;
      }, IntPtr.Zero);
      using (var matrix = new System.Drawing.Drawing2D.Matrix()) {
        if (missing.GetRegionScans(matrix).Length != 0) throw new Exception("目标窗口部分超出屏幕，请将窗口完整移入显示器后刷新");
      }
    }
    CheckVisible(h, bounds);
    DwmFlush();
    using (var bitmap = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppArgb)) {
      using (var graphics = Graphics.FromImage(bitmap)) graphics.CopyFromScreen(bounds.Location, Point.Empty, bounds.Size, CopyPixelOperation.SourceCopy);
      // A window can move, close, minimize or be covered between enumeration and CopyFromScreen.
      // Never return those desktop pixels as if they were a valid target-window frame.
      CheckVisible(h, bounds);
      using (var stream = new MemoryStream()) { bitmap.Save(stream, ImageFormat.Png); return Convert.ToBase64String(stream.ToArray()); }
    }
  }
  static void CheckVisible(IntPtr h, Rectangle bounds) {
    if (State(h) != "ready" || Bounds(h) != bounds) throw new Exception("目标窗口位置或状态已改变，请等待窗口稳定后刷新");
    bool obscured = false, found = false;
    EnumWindows(delegate(IntPtr other, IntPtr p) {
      if (other == h) { found = true; return false; }
      // WS_EX_TRANSPARENT windows can still paint opaque pixels (for example click-through overlays).
      if (!IsWindowVisible(other) || IsIconic(other) || Cloaked(other)) return true;
      if (bounds.IntersectsWith(Bounds(other))) { obscured = true; return false; }
      return true;
    }, IntPtr.Zero);
    if (obscured) throw new Exception("目标窗口被遮挡，请保持完整可见后刷新");
    if (!found) throw new Exception("目标窗口已关闭，请刷新窗口列表");
  }
}
'@
while ($null -ne ($line = [Console]::ReadLine())) {
  $request = $null
  try {
    $request = $line | ConvertFrom-Json
    if ($request.command -eq 'list') { $response = @{ id = $request.id; windows = @([WindowCaptureNative]::List()) } }
    elseif ($request.command -eq 'capture') { $response = @{ id = $request.id; png = [WindowCaptureNative]::Capture([long]$request.handle) } }
    else { throw '未知窗口采集命令' }
  } catch { $response = @{ id = $request.id; error = $_.Exception.GetBaseException().Message } }
  [Console]::Out.WriteLine('WINDOW ' + (ConvertTo-Json -InputObject $response -Compress -Depth 5))
  [Console]::Out.Flush()
}
`
