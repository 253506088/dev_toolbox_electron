import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { WechatScrollController } from '../src/main/services/wechat-scroll-controller'
import { NativeWindowCapture } from '../src/main/services/native-window-capture'

const exec = promisify(execFile)

// Explicit opt-in: only this synthetic window is focused and scrolled. No real chat is touched.
describe.skipIf(process.platform !== 'win32' || process.env.WECHAT_SCROLL_NATIVE_TEST !== '1')('Windows 多屏滚动与真实窗口状态', () => {
  it('在每块显示器采集真实像素并发送滚轮，区分窗口状态和遮挡', { timeout: 90_000 }, async () => {
    const resultsRoot = resolve('test-results')
    await mkdir(resultsRoot, { recursive: true })
    const directory = await mkdtemp(join(resultsRoot, 'scroll-native-'))
    let child: ChildProcess | undefined
    let controller: WechatScrollController | undefined
    const capture = new NativeWindowCapture()
    const screenChecks: Array<{ screen: number; width: number; height: number }> = []
    let sequence = 0
    const command = async (value: string): Promise<void> => {
      sequence += 1
      await writeFile(join(directory, 'command.txt'), `${sequence}|${value}`)
      await waitFor(() => readFile(join(directory, 'ack.txt'), 'utf8'), (text) => text === String(sequence))
    }
    try {
      const source = join(directory, 'Fixture.cs')
      const compiler = join(directory, 'compile.ps1')
      const exe = join(directory, 'ScrollFixture.exe')
      await writeFile(source, '\ufeff' + fixtureSource, 'utf8')
      await writeFile(compiler, "param([string]$Source, [string]$Output)\n$ErrorActionPreference = 'Stop'\nAdd-Type -Path $Source -ReferencedAssemblies System.Windows.Forms,System.Drawing -OutputAssembly $Output -OutputType WindowsApplication\n", 'utf8')
      await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', compiler, source, exe], { windowsHide: true })
      child = spawn(exe, [directory], { windowsHide: true, stdio: 'ignore' })
      const metadata = JSON.parse(await waitFor(() => readFile(join(directory, 'ready.json'), 'utf8'), Boolean)) as { handle: string; screens: number }
      const sourceId = `window:${metadata.handle}:0`
      controller = WechatScrollController.start(sourceId, { left: 5, top: 15, right: 5, bottom: 5 })
      expect(await controller.isMinimized()).toBe(false)
      for (let screen = 0; screen < metadata.screens; screen += 1) {
        await command(`screen:${screen}`)
        expect(await controller.isMinimized(), `screen ${screen + 1} is visible`).toBe(false)
        await controller.scroll(-2)
        const window = (await capture.list()).find((item) => item.id === sourceId)
        expect(window?.state).toBe('ready')
        const png = await capture.capture(sourceId)
        const dimensions = await sharp(png).metadata()
        expect(dimensions.width).toBe(window?.width)
        expect(dimensions.height).toBe(window?.height)
        const pixel = await sharp(png).extract({ left: Math.floor(dimensions.width! / 2), top: Math.floor(dimensions.height! / 2), width: 1, height: 1 }).ensureAlpha().raw().toBuffer()
        expect([...pixel], `screen ${screen + 1} captures the synthetic window, including mixed DPI/negative origins`).toEqual([236, 247, 255, 255])
        screenChecks.push({ screen: screen + 1, width: dimensions.width!, height: dimensions.height! })
        const actual = await waitFor(() => readFile(join(directory, 'wheel.txt'), 'utf8'), (text) => Number(text) === -240 * (screen + 1))
        expect(Number(actual), `screen ${screen + 1} receives the wheel`).toBe(-240 * (screen + 1))
      }
      await command('layered')
      const layered = await sharp(await capture.capture(sourceId)).resize(1, 1, { kernel: 'nearest' }).ensureAlpha().raw().toBuffer()
      expect([...layered], 'layered target remains visible and fully opaque in PNG').toEqual([236, 247, 255, 255])
      console.info(`Validated real window capture and wheel input on ${metadata.screens} monitor(s).`)
      await command('overlay')
      await expect(capture.capture(sourceId)).rejects.toThrow('被遮挡')
      await command('clear-overlay')
      await command('offscreen')
      await expect(capture.capture(sourceId)).rejects.toThrow('超出屏幕')
      await command('screen:0')
      await command('minimize')
      expect(await controller.isMinimized()).toBe(true)
      expect((await capture.list()).find((item) => item.id === sourceId)?.state).toBe('minimized')
      await expect(capture.capture(sourceId)).rejects.toThrow('已最小化')
      await expect(controller.scroll(-1)).rejects.toThrow('已最小化')
      await command('restore')
      expect(await controller.isMinimized()).toBe(false)
      await command('hide')
      await expect(controller.isMinimized()).rejects.toThrow('已隐藏')
      await expect(capture.capture(sourceId)).rejects.toThrow('不可见')
      await command('restore')
      expect(await controller.isMinimized()).toBe(false)
      await command('close')
      await expect(controller.isMinimized()).rejects.toThrow('已关闭')
      await expect(capture.capture(sourceId)).rejects.toThrow('已关闭')
      await writeFile(join(resultsRoot, 'native-window-last.json'), JSON.stringify({
        completedAt: new Date().toISOString(), monitorCount: metadata.screens, screens: screenChecks,
        checks: ['visible-pixels', 'wheel-input', 'layered-window', 'click-through-occlusion', 'offscreen', 'minimized', 'hidden', 'closed']
      }, null, 2) + '\n')
    } finally {
      capture.dispose()
      await controller?.stop()
      if (child && child.exitCode === null) {
        await command('close').catch(() => {})
        if (child.exitCode === null) child.kill()
        await new Promise<void>((done) => {
          if (child!.exitCode !== null) return done()
          const timer = setTimeout(done, 1500)
          child!.once('exit', () => { clearTimeout(timer); done() })
        })
      }
      // Only remove the fixture directory created above, never a computed parent.
      if (!resolve(directory).startsWith(resultsRoot + sep)) throw new Error('Unsafe fixture cleanup path')
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 })
    }
  })
})

