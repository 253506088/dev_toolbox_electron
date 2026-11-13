import type { WechatCaptureCrop } from '../../shared/wechat-capture'

/** Kept separate so the Windows helper can be syntax/compile checked without driving a real chat. */
export function wechatVoiceScript(handle: string, crop: WechatCaptureCrop): string {
  if (!/^\d+$/.test(handle)) throw new Error('无效的微信窗口句柄')
  const ratios = [crop.left, crop.top, crop.right, crop.bottom]
  if (!ratios.every((value) => Number.isFinite(value) && value >= 0 && value < 100)) throw new Error('无效的聊天裁切区域')
  return `$targetHandle = [IntPtr]::new([Int64]${handle})
$cropRatios = @(${ratios.join(',')})
` + String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -ReferencedAssemblies System.Drawing @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class VoiceNative {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public delegate bool EnumWindowProc(IntPtr hwnd, IntPtr lparam);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowProc callback, IntPtr param);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  public static void EnableDpi() { try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) {} }
  public static uint ProcessId(IntPtr h) { uint id; GetWindowThreadProcessId(h, out id); return id; }
  public static long[] Windows(uint process) {
    var result = new List<long>();
    EnumWindows(delegate(IntPtr h, IntPtr p) { if (IsWindowVisible(h) && ProcessId(h) == process) result.Add(h.ToInt64()); return true; }, IntPtr.Zero);
    return result.ToArray();
  }
  public static bool OwnPoint(int x, int y, uint process) { return ProcessId(WindowFromPoint(new POINT { X = x, Y = y })) == process; }
  public static double Capture(int x, int y, int width, int height, string path, int maxSize, double enlargement) {
    int sx = GetSystemMetrics(76), sy = GetSystemMetrics(77), sw = GetSystemMetrics(78), sh = GetSystemMetrics(79);
    if (width < 1 || height < 1 || x < sx || y < sy || x + width > sx + sw || y + height > sy + sh) throw new Exception("聊天区域超出屏幕，请完整显示微信窗口");
    using (var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb)) {
      using (var graphics = Graphics.FromImage(bitmap)) graphics.CopyFromScreen(x, y, 0, 0, bitmap.Size, CopyPixelOperation.SourceCopy);
      double ratio = Math.Min(enlargement, (double)maxSize / Math.Max(width, height));
      if (ratio != 1) { using (var small = new Bitmap(bitmap, (int)Math.Round(width * ratio), (int)Math.Round(height * ratio))) small.Save(path, ImageFormat.Png); }
      else bitmap.Save(path, ImageFormat.Png);
      return ratio;
    }
  }
}
'@
[VoiceNative]::EnableDpi()
$targetProcess = [VoiceNative]::ProcessId($targetHandle)
$ownedMenu = $false
$beforeWindows = @()
$selectedMenu = $null
$originalCursor = New-Object VoiceNative+POINT
[VoiceNative]::GetCursorPos([ref]$originalCursor) | Out-Null
$lastCursor = $null
$imagePath = Join-Path $PSScriptRoot 'frame.png'
$cancelPath = Join-Path $PSScriptRoot 'cancelled'
$menuMarker = Join-Path $PSScriptRoot 'menu-open'
$engine = $null
try {
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name.StartsWith('IAsyncOperation') })[0]
  [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
  [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
  [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('zh-Hans-CN'))
  # Chinese context-menu labels must be recognized with an installed Chinese OCR model.
} catch { $engine = $null }

function Await-Voice($operation, $resultType) {
  $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($operation))
  if (-not $task.Wait(8000)) { throw 'Windows OCR 识别超时' }
  return $task.Result
}

function Get-Rect([IntPtr]$window) {
  $r = New-Object VoiceNative+RECT
  if (-not [VoiceNative]::GetWindowRect($window, [ref]$r)) { throw '无法读取微信窗口位置' }
  return @{ x = $r.Left; y = $r.Top; width = $r.Right - $r.Left; height = $r.Bottom - $r.Top }
}

