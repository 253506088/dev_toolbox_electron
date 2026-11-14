import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp, { type OverlayOptions } from 'sharp'
import type { WechatCaptureCrop } from '../../shared/wechat-capture'
import { findVoiceCandidates, hasNewTranscript, isVoiceStatusText, mergeVoiceTextLines, type VoiceCandidate, type VoiceRect, type VoiceText } from '../../shared/wechat-voice'
import { findVoiceBubbleRegions } from '../../shared/wechat-voice-image'
import { parseWindowHandle, TargetWindowMinimizedError } from './wechat-scroll-controller'
import { wechatVoiceCleanupScript, wechatVoiceScript } from './wechat-voice-native-script'

export interface VoiceConversionProgress {
  detected: number
  converted: number
  alreadyConverted: number
  failed: number
  changed: boolean
  warnings: string[]
}

export interface VoiceConversionOptions {
  timeoutMs?: number
  isCancelled: () => boolean
  onProgress?: (progress: VoiceConversionProgress) => void
  /** Runs before opening a candidate's menu, so callers can retain a clean viewport anchor. */
  beforeConvert?: (candidate: VoiceCandidate, viewport: VoiceRect) => Promise<void>
  /** Restores this screen and returns its net Y shift in logical pixels relative to beforeConvert. */
  restoreViewport?: () => Promise<number | void>
}

interface VoiceSnapshot {
  crop: VoiceRect
  words: VoiceText[]
  elements: VoiceText[]
  hash: string
  ocrAvailable: boolean
  pixelScale?: number
}

interface NativeReply { error?: string; code?: string; [key: string]: unknown }

/**
 * A dedicated helper owns only the menus it opened. Native/UIA operations are bounded and
 * cancellable. The helper stays alive across capture screens, while each conversion closes
 * its own menu before returning control to the capture loop.
 */
export class WechatVoiceController {
  private output = ''
  private stderr = ''
  private stopped = false
  private failure: Error | null = null
  private pending: { resolve: (reply: NativeReply) => void; reject: (error: Error) => void } | null = null
  private busy = false
  private menuOpen = false
  private stopPromise: Promise<void> | null = null
  private ocrImageSequence = 0
  private durationCache: { key: string; words: VoiceText[] } | null = null

  static start(sourceId: string, crop: WechatCaptureCrop): WechatVoiceController {
    if (process.platform !== 'win32') throw new Error('微信语音转文字目前仅支持 Windows')
    const handle = parseWindowHandle(sourceId)
    if (!handle) throw new Error('无法识别微信窗口句柄')
    if (!Object.values(crop).every((value) => Number.isFinite(value) && value >= 0 && value < 100) || crop.left + crop.right >= 100 || crop.top + crop.bottom >= 100) {
      throw new Error('语音识别区域无效')
    }
    const directory = mkdtempSync(join(tmpdir(), 'wechat-voice-'))
    const path = join(directory, 'voice.ps1')
    try {
      // -File avoids Windows' command-line length limit; the BOM preserves Chinese on Windows PowerShell 5.1.
      writeFileSync(path, '\ufeff' + wechatVoiceScript(handle, crop), 'utf8')
      // This is our own generated script. Set policy for this helper process only;
      // Windows' default Restricted policy otherwise blocks every -File launch.
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text', '-File', path], { windowsHide: true })
      return new WechatVoiceController(child, directory, handle)
    } catch (error) {
      rmSync(directory, { recursive: true, force: true })
      throw error
    }
  }

