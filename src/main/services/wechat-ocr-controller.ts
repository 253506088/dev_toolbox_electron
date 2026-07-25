import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { OcrWord } from '../../shared/wechat-transcript'

/**
 * 常驻 PowerShell 进程封装 Windows 自带 OCR（Windows.Media.Ocr）。
 * 协议：stdin 逐行发送 `ocr <ASCII 路径>`；stdout 返回若干 `WORD\tx\ty\tw\th\t文本` 行，
 * 以 `DONE` 结束一次识别，异常时返回 `ERR 描述`。输出为 UTF-8。
 */
export class WechatOcrController {
  private pendingQueue: Array<{
    words: OcrWord[]
    resolve: (words: OcrWord[]) => void
    reject: (error: Error) => void
  }> = []

  private outputBuffer = ''
  private errorText = ''
  private failure: Error | null = null
  private ready = false
  private readyWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = []
  private chain: Promise<unknown> = Promise.resolve()

  static start(): WechatOcrController {
    const encoded = Buffer.from(ocrScript(), 'utf16le').toString('base64')
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', encoded],
      { windowsHide: true }
    )
    return new WechatOcrController(child)
  }

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.consumeOutput(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.errorText = `${this.errorText}${chunk}`.trim().slice(-800)
    })
    child.once('error', (error) => this.fail(error))
    child.once('exit', (code) => {
      if (code !== 0 && !child.killed) {
        const message = this.errorText.replace(/^#< CLIXML\s*/i, '').trim()
        this.fail(new Error(message || `OCR 进程退出，退出码 ${code ?? 'unknown'}`))
      } else {
        this.fail(new Error('OCR 进程已结束'))
      }
    })
  }

  /** 识别一张图片（路径必须为 ASCII，建议使用系统临时目录）；串行执行。 */
  recognize(imagePath: string): Promise<OcrWord[]> {
    const job = (): Promise<OcrWord[]> => this.recognizeNow(imagePath)
    const result = this.chain.then(job, job)
    this.chain = result.catch(() => undefined)
    return result as Promise<OcrWord[]>
  }

  private async recognizeNow(imagePath: string): Promise<OcrWord[]> {
    if (this.failure) throw this.failure
    await this.waitReady()
    if (this.child.exitCode !== null || this.child.killed) throw new Error('OCR 进程未运行')
    return new Promise<OcrWord[]>((resolve, reject) => {
      const item = { words: [] as OcrWord[], resolve, reject }
      this.pendingQueue.push(item)
      this.child.stdin.write(`ocr ${imagePath}\n`, (error) => {
        if (!error) return
        const index = this.pendingQueue.indexOf(item)
        if (index >= 0) this.pendingQueue.splice(index, 1)
        reject(error)
      })
    })
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.killed) return
    this.child.stdin.write('quit\n')
    await Promise.race([
      new Promise<void>((resolve) => this.child.once('exit', () => resolve())),
      delay(800)
    ])
    if (this.child.exitCode === null && !this.child.killed) this.child.kill()
  }

  private waitReady(): Promise<void> {
    if (this.ready) return Promise.resolve()
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => this.readyWaiters.push({ resolve, reject }))
  }

  private consumeOutput(chunk: string): void {
    this.outputBuffer += chunk
    const lines = this.outputBuffer.split(/\r?\n/)
    this.outputBuffer = lines.pop() ?? ''
    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (line === 'READY') {
        this.ready = true
        for (const waiter of this.readyWaiters.splice(0)) waiter.resolve()
        continue
      }
      if (line.startsWith('WORD\t')) {
        const parts = rawLine.split('\t')
        const current = this.pendingQueue[0]
        if (current && parts.length >= 6) {
          current.words.push({
            x: Number(parts[1]),
            y: Number(parts[2]),
            width: Number(parts[3]),
            height: Number(parts[4]),
            text: parts.slice(5).join('\t')
          })
        }
        continue
      }
      if (line === 'DONE') {
        const current = this.pendingQueue.shift()
        current?.resolve(current.words)
        continue
      }
      if (line.startsWith('ERR ')) {
        const current = this.pendingQueue.shift()
        current?.reject(new Error(line.slice(4) || 'OCR 识别失败'))
      }
    }
  }

  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    for (const waiter of this.readyWaiters.splice(0)) waiter.reject(error)
    for (const item of this.pendingQueue.splice(0)) item.reject(error)
  }
}

function ocrScript(): string {
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('zh-Hans-CN'))
if ($null -eq $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if ($null -eq $engine) { throw '未找到可用的 OCR 语言包，请在系统设置中安装中文语言的可选功能' }
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
while ($true) {
  $command = [Console]::In.ReadLine()
  if ($null -eq $command -or $command -eq 'quit') { break }
  if (-not $command.StartsWith('ocr ')) { continue }
  $path = $command.Substring(4).Trim()
  try {
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $stream.Dispose()
    $bitmap.Dispose()
    foreach ($line in $result.Lines) {
      foreach ($word in $line.Words) {
        $rect = $word.BoundingRect
        [Console]::Out.WriteLine("WORD\`t" + [int]$rect.X + "\`t" + [int]$rect.Y + "\`t" + [int]$rect.Width + "\`t" + [int]$rect.Height + "\`t" + $word.Text)
      }
    }
    [Console]::Out.WriteLine('DONE')
  } catch {
    $message = ($_.Exception.Message -replace "\\r?\\n", ' ')
    [Console]::Out.WriteLine('ERR ' + $message)
  }
  [Console]::Out.Flush()
}
`
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