function Assert-Window {
  if ([System.IO.File]::Exists($cancelPath)) { throw '语音处理已停止' }
  if (-not [VoiceNative]::IsWindow($targetHandle) -or [VoiceNative]::ProcessId($targetHandle) -ne $targetProcess) { throw '微信窗口已关闭或已更换' }
  if ([VoiceNative]::IsIconic($targetHandle)) { throw 'VOICE_MINIMIZED' }
  if (-not [VoiceNative]::IsWindowVisible($targetHandle)) { throw '微信窗口当前不可见' }
  $processName = (Get-Process -Id $targetProcess -ErrorAction Stop).ProcessName
  if ($processName -notmatch '^(WeChat|Weixin|WeChatAppEx)$') { throw '语音转文字只能用于微信窗口' }
  $foreground = [VoiceNative]::GetForegroundWindow()
  if ([VoiceNative]::ProcessId($foreground) -ne $targetProcess) {
    [VoiceNative]::SetForegroundWindow($targetHandle) | Out-Null
    Start-Sleep -Milliseconds 150
  }
  if ([VoiceNative]::ProcessId([VoiceNative]::GetForegroundWindow()) -ne $targetProcess) { throw '无法将微信窗口置于前台，请手动切换至微信后重试' }
}

function Get-Crop {
  $r = Get-Rect $targetHandle
  $left = [int][Math]::Round($r.width * $cropRatios[0] / 100)
  $top = [int][Math]::Round($r.height * $cropRatios[1] / 100)
  return @{ x = $r.x + $left; y = $r.y + $top; width = [int][Math]::Round($r.width * (100 - $cropRatios[0] - $cropRatios[2]) / 100); height = [int][Math]::Round($r.height * (100 - $cropRatios[1] - $cropRatios[3]) / 100) }
}

function Get-Elements([IntPtr]$window, $region, [bool]$onlyMenu) {
  $items = New-Object System.Collections.Generic.List[object]
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($window)
    $elements = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $limit = [Math]::Min($elements.Count, 4000)
    for ($index = 0; $index -lt $limit; $index++) {
      try {
        $element = $elements[$index]
        $current = $element.Current
        if ($current.IsOffscreen -or -not $current.IsEnabled -or [string]::IsNullOrWhiteSpace($current.Name)) { continue }
        if ($onlyMenu -and $current.ControlType -ne [System.Windows.Automation.ControlType]::MenuItem) { continue }
        $b = $current.BoundingRectangle
        if ($b.Width -le 0 -or $b.Height -le 0 -or $b.X -lt $region.x -or $b.Y -lt $region.y -or $b.Right -gt ($region.x + $region.width) -or $b.Bottom -gt ($region.y + $region.height)) { continue }
        $items.Add(@{ text = $current.Name; x = $b.X; y = $b.Y; width = $b.Width; height = $b.Height; id = ($element.GetRuntimeId() -join '.'); menuItem = ($current.ControlType -eq [System.Windows.Automation.ControlType]::MenuItem) })
      } catch {}
    }
  } catch {}
  return ,$items.ToArray()
}

function Get-Ocr($region, [double]$enlargement = 1) {
  $maxSize = 2600
  if ($null -ne $engine) { $maxSize = [int][Windows.Media.Ocr.OcrEngine]::MaxImageDimension }
  $ratio = [VoiceNative]::Capture([int]$region.x, [int]$region.y, [int]$region.width, [int]$region.height, $imagePath, $maxSize, $enlargement)
  return Read-VoiceImage $imagePath $region $ratio
}