  private constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly directory: string, private readonly handle: string) {
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      this.output += chunk
      const lines = this.output.split(/\r?\n/)
      this.output = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('VOICE ')) continue
        try {
          const reply = JSON.parse(line.slice(6)) as NativeReply
          const pending = this.pending
          this.pending = null
          if (reply.error) pending?.reject(reply.code === 'minimized' ? new TargetWindowMinimizedError() : new Error(reply.error))
          else pending?.resolve(reply)
        } catch { this.fail(new Error('语音控制器返回了无效数据')) }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-1500) })
    child.stdin.on('error', (error) => this.fail(error))
    child.once('error', (error) => this.fail(error))
    child.once('exit', () => this.fail(new Error(this.stopped ? '语音处理已停止' : `语音控制器意外退出：${this.stderr.trim()}`)))
  }

  /** Validate the target and recognition backend before the capture loop moves the chat. */
  async validate(options: Pick<VoiceConversionOptions, 'isCancelled'>): Promise<void> {
    await this.command({ command: 'validate' }, options)
  }

  async convertVisible(options: VoiceConversionOptions): Promise<VoiceConversionProgress> {
    if (this.busy) throw new Error('语音处理正在运行')
    this.busy = true
    const progress: VoiceConversionProgress = { detected: 0, converted: 0, alreadyConverted: 0, failed: 0, changed: false, warnings: [] }
    try {
      if (options.isCancelled()) return progress
      const visited: VoiceCandidate[] = []
      // Expansion changes the message list. Re-detect from the top of the current viewport
      // after every operation, including messages that were not visible in its first snapshot.
      for (let checked = 0; ; checked += 1) {
        if (options.isCancelled()) break
        const snapshot = await this.snapshot(options)
        if (!snapshot.ocrAvailable && snapshot.elements.length === 0) {
          throw new Error('微信未暴露可访问性文字，且系统中文 OCR 不可用；请安装 Windows 中文 OCR 语言包后重试')
        }
        const candidates = findVoiceCandidates(snapshot.elements, snapshot.words, snapshot.crop)
          .sort((first, second) => first.y - second.y || first.x - second.x)
        const candidate = candidates.find((item) => !visited.some((previous) => sameVisibleCandidate(previous, item)))
        if (!candidate) break
        if (checked >= 120) throw new Error('本屏语音位置持续变化，已停止截图；请保持微信聊天静止后重试')
        progress.detected += 1
        let viewportShift = 0
        await options.beforeConvert?.(candidate, snapshot.crop)
        if (options.isCancelled()) break
        this.menuOpen = true
        const menu = await this.command({ command: 'open', x: Math.round(candidate.x + candidate.width / 2), y: Math.round(candidate.y + candidate.height / 2) }, options)
        if (menu.action === 'expanded') {
          progress.alreadyConverted += 1
          await this.closeMenu(options)
        } else if (menu.action === 'transcribe') {
          // Native code rechecks the exact label in the still-open popup before clicking.
          await this.command({ command: 'select' }, options)
          this.menuOpen = false
          progress.changed = true
          await this.waitForTranscript(snapshot, candidate, options)
          if (options.isCancelled()) break
          progress.converted += 1
          viewportShift = await options.restoreViewport?.() ?? 0
          if (!Number.isFinite(viewportShift)) throw new Error('语音视口返回了无效位移')
          if (options.isCancelled()) break
        } else {
          await this.closeMenu(options)
          // A plain text such as 3" is harmless: no recognized voice menu means no click.
          if (candidate.source === 'accessibility') throw new Error('已识别语音，但没有找到“语音转文字”菜单，请确认微信版本与聊天区域')
          progress.warnings.push(`未确认 ${candidate.seconds} 秒候选项的语音菜单，已跳过`)
        }
        if (viewportShift) for (const previous of visited) previous.y += viewportShift
        visited.push({ ...candidate, y: candidate.y + viewportShift })
        options.onProgress?.({ ...progress, warnings: [...progress.warnings] })
      }
      return progress
    } catch (error) {
      if (options.isCancelled()) return progress
      progress.failed += 1
      options.onProgress?.({ ...progress })
      throw error
    } finally {
      if (this.menuOpen && !this.stopped) {
        try { await this.command({ command: 'close' }, { isCancelled: () => false }) } catch { /* helper stop handles cleanup */ }
        this.menuOpen = false
      }
      this.busy = false
    }
  }

  private async waitForTranscript(before: VoiceSnapshot, candidate: VoiceCandidate, options: VoiceConversionOptions): Promise<void> {
    const deadline = Date.now() + Math.min(120_000, Math.max(3000, options.timeoutMs ?? 30_000))
    let previousHash = ''
    let stableSince = 0
    let lastMenuCheck = 0
    while (Date.now() < deadline) {
      await delay(350)
      if (options.isCancelled()) return
      // WeChat can pin the bottom of the history when a long transcript expands.
      // Restore the local anchor before resolving OCR durations, otherwise a different
      // bubble with the same duration could be mistaken for this voice.
      const viewportShift = await options.restoreViewport?.() ?? 0
      if (!Number.isFinite(viewportShift)) throw new Error('语音视口返回了无效位移')
      if (options.isCancelled()) return
      const current = await this.snapshot(options)
      const lines = mergeVoiceTextLines(current.words.length ? current.words : current.elements)
      const beforeText = (before.words.length ? before.words : before.elements).map((item) => item.text).join('\n')
      const newFailure = lines.find((item) => isVoiceStatusText(item.text) && /失败|无法|重试/.test(item.text) && !beforeText.includes(item.text))
      if (newFailure) throw new Error(`微信语音转文字失败：${newFailure.text}`)
      const busy = lines.some((item) => isVoiceStatusText(item.text) && /正在|中/.test(item.text))
      const currentText = current.words.length ? current.words : current.elements
      const detected = findVoiceCandidates(current.elements, current.words, current.crop)
      const anchor = candidate.id
        ? detected.find((item) => item.id === candidate.id)
        : detected.find((item) => sameVisibleCandidate({ ...candidate, y: candidate.y + viewportShift }, item))
      const belowVoice = anchor && currentText.filter((item) => item.y >= anchor.y + anchor.height * 0.75 && item.y <= anchor.y + Math.min(current.crop.height * 0.6, 500))
      const added = !!belowVoice && hasNewTranscript(before.words.length ? before.words : before.elements, belowVoice)
      if (!busy && anchor) {
        if (current.hash !== previousHash) stableSince = Date.now()
        else if (stableSince && Date.now() - stableSince >= 700) {
          if (added && current.hash !== before.hash) return
          // A bottom-edge voice can expand entirely below the selected crop. Its pixels
          // need not change, and a repeated transcript may add no new OCR words. The
          // actual collapse-text menu confirms completion in both cases without moving
          // away from the screenshot's starting point or selecting the menu again.
          if (Date.now() - lastMenuCheck >= 1000) {
            lastMenuCheck = Date.now()
            this.menuOpen = true
            const menu = await this.command({ command: 'open', x: Math.round(anchor.x + anchor.width / 2), y: Math.round(anchor.y + anchor.height / 2) }, options)
            await this.closeMenu(options)
            if (menu.action === 'expanded') return
          }
        }
        previousHash = current.hash
      } else {
        previousHash = ''
        stableSince = 0
      }
    }
    if (!options.isCancelled()) throw new Error('等待微信语音转文字超时，已暂停截图；请检查网络或手动完成该条语音转写后重试')
  }

  private async snapshot(options: Pick<VoiceConversionOptions, 'isCancelled'>): Promise<VoiceSnapshot> {
    const result = await this.command({ command: 'snapshot' }, options) as unknown as VoiceSnapshot
    if (result.ocrAvailable && result.pixelScale && existsSync(join(this.directory, 'frame.png'))) {
      await this.enhanceDurations(result, options)
    }
    return result
  }

  /** Windows OCR often omits a lone 3″. Add context to isolated bubbles only in the OCR input. */
  private async enhanceDurations(snapshot: VoiceSnapshot, options: Pick<VoiceConversionOptions, 'isCancelled'>): Promise<void> {
    const cacheKey = `${snapshot.hash}:${snapshot.crop.x}:${snapshot.crop.y}:${snapshot.pixelScale}`
    if (this.durationCache?.key === cacheKey) {
      snapshot.words.push(...this.durationCache.words)
      return
    }
    const additions: VoiceText[] = []
    const original = await sharp(join(this.directory, 'frame.png')).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const regions = findVoiceBubbleRegions(original.data, original.info.width, original.info.height, 3)
      .map((region) => trimBubbleHorizontalPadding(original.data, original.info.width, region))
    const pixelScale = snapshot.pixelScale!
    const known = findVoiceCandidates(snapshot.elements, snapshot.words, snapshot.crop)
    const pending = regions.filter((region) => !known.some((candidate) => {
      const x = (candidate.x - snapshot.crop.x) * pixelScale
      const y = (candidate.y - snapshot.crop.y) * pixelScale
      return x >= region.x && x <= region.x + region.width && y >= region.y && y <= region.y + region.height
    }))
    for (let start = 0; start < pending.length && !options.isCancelled();) {
      const rows: Array<{ region: VoiceRect; prefix: number; top: number; font: number }> = []
      let sheetHeight = 10
      let sheetWidth = 1
      while (start < pending.length) {
        const region = pending[start]
        const font = Math.max(12, Math.round(region.height * 0.4))
        const prefix = font * 5
        if (rows.length && sheetHeight + region.height + 20 > 1100) break
        rows.push({ region, prefix, top: sheetHeight, font })
        sheetWidth = Math.max(sheetWidth, prefix + region.width + 20)
        sheetHeight += region.height + 20
        start += 1
      }
      const inputs: OverlayOptions[] = []
      for (const row of rows) {
        const image = await sharp(original.data, { raw: { width: original.info.width, height: original.info.height, channels: 3 } })
          .extract({ left: row.region.x, top: row.region.y, width: row.region.width, height: row.region.height }).png().toBuffer()
        inputs.push({ input: image, left: row.prefix, top: row.top })
        inputs.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${row.prefix}" height="${row.region.height}"><rect width="100%" height="100%" fill="#edeef0"/><text x="10" y="${row.region.height * 0.7}" font-family="Microsoft YaHei" font-size="${row.font}" fill="#111">语音时间</text></svg>`), left: 0, top: row.top })
      }
      const sheet = await sharp({ create: { width: sheetWidth, height: sheetHeight, channels: 3, background: '#edeef0' } }).composite(inputs).png().toBuffer()
      const scale = Math.min(2, 2500 / Math.max(sheetWidth, sheetHeight))
      const imageName = `ocr-input-${++this.ocrImageSequence}.png`
      const imagePath = join(this.directory, imageName)
      await sharp(sheet).resize(Math.round(sheetWidth * scale), Math.round(sheetHeight * scale)).grayscale().normalize().png().toFile(imagePath)
      const reply = await this.command({ command: 'recognize', image: imageName }, options)
      try { rmSync(imagePath, { force: true }) } catch { /* WinRT may retain its decoder until the helper exits. */ }
      const mapped: VoiceText[] = []
      for (const item of reply.words as VoiceText[]) {
        const x = item.x / scale
        const y = item.y / scale
        const row = rows.find((entry) => x >= entry.prefix && x <= entry.prefix + entry.region.width && y >= entry.top && y <= entry.top + entry.region.height)
        if (!row) continue
        const match = /^[\s\d()（）•·<>《》»«›‹|丨]*?([1-9]\d?["“”″〃′']{1,2})$/.exec(item.text)
        mapped.push({
          text: match?.[1] ?? item.text,
          x: snapshot.crop.x + (x - row.prefix + row.region.x) / pixelScale,
          y: snapshot.crop.y + (y - row.top + row.region.y) / pixelScale,
          width: item.width / scale / pixelScale, height: item.height / scale / pixelScale
        })
      }
      additions.push(...findVoiceCandidates([], mapped, snapshot.crop))
    }
    if (!options.isCancelled()) this.durationCache = { key: cacheKey, words: additions }
    snapshot.words.push(...additions)
  }

  private async closeMenu(options: Pick<VoiceConversionOptions, 'isCancelled'>): Promise<void> {
    await this.command({ command: 'close' }, options)
    this.menuOpen = false
  }

  private command(message: Record<string, unknown>, options: Pick<VoiceConversionOptions, 'isCancelled'>): Promise<NativeReply> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.stopped || options.isCancelled()) return Promise.reject(new Error('语音处理已停止'))
    if (this.pending) return Promise.reject(new Error('语音控制器命令并发冲突'))
    return new Promise<NativeReply>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.fail(new Error('微信语音识别无响应，已停止截图'))
        void this.stop().catch(() => undefined)
      }, 20_000)
      const cancel = setInterval(() => { if (options.isCancelled()) void this.stop().catch(() => undefined) }, 100)
      const cleanup = (): void => { clearTimeout(timeout); clearInterval(cancel) }
      this.pending = {
        resolve: (reply) => { cleanup(); resolve(reply) },
        reject: (error) => { cleanup(); reject(error) }
      }
      this.child.stdin.write(JSON.stringify(message) + '\n', (error) => { if (error) this.fail(error) })
    })
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopNow()
    return this.stopPromise
  }

  private async stopNow(): Promise<void> {
    this.stopped = true
    this.fail(new Error('语音处理已停止'))
    try { writeFileSync(join(this.directory, 'cancelled'), '') } catch { /* Stopping the input process must not depend on writable storage. */ }
    if (this.child.exitCode === null && !this.child.killed) {
      this.child.stdin.write('{"command":"quit"}\n')
      await Promise.race([new Promise<void>((resolve) => this.child.once('exit', () => resolve())), delay(1200)])
      if (this.child.exitCode === null && !this.child.killed) {
        this.child.kill()
        await Promise.race([new Promise<void>((resolve) => this.child.once('exit', () => resolve())), delay(800)])
        // UIA/OCR providers can hang; the marker proves that this helper opened the menu.
        if (existsSync(join(this.directory, 'menu-open'))) {
          const cleanup = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(wechatVoiceCleanupScript(this.handle), 'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore' })
          cleanup.on('error', () => undefined)
          await Promise.race([new Promise<void>((resolve) => cleanup.once('exit', () => resolve())), delay(2500)])
          if (cleanup.exitCode === null && !cleanup.killed) cleanup.kill()
        }
      }
    }
    rmSync(this.directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
  }

  private fail(error: Error): void {
    this.failure ??= error
    this.pending?.reject(this.failure)
    this.pending = null
  }
}

