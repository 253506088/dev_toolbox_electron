import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { WechatVoiceController } from '../src/main/services/wechat-voice-controller'

const exec = promisify(execFile)

// Opt-in: this test briefly focuses its own synthetic WinForms chat and moves the cursor.
// The fixture is a separate temporary WeChat.exe; it never opens the user's real chats.
describe.skipIf(process.platform !== 'win32' || process.env.WECHAT_VOICE_NATIVE_TEST !== '1')('微信语音 Windows 原生链路', () => {
  it('右键合成语音、选中转文字、等待新增文字并识别已展开状态', { timeout: 90_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wechat-voice-fixture-'))
    let child: ChildProcess | undefined
    let controller: WechatVoiceController | undefined
    try {
      const source = join(directory, 'Fixture.cs')
      const compiler = join(directory, 'compile.ps1')
      const exe = join(directory, 'WeChat.exe')
      await writeFile(source, '\ufeff' + fixtureSource, 'utf8')
      await writeFile(compiler, `param([string]$Source, [string]$Output)\n$ErrorActionPreference = 'Stop'\nAdd-Type -Path $Source -ReferencedAssemblies System.Windows.Forms,System.Drawing -OutputAssembly $Output -OutputType WindowsApplication\n`, 'utf8')
      await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', compiler, source, exe], { windowsHide: true })
      child = spawn(exe, [directory], { windowsHide: true, stdio: 'ignore' })
      const handle = await waitForFile(join(directory, 'handle.txt'))
      controller = WechatVoiceController.start(`window:${handle.trim()}:0`, { left: 3, top: 10, right: 3, bottom: 5 })
      const options = { isCancelled: () => false, timeoutMs: 12_000 }
      await controller.validate(options)
      const first = await controller.convertVisible(options)
      expect(first, JSON.stringify(first)).toMatchObject({ converted: 1 })
      expect(first.failed).toBe(0)
      expect(await readFile(join(directory, 'selected.txt'), 'utf8')).toBe('transcribe')
      const second = await controller.convertVisible(options)
      expect(second.converted).toBe(0)
      expect(second.alreadyConverted).toBe(1)
      expect(await readFile(join(directory, 'selected.txt'), 'utf8')).toBe('transcribe')
    } finally {
      await controller?.stop()
      if (child && child.exitCode === null) {
        child.kill()
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1500)
          child!.once('exit', () => { clearTimeout(timer); resolve() })
        })
      }
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 })
    }
  })
})

async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    try { return await readFile(path, 'utf8') } catch { /* Wait for the fixture's Shown event. */ }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('合成微信窗口未启动')
}

const fixtureSource = String.raw`
using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class VoiceFixture {
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
  [STAThread]
  public static void Main(string[] args) {
    string directory = args[0];
    Application.EnableVisualStyles();
    var form = new Form { Text = "微信语音转写集成测试（合成消息）", ClientSize = new Size(740, 460),
      StartPosition = FormStartPosition.CenterScreen, TopMost = true, BackColor = Color.FromArgb(245,245,245) };
    var voice = new Label { Text = "3\"", AccessibleName = "[语音]3秒", Location = new Point(75, 65),
      Size = new Size(180, 60), TextAlign = ContentAlignment.MiddleCenter,
      BackColor = Color.FromArgb(225,225,225), Font = new Font("Microsoft YaHei", 20) };
    var transcript = new Label { Text = "请把位置发给我，我好像走错路了。", AccessibleName = "请把位置发给我，我好像走错路了。",
      Location = new Point(75, 140), Size = new Size(570, 65), Font = new Font("Microsoft YaHei", 19),
      BackColor = Color.FromArgb(225,225,225), TextAlign = ContentAlignment.MiddleLeft, Visible = false };
    var menu = new ContextMenuStrip { Font = new Font("Microsoft YaHei", 16) };
    var convert = menu.Items.Add("语音转文字");
    menu.Items.Add("收藏");
    menu.Items.Add("删除").Click += delegate { File.WriteAllText(Path.Combine(directory, "selected.txt"), "WRONG_DELETE"); };
    menu.Opening += delegate { convert.Text = transcript.Visible ? "收起文字" : "语音转文字"; };
    convert.Click += delegate {
      if (transcript.Visible) { File.WriteAllText(Path.Combine(directory, "selected.txt"), "WRONG_COLLAPSE"); return; }
      File.WriteAllText(Path.Combine(directory, "selected.txt"), "transcribe");
      var timer = new Timer { Interval = 650 };
      timer.Tick += delegate { transcript.Visible = true; timer.Stop(); timer.Dispose(); };
      timer.Start();
    };
    voice.ContextMenuStrip = menu;
    form.Controls.Add(voice);
    form.Controls.Add(transcript);
    form.Shown += delegate {
      ShowWindow(form.Handle, 5);
      form.BringToFront();
      SetForegroundWindow(form.Handle);
      File.WriteAllText(Path.Combine(directory, "handle.txt"), form.Handle.ToInt64().ToString());
    };
    Application.Run(form);
  }
}
`