function Read-VoiceImage([string]$path, $region, [double]$ratio) {
  $hasher = [System.Security.Cryptography.SHA256]::Create()
  try { $hash = [BitConverter]::ToString($hasher.ComputeHash([System.IO.File]::ReadAllBytes($path))) }
  finally { $hasher.Dispose() }
  $words = New-Object System.Collections.Generic.List[object]
  $lines = New-Object System.Collections.Generic.List[object]
  if ($null -ne $engine) {
    $stream = $null
    $bitmap = $null
    try {
      $file = Await-Voice ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
      $stream = Await-Voice ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
      $decoder = Await-Voice ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
      $bitmap = Await-Voice ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
      $result = Await-Voice ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
      foreach ($line in $result.Lines) {
        $lineWords = New-Object System.Collections.Generic.List[object]
        $left = [double]::PositiveInfinity; $top = [double]::PositiveInfinity; $right = 0; $bottom = 0
        foreach ($word in $line.Words) {
          $b = $word.BoundingRect
          $wordBox = @{ text = $word.Text; x = $region.x + $b.X / $ratio; y = $region.y + $b.Y / $ratio; width = $b.Width / $ratio; height = $b.Height / $ratio }
          $words.Add($wordBox)
          $lineWords.Add($wordBox)
          $left = [Math]::Min($left, $b.X); $top = [Math]::Min($top, $b.Y); $right = [Math]::Max($right, $b.X + $b.Width); $bottom = [Math]::Max($bottom, $b.Y + $b.Height)
        }
        if ($right -gt $left -and $bottom -gt $top) { $lines.Add(@{ text = $line.Text; x = $region.x + $left / $ratio; y = $region.y + $top / $ratio; width = ($right - $left) / $ratio; height = ($bottom - $top) / $ratio; words = @($lineWords.ToArray()) }) }
      }
    } finally {
      if ($null -ne $bitmap) { $bitmap.Dispose() }
      if ($null -ne $stream) { $stream.Dispose() }
    }
  }
  return @{ words = @($words.ToArray()); lines = @($lines.ToArray()); hash = $hash; ratio = $ratio }
}

function Get-Snapshot {
  Assert-Window
  $region = Get-Crop
  Assert-CropVisible $region
  $ocr = Get-Ocr $region
  $elements = Get-Elements $targetHandle $region $false
  return @{ crop = $region; words = @($ocr.words); elements = @($elements); hash = $ocr.hash; ocrAvailable = ($null -ne $engine); pixelScale = $ocr.ratio }
}

function Assert-CropVisible($region) {
  foreach ($point in @(@(($region.x + 5), ($region.y + 5)), @(($region.x + $region.width - 6), ($region.y + 5)), @(($region.x + 5), ($region.y + $region.height - 6)), @(($region.x + $region.width - 6), ($region.y + $region.height - 6)), @(($region.x + $region.width / 2), ($region.y + $region.height / 2)))) {
    $p = New-Object VoiceNative+POINT
    $p.X = [int]$point[0]; $p.Y = [int]$point[1]
    if ([VoiceNative]::GetAncestor([VoiceNative]::WindowFromPoint($p), 2) -ne $targetHandle) { throw '微信聊天区域被其他窗口遮挡，请完整显示后重试' }
  }
}

function Get-Action([string]$text) {
  $label = ($text -replace '[\s\u200b-\u200d\ufeff]', '' -replace '\(&[A-Z]\)$|（[A-Z]）$', '').ToLowerInvariant()
  if (@('语音转文字', '转文字', '转文本', '语音转文本', 'converttotext', 'transcribe') -contains $label) { return 'transcribe' }
  if (@('收起文字', '收起文本', '隐藏文字', 'hidetext', 'collapsetext') -contains $label) { return 'expanded' }
  return $null
}