function sameVisibleCandidate(first: VoiceCandidate, second: VoiceCandidate): boolean {
  if (first.id && second.id) return first.id === second.id
  return first.seconds === second.seconds &&
    Math.abs(first.x - second.x) <= Math.max(8, Math.min(first.width, second.width) * 0.3) &&
    Math.abs(first.y - second.y) <= Math.max(6, Math.min(first.height, second.height) * 0.6)
}

function trimBubbleHorizontalPadding(rgb: Uint8Array, imageWidth: number, region: VoiceRect): VoiceRect {
  const sample = ((region.y + Math.min(6, region.height - 1)) * imageWidth + region.x + Math.floor(region.width / 2)) * 3
  const background = (rgb[sample] + rgb[sample + 1] + rgb[sample + 2]) / 3
  let left = region.x + region.width
  let right = region.x
  for (let y = region.y + 3; y < region.y + region.height - 3; y += 1) {
    for (let x = region.x + 3; x < region.x + region.width - 3; x += 1) {
      const offset = (y * imageWidth + x) * 3
      const light = (rgb[offset] + rgb[offset + 1] + rgb[offset + 2]) / 3
      if ((background > 128 ? background - light : light - background) < 60) continue
      left = Math.min(left, x)
      right = Math.max(right, x)
    }
  }
  if (right <= left) return region
  left = Math.max(region.x, left - 5)
  right = Math.min(region.x + region.width, right + 6)
  return { ...region, x: left, width: right - left }
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)) }
