import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { appendFile, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import type { WebContents } from 'electron'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SubtitleBatchRequest, SubtitleBatchSnapshot, SubtitleScanResult } from '../src/shared/subtitle-api'
import { SubtitleService } from '../src/main/services/subtitle-service'

const executable = resolve('resources/ffmpeg/ffmpeg.exe')
const bundledFont = resolve('resources/subtitle-fonts/NotoSansSC.ttf')
const WIDTH = 640
const HEIGHT = 360

class EmbeddedOwner extends EventEmitter {
  private destroyed = false
  constructor(readonly id: number) { super() }
  isDestroyed(): boolean { return this.destroyed }
  send(channel: string, snapshot: SubtitleBatchSnapshot): void { this.emit(channel, snapshot) }
  close(): void { this.destroyed = true; this.emit('destroyed') }
}
const owner = (value: EmbeddedOwner): WebContents => value as unknown as WebContents
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
function ffmpeg(args: string[]): Buffer {
  const result = spawnSync(executable, args, { windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.toString('utf8'))
  return result.stdout
}
function probe(file: string): string {
  return spawnSync(executable, ['-hide_banner', '-i', file], { encoding: 'utf8', windowsHide: true, timeout: 15_000 }).stderr
}
function ass(text: string, colour = '&H00FFFFFF'): string {
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${WIDTH}\nPlayResY: ${HEIGHT}\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Noto Sans SC,24,${colour},&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,18,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.50,0:00:02.00,Default,,0,0,0,,${text}\n`
}
function captions(file: string, seconds: number): { white: number; red: number } {
  const pixels = ffmpeg(['-v', 'error', '-ss', String(seconds), '-sn', '-i', file, '-map', '0:v:0', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'])
  expect(pixels.length).toBe(WIDTH * HEIGHT * 3)
  let white = 0; let red = 0
  for (let offset = WIDTH * 260 * 3; offset < pixels.length; offset += 3) {
    const r = pixels[offset]; const g = pixels[offset + 1]; const b = pixels[offset + 2]
    if (r > 140 && g > 140 && b > 140) white++
    if (r > 160 && r > g + 80 && r > b + 80) red++
  }
  return { white, red }
}
function request(scan: SubtitleScanResult, overrides: Partial<SubtitleBatchRequest> = {}): SubtitleBatchRequest {
  return { scanId: scan.scanId, items: scan.rows.filter(row => row.subtitleSource).map(row => ({ rowId: row.id, source: row.subtitleSource })), mode: 'burn', acceleration: 'cpu-fast', resolution: 'source', format: 'mp4', encoding: 'auto', offsetSeconds: 0, ...overrides }
}
function waitDone(subject: SubtitleService, fake: EmbeddedOwner, batchId: string): Promise<SubtitleBatchSnapshot> {
  const current = subject.snapshot(owner(fake))
  if (current?.batchId === batchId && current.status !== 'running') return Promise.resolve(current)
  return new Promise((resolveResult, reject) => {
    const timer = setTimeout(() => { fake.removeListener('subtitle:event', listener); reject(new Error('Embedded subtitle batch timed out')) }, 30_000)
    const listener = (snapshot: SubtitleBatchSnapshot): void => {
      if (snapshot.batchId !== batchId || snapshot.status === 'running') return
      clearTimeout(timer); fake.removeListener('subtitle:event', listener); resolveResult(snapshot)
    }
    fake.on('subtitle:event', listener)
  })
}

describe.skipIf(!existsSync(executable) || !existsSync(bundledFont))('真实内置字幕选择、烧录与源保护', () => {
  let temporaryRoot: string
  let evidenceRoot: string
  let seed: string
  let master: string
  let counter = 0
  const subjects: SubtitleService[] = []

  beforeAll(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'dev-toolbox-embedded-test-'))
    await mkdir(resolve('test-results'), { recursive: true })
    evidenceRoot = await mkdtemp(join(resolve('test-results'), 'embedded-subtitle-evidence-'))
    seed = join(temporaryRoot, 'seed.mp4')
    master = join(temporaryRoot, 'master.mkv')
    const simplified = join(temporaryRoot, 'simplified.ass')
    const traditional = join(temporaryRoot, 'traditional.ass')
    const signs = join(temporaryRoot, 'english.srt')
    await writeFile(simplified, ass('已内置简体字幕无需外挂'))
    await writeFile(traditional, ass('繁體字幕紅色樣式', '&H000000FF'))
    await writeFile(signs, '1\n00:00:00,500 --> 00:00:02,000\nEnglish Signs\n')
    ffmpeg(['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', `color=c=blue:s=${WIDTH}x${HEIGHT}:r=10:d=2.5`, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2.5', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', seed])
    ffmpeg(['-hide_banner', '-v', 'error', '-i', seed, '-i', simplified, '-i', traditional, '-i', signs, '-map', '0:v:0', '-map', '0:a:0', '-map', '1:0', '-map', '2:0', '-map', '3:0', '-c', 'copy',
      '-metadata:s:s:0', 'language=chi', '-metadata:s:s:0', 'title=chs&jpn[Haruhana]', '-disposition:s:0', 'default',
      '-metadata:s:s:1', 'language=chi', '-metadata:s:s:1', 'title=cht&jpn[Haruhana]', '-disposition:s:1', '0',
      '-metadata:s:s:2', 'language=eng', '-metadata:s:s:2', 'title=English Signs & Songs', '-disposition:s:2', 'default+forced',
      '-attach', bundledFont, '-metadata:s:t:0', 'filename=safe-font.ttf', '-metadata:s:t:0', 'mimetype=font/ttf', master])
  }, 30_000)
  afterAll(async () => {
    await Promise.all(subjects.map(subject => subject.stopAll()))
    const child = relative(resolve(tmpdir()), resolve(temporaryRoot))
    if (!child || child.startsWith('..') || isAbsolute(child) || !basename(temporaryRoot).startsWith('dev-toolbox-embedded-test-')) throw new Error('Refusing to remove an unexpected test directory')
    await rm(temporaryRoot, { recursive: true, force: true })
  })

  async function fixture(): Promise<{ directory: string; video: string; subject: SubtitleService; fake: EmbeddedOwner; scan: SubtitleScanResult }> {
    const directory = join(temporaryRoot, `内置 '中文'[轨道], ${++counter}`)
    await mkdir(directory)
    const video = join(directory, 'Series.S01E01.mkv')
    await copyFile(master, video)
    const subject = new SubtitleService({ status: async () => ({ available: true, path: executable, message: 'Test FFmpeg ready' }) })
    subjects.push(subject)
    const fake = new EmbeddedOwner(counter)
    return { directory, video, subject, fake, scan: await subject.scanPath(directory, owner(fake)) }
  }

  it('只有MKV也自动识别中文内置轨，未依赖外挂路径或递归子目录', async () => {
    const test = await fixture()
    expect(test.scan.rows).toHaveLength(1)
    expect(test.scan.subtitleCount).toBe(0)
    expect(test.scan.embeddedSubtitleCount).toBe(3)
    expect(test.scan.rows[0].subtitlePath).toBeNull()
    expect(test.scan.rows[0].subtitleSource).toEqual({ kind: 'embedded', streamIndex: 2 })
    expect(test.scan.rows[0].embeddedTracks).toHaveLength(3)
    expect(test.scan.rows[0].embeddedFontCount).toBe(1)
    await mkdir(join(test.directory, 'nested'))
    await copyFile(master, join(test.directory, 'nested', 'Series.S01E02.mkv'))
    expect((await test.subject.scanPath(test.directory, owner(test.fake))).rows).toHaveLength(1)
  })

  it('自动选择的简体轨成为画面，成品改名隔离源视频和字体后仍独立显示', async () => {
    const test = await fixture()
    const before = digest(await readFile(test.video))
    const started = await test.subject.start(request(test.scan), owner(test.fake))
    const finished = await waitDone(test.subject, test.fake, started.batchId)
    const item = finished.items[0]
    expect(item.error).toBeUndefined()
    expect(item.status).toBe('succeeded')
    expect(item.source).toEqual({ kind: 'embedded', streamIndex: 2 })
    expect(item.actualEncoder).toBe('libx264')
    expect(digest(await readFile(test.video))).toBe(before)
    expect(probe(item.outputPath)).not.toContain('Subtitle:')
    expect(captions(item.outputPath, 0).white).toBe(0)
    expect(captions(item.outputPath, 1).white).toBeGreaterThan(100)
    expect(captions(item.outputPath, 1).red).toBe(0)
    const independent = join(evidenceRoot, 'video-only')
    await mkdir(independent)
    const copied = join(independent, 'copied-and-renamed.mp4')
    await copyFile(item.outputPath, copied)
    expect(await readdir(independent)).toEqual(['copied-and-renamed.mp4'])
    const moved = `${test.directory}-isolated`
    expect(relative(temporaryRoot, moved).startsWith('..')).toBe(false)
    await rename(test.directory, moved)
    expect(existsSync(test.video)).toBe(false)
    expect(captions(copied, 1).white).toBeGreaterThan(100)
    ffmpeg(['-v', 'error', '-ss', '1', '-sn', '-i', copied, '-frames:v', '1', join(evidenceRoot, 'independent-chinese.png')])
  }, 30_000)

  it('显式改选繁体轨只烧录该轨，并保留红色ASS样式', async () => {
    const test = await fixture()
    const started = await test.subject.start(request(test.scan, { items: [{ rowId: test.scan.rows[0].id, source: { kind: 'embedded', streamIndex: 3 } }] }), owner(test.fake))
    const finished = await waitDone(test.subject, test.fake, started.batchId)
    expect(finished.items[0].error).toBeUndefined()
    expect(finished.items[0].status).toBe('succeeded')
    expect(captions(finished.items[0].outputPath, 1).red).toBeGreaterThan(100)
    expect(captions(finished.items[0].outputPath, 1).white).toBe(0)
    expect(probe(finished.items[0].outputPath)).not.toContain('Subtitle:')
  }, 30_000)

  it('拒绝任意流、附件流、其它扫描会话和模糊的内外来源请求', async () => {
    const test = await fixture()
    const rowId = test.scan.rows[0].id
    for (const streamIndex of [0, 1, 5, 999, -1, 2.5]) {
      await expect(test.subject.start(request(test.scan, { items: [{ rowId, source: { kind: 'embedded', streamIndex } }] }), owner(test.fake))).rejects.toThrow()
    }
    await expect(test.subject.start(request(test.scan), owner(new EmbeddedOwner(999)))).rejects.toThrow()
    await expect(test.subject.start(request(test.scan, { items: [{ rowId: 'wrong-row', source: { kind: 'embedded', streamIndex: 2 } }] }), owner(test.fake))).rejects.toThrow()
    await expect(test.subject.start(request(test.scan, { items: [{ rowId, source: { kind: 'embedded', streamIndex: 2 }, subtitlePath: 'ambiguous.srt' }] }), owner(test.fake))).rejects.toThrow()
    await expect(test.subject.start(request(test.scan, { mode: 'soft' }), owner(test.fake))).rejects.toThrow()
    expect((await readdir(test.directory)).filter(name => !name.endsWith('.mkv'))).toEqual([])
  })

  it('源文件在扫描后被替换时要求重扫，不用旧流索引继续处理', async () => {
    const test = await fixture()
    await appendFile(test.video, '\0')
    await expect(test.subject.start(request(test.scan), owner(test.fake))).rejects.toThrow(/变化|改变|重新|失效/)
    expect(test.subject.snapshot(owner(test.fake))).toBeNull()
  })

  it('取消提取和准备阶段保留源文件，等待项与半成品全部收尾', async () => {
    const test = await fixture()
    const sourceHash = digest(await readFile(test.video))
    const started = await test.subject.start(request(test.scan), owner(test.fake))
    test.subject.cancel(started.batchId, owner(test.fake))
    const finished = await waitDone(test.subject, test.fake, started.batchId)
    await test.subject.stopAll()
    expect(finished.status).toBe('cancelled')
    expect(finished.items[0].status).toBe('cancelled')
    expect(digest(await readFile(test.video))).toBe(sourceHash)
    expect((await readdir(test.scan.outputDirectory)).some(name => name.includes('.partial.'))).toBe(false)
  })

  it('实际提取子进程运行时取消，等close后清除临时字幕与字体', async () => {
    const test = await fixture()
    const sourceHash = digest(await readFile(test.video))
    let activeExtraction = false
    let scheduled = false
    let temporaryFiles: string[] = []
    test.fake.on('subtitle:event', (snapshot: SubtitleBatchSnapshot) => {
      if (scheduled || !snapshot.items[0].message.includes('正在提取视频内置字幕')) return
      scheduled = true
      // emit 后同一调用栈立即 spawn；微任务先于其 close 事件，确保确实取消了提取进程。
      queueMicrotask(() => {
        const child = (test.subject as unknown as { batches: Map<string, { child?: { spawnargs: string[] } }> }).batches.get(snapshot.batchId)?.child
        activeExtraction = Boolean(child?.spawnargs.some(argument => argument.startsWith('-dump_attachment:')))
        temporaryFiles = child?.spawnargs.filter(argument => argument.includes('embedded-subtitle.') || argument.includes('embedded-font-')) ?? []
        test.subject.cancel(snapshot.batchId, owner(test.fake))
      })
    })
    const started = await test.subject.start(request(test.scan), owner(test.fake))
    const finished = await waitDone(test.subject, test.fake, started.batchId)
    await test.subject.stopAll()
    expect(activeExtraction).toBe(true)
    expect(temporaryFiles.length).toBeGreaterThan(0)
    expect(finished.items[0].status).toBe('cancelled')
    expect(temporaryFiles.every(file => !existsSync(file))).toBe(true)
    expect(digest(await readFile(test.video))).toBe(sourceHash)
    expect((await readdir(test.scan.outputDirectory)).some(name => name.includes('.partial.'))).toBe(false)
    expect(test.subject.hasRunning()).toBe(false)
  })

  it.runIf(process.env.SUBTITLE_EMBEDDED_QSV_TEST === '1')('本机真实检测通过后，缺省auto使用QSV烧录内置轨并保原尺寸', async () => {
    const test = await fixture()
    const hardware = await test.subject.hardwareStatus()
    expect(hardware.qsvAvailable).toBe(true)
    const started = await test.subject.start(request(test.scan, { acceleration: 'auto' }), owner(test.fake))
    const finished = await waitDone(test.subject, test.fake, started.batchId)
    expect(finished.items[0].status).toBe('succeeded')
    expect(finished.items[0].actualEncoder).toBe('h264_qsv')
    expect(finished.items[0].actualDecoder).toBe('h264_qsv')
    expect(finished.items[0].outputWidth).toBe(WIDTH)
    expect(finished.items[0].outputHeight).toBe(HEIGHT)
    expect(captions(finished.items[0].outputPath, 1).white).toBeGreaterThan(100)
  }, 30_000)
})