function Get-Menu {
  if ([System.IO.File]::Exists($cancelPath)) { Close-Menu; throw '语音处理已停止' }
  # OCR is restricted to a popup which became visible after our right click.
  # It never treats text in the chat area as an executable context menu.
  $windows = [VoiceNative]::Windows($targetProcess)
  foreach ($windowId in $windows) {
    $window = [IntPtr]::new($windowId)
    $region = Get-Rect $window
    $isPopup = $window -ne $targetHandle -and $beforeWindows -notcontains $windowId
    if ($window -ne $targetHandle -and -not $isPopup) { continue }
    $elements = Get-Elements $window $region (-not $isPopup)
    foreach ($element in $elements) {
      $action = Get-Action $element.text
      if ($null -ne $action) { return @{ action = $action; item = $element; window = $windowId; label = $element.text } }
    }
    if ($isPopup -and $null -ne $engine -and $region.width -gt 10 -and $region.height -gt 10 -and $region.width -lt 1000 -and $region.height -lt 1500) {
      $ocr = Get-Ocr $region 2
      foreach ($line in $ocr.lines) {
        $action = Get-Action $line.text
        if ($null -ne $action) { return @{ action = $action; item = $line; window = $windowId; label = $line.text } }
        # The boxed transcription icon can be OCR'd as 文 or 区. Discard only a spatially
        # separate leading icon; never fuzzy-match a substring of a different menu action.
        if ($line.words.Count -gt 1) {
          $first = $line.words[0]
          $second = $line.words[1]
          if ($first.text.Length -le 2 -and $second.x - ($first.x + $first.width) -gt $first.height * 0.45) {
            $tail = @($line.words | Select-Object -Skip 1)
            $label = ($tail | ForEach-Object { $_.text }) -join ''
            $action = Get-Action $label
            if ($null -ne $action) {
              $last = $tail[$tail.Count - 1]
              $item = @{ x = $second.x; y = $second.y; width = $last.x + $last.width - $second.x; height = $second.height }
              return @{ action = $action; item = $item; window = $windowId; label = $label }
            }
          }
        }
      }
    }
  }
  return @{ action = 'none' }
}