async function waitFor(read: () => Promise<string>, matches: (text: string) => unknown): Promise<string> {
  const deadline = Date.now() + 10_000
  let latest = ''
  while (Date.now() < deadline) {
    try { latest = await read(); if (matches(latest)) return latest } catch { /* The fixture has not published this state yet. */ }
    await new Promise((done) => setTimeout(done, 50))
  }
  throw new Error(`Synthetic scroll window did not respond: ${latest}`)
}

const fixtureSource = String.raw`
using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class ScrollFixture : Form {
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  string directory;
  int wheel = 0;
  string previousCommand = "";
  POINT originalCursor;
  Form overlay;
  public ScrollFixture(string path) {
    directory = path;
    GetCursorPos(out originalCursor);
    Text = "多屏滚动回归测试（合成窗口）";
    StartPosition = FormStartPosition.Manual;
    ClientSize = new Size(500, 360);
    BackColor = Color.FromArgb(236, 247, 255);
    TopMost = true;
    var timer = new Timer { Interval = 50 };
    timer.Tick += delegate {
      string commandPath = Path.Combine(directory, "command.txt");
      if (!File.Exists(commandPath)) return;
      string command;
      try { command = File.ReadAllText(commandPath); } catch (IOException) { return; }
      if (command == previousCommand || !command.Contains("|")) return;
      previousCommand = command;
      string[] parts = command.Split('|');
      string value = parts[1];
      if (value.StartsWith("screen:")) {
        var area = Screen.AllScreens[int.Parse(value.Substring(7))].WorkingArea;
        Location = new Point(area.Left + 80, area.Top + 80);
        Show(); Activate(); SetForegroundWindow(Handle);
      }
      if (value == "minimize") WindowState = FormWindowState.Minimized;
      if (value == "hide") Hide();
      if (value == "layered") TransparencyKey = Color.Lime;
      if (value == "overlay") {
        overlay = new Overlay { Text = "合成点击穿透遮挡", StartPosition = FormStartPosition.Manual,
          Location = new Point(Left + 60, Top + 60), Size = new Size(200, 150), BackColor = Color.Red, TopMost = true, Opacity = 0.85 };
        overlay.Show(this);
      }
      if (value == "clear-overlay" && overlay != null) { overlay.Close(); overlay = null; }
      if (value == "offscreen") {
        var area = Screen.AllScreens[Screen.AllScreens.Length - 1].Bounds;
        Location = new Point(SystemInformation.VirtualScreen.Right - 100, area.Top + 80);
      }
      if (value == "restore") { Show(); WindowState = FormWindowState.Normal; Activate(); SetForegroundWindow(Handle); }
      if (value == "close") Close();
      File.WriteAllText(Path.Combine(directory, "ack.txt"), parts[0]);
    };
    Shown += delegate {
      ShowWindow(Handle, 5);
      File.WriteAllText(Path.Combine(directory, "ready.json"), "{\"handle\":\"" + Handle.ToInt64() + "\",\"screens\":" + Screen.AllScreens.Length + "}");
      timer.Start();
    };
    FormClosed += delegate { SetCursorPos(originalCursor.X, originalCursor.Y); timer.Stop(); timer.Dispose(); };
  }
  protected override void WndProc(ref Message message) {
    if (message.Msg == 0x020A) {
      wheel += (short)((message.WParam.ToInt64() >> 16) & 0xffff);
      File.WriteAllText(Path.Combine(directory, "wheel.txt"), wheel.ToString());
    }
    base.WndProc(ref message);
  }
  [STAThread]
  public static void Main(string[] args) {
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    Application.EnableVisualStyles();
    Application.Run(new ScrollFixture(args[0]));
  }
}
public class Overlay : Form {
  protected override CreateParams CreateParams {
    get { var parameters = base.CreateParams; parameters.ExStyle |= 0x20; return parameters; }
  }
}
`