function Close-Menu {
  if ($script:ownedMenu -and [VoiceNative]::ProcessId([VoiceNative]::GetForegroundWindow()) -eq $targetProcess) {
    [VoiceNative]::keybd_event(0x1b, 0, 0, [UIntPtr]::Zero)
    [VoiceNative]::keybd_event(0x1b, 0, 2, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 120
  }
  $script:ownedMenu = $false
  $script:selectedMenu = $null
  if ([System.IO.File]::Exists($menuMarker)) { [System.IO.File]::Delete($menuMarker) }
}

function Move-Cursor([int]$x, [int]$y) {
  if (-not [VoiceNative]::OwnPoint($x, $y, $targetProcess)) { throw '微信被其他窗口遮挡，已停止语音处理' }
  [VoiceNative]::SetCursorPos($x, $y) | Out-Null
  $script:lastCursor = @{ x = $x; y = $y }
}

try {
  while ($true) {
    $inputLine = [Console]::In.ReadLine()
    if ($null -eq $inputLine) { break }
    try {
      $request = $inputLine | ConvertFrom-Json
      if ($request.command -eq 'quit') { break }
      $reply = @{}
      if ($request.command -eq 'snapshot') { $reply = Get-Snapshot }
      elseif ($request.command -eq 'recognize') {
        if ([System.IO.File]::Exists($cancelPath)) { throw '语音处理已停止' }
        if ($request.image -notmatch '^ocr-input-[0-9]+[.]png$') { throw '无效的语音识别临时图片' }
        $reply = Read-VoiceImage (Join-Path $PSScriptRoot $request.image) @{ x = 0; y = 0 } 1
      }
      elseif ($request.command -eq 'validate') {
        Assert-Window
        $region = Get-Crop
        Assert-CropVisible $region
        $elements = Get-Elements $targetHandle $region $false
        if ($null -eq $engine -and $elements.Count -eq 0) { throw '微信未暴露可访问性文字，且系统中文 OCR 不可用；请安装 Windows 中文 OCR 语言包后重试' }
        $reply = @{ valid = $true; ocrAvailable = ($null -ne $engine); accessibilityElements = $elements.Count }
      }
      elseif ($request.command -eq 'open') {
        Assert-Window
        Close-Menu
        $region = Get-Crop
        $x = [int]$request.x; $y = [int]$request.y
        if ($x -le $region.x -or $x -ge ($region.x + $region.width) -or $y -le $region.y -or $y -ge ($region.y + $region.height)) { throw '语音气泡已离开聊天区域' }
        $beforeWindows = @([VoiceNative]::Windows($targetProcess))
        Move-Cursor $x $y
        [VoiceNative]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero)
        [VoiceNative]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)
        $ownedMenu = $true
        [System.IO.File]::WriteAllText($menuMarker, 'open')
        $selectedMenu = $null
        for ($attempt = 0; $attempt -lt 5; $attempt++) {
          Start-Sleep -Milliseconds 150
          $selectedMenu = Get-Menu
          if ($selectedMenu.action -ne 'none') { break }
        }
        $reply = @{ action = $selectedMenu.action }
      }
      elseif ($request.command -eq 'select') {
        Assert-Window
        if (-not $ownedMenu -or $null -eq $selectedMenu -or $selectedMenu.action -ne 'transcribe') { throw '没有可确认的语音转文字菜单' }
        $fresh = Get-Menu
        if ($fresh.action -ne 'transcribe' -or $fresh.window -ne $selectedMenu.window -or $fresh.label -ne $selectedMenu.label) { throw '语音菜单已变化，已取消点击' }
        $x = [int][Math]::Round($fresh.item.x + $fresh.item.width / 2)
        $y = [int][Math]::Round($fresh.item.y + $fresh.item.height / 2)
        Move-Cursor $x $y
        [VoiceNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
        [VoiceNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 180
        $ownedMenu = $false
        if ([System.IO.File]::Exists($menuMarker)) { [System.IO.File]::Delete($menuMarker) }
        $selectedMenu = $null
        $reply = @{ selected = $true }
      }
      elseif ($request.command -eq 'close') { Close-Menu; $reply = @{ closed = $true } }
      else { throw '未知的语音控制命令' }
      [Console]::Out.WriteLine('VOICE ' + ($reply | ConvertTo-Json -Compress -Depth 8))
    } catch {
      $message = $_.Exception.Message
      $code = 'failed'
      if ($message -eq 'VOICE_MINIMIZED') { $message = '目标窗口已最小化'; $code = 'minimized' }
      [Console]::Out.WriteLine('VOICE ' + (@{ error = $message; code = $code } | ConvertTo-Json -Compress))
    }
    [Console]::Out.Flush()
  }
} finally {
  Close-Menu
  # Restore only if the user has not moved the pointer since our last action.
  $currentCursor = New-Object VoiceNative+POINT
  [VoiceNative]::GetCursorPos([ref]$currentCursor) | Out-Null
  if ($null -ne $lastCursor -and $currentCursor.X -eq $lastCursor.x -and $currentCursor.Y -eq $lastCursor.y) {
    [VoiceNative]::SetCursorPos($originalCursor.X, $originalCursor.Y) | Out-Null
  }
}

`
}

/** Emergency cleanup is used only when an on-disk marker proves our helper left its menu open. */
export function wechatVoiceCleanupScript(handle: string): string {
  if (!/^\d+$/.test(handle)) throw new Error('无效的微信窗口句柄')
  return String.raw`Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class VoiceCleanup {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint id);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  public static uint ProcessId(IntPtr h) { uint id; GetWindowThreadProcessId(h, out id); return id; }
}
'@
` + `$target = [IntPtr]::new([Int64]${handle})\n` + String.raw`
if ([VoiceCleanup]::ProcessId($target) -ne 0 -and [VoiceCleanup]::ProcessId([VoiceCleanup]::GetForegroundWindow()) -eq [VoiceCleanup]::ProcessId($target)) {
  [VoiceCleanup]::keybd_event(0x1b, 0, 0, [UIntPtr]::Zero)
  [VoiceCleanup]::keybd_event(0x1b, 0, 2, [UIntPtr]::Zero)
}
`
}
