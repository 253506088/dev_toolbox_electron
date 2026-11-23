import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { WebContents } from 'electron'
import iconv from 'iconv-lite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SubtitleService } from '../src/main/services/subtitle-service'
import type { SubtitleBatchRequest, SubtitleBatchSnapshot, SubtitleScanResult } from '../src/shared/subtitle-api'

const executable = resolve('resources/ffmpeg/ffmpeg.exe')
const bundledFont = resolve('resources/subtitle-fonts/NotoSansSC.ttf')
const caption = '1\n00:00:00,700 --> 00:00:01,800\n内嵌中文字幕可独立播放\n\n'
const WIDTH = 640
const HEIGHT = 360

class BurnOwner extends EventEmitter {
  private destroyed = false
  constructor(readonly id: number) { super() }
  isDestroyed(): boolean { return this.destroyed }
  send(channel: string, snapshot: SubtitleBatchSnapshot): void { this.emit(channel, snapshot) }
  close(): void { this.destroyed = true; this.emit('destroyed') }
}

function owner(value: BurnOwner): WebContents { return value as unknown as WebContents }
function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
function ffmpeg(args: string[]): Buffer {
  const result = spawnSync(executable, args, { windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.toString('utf8'))
  return result.stdout
}
function probe(file: string): string {
  return spawnSync(executable, ['-hide_banner', '-i', file], { windowsHide: true, encoding: 'utf8', timeout: 15_000 }).stderr
}
function waitDone(subject: SubtitleService, fake: BurnOwner, batchId: string): Promise<SubtitleBatchSnapshot> {
  const current = subject.snapshot(owner(fake))
  if (current?.batchId === batchId && current.status !== 'running') return Promise.resolve(current)
  return new Promise((resolveResult, reject) => {
    const timeout = setTimeout(() => { fake.removeListener('subtitle:event', listener); reject(new Error('Burn batch timed out')) }, 30_000)
    const listener = (snapshot: SubtitleBatchSnapshot): void => {
      if (snapshot.batchId !== batchId || snapshot.status === 'running') return
      clearTimeout(timeout)
      fake.removeListener('subtitle:event', listener)
      resolveResult(snapshot)
    }
    fake.on('subtitle:event', listener)
  })
}
function request(scan: SubtitleScanResult, overrides: Partial<SubtitleBatchRequest> = {}): SubtitleBatchRequest {
  return { scanId: scan.scanId, items: scan.rows.filter((row) => row.subtitlePath).map((row) => ({ rowId: row.id, subtitlePath: row.subtitlePath! })), format: 'mp4', encoding: 'auto', offsetSeconds: 0, ...overrides }
}

/** 只解码视频流，明确禁用字幕流；白色/红色字必须已经存在于视频像素。 */
function countCaptionPixels(file: string, seconds: number): { white: number; red: number } {
  const pixels = ffmpeg(['-v', 'error', '-ss', String(seconds), '-sn', '-i', file, '-map', '0:v:0', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'])
  expect(pixels.length).toBe(WIDTH * HEIGHT * 3)
  let white = 0
  let red = 0
  for (let offset = WIDTH * Math.floor(HEIGHT * .55) * 3; offset < pixels.length; offset += 3) {
    const [r, g, b] = [pixels[offset], pixels[offset + 1], pixels[offset + 2]]
    // 字体抗锯齿和有损编码会使白色边缘变灰；蓝底的 R/G 为零，不会误判。
    if (r > 140 && g > 140 && b > 140) white++
    if (r > 160 && r > g + 80 && r > b + 80) red++
  }
  return { white, red }
}

describe.skipIf(!existsSync(executable) || !existsSync(bundledFont))('真实字幕烧录与独立视频可移植性', () => {
  let temporaryRoot: string
  let evidenceRoot: string
  let seed: string
  let counter = 0
  const subjects: SubtitleService[] = []

  beforeAll(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'dev-toolbox-burn-test-'))
    await mkdir(resolve('test-results'), { recursive: true })
    evidenceRoot = await mkdtemp(join(resolve('test-results'), 'subtitle-burn-evidence-'))
    seed = join(temporaryRoot, 'seed.mp4')
    ffmpeg(['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', `color=c=blue:s=${WIDTH}x${HEIGHT}:r=10:d=3`, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', seed])
  }, 30_000)
  afterAll(async () => {
    await Promise.all(subjects.map((subject) => subject.stopAll()))
    await rm(temporaryRoot, { recursive: true, force: true })
  })

  async function fixture(subtitle = caption, extension = 'srt'): Promise<{ directory: string; fonts: string; video: string; subtitle: string; subject: SubtitleService; fake: BurnOwner; scan: SubtitleScanResult }> {
    const number = ++counter
    const directory = join(temporaryRoot, `素材 '中文'[方括号], 空格 ${number}`)
    const fonts = join(temporaryRoot, `复制字体 ${number}`)
    await mkdir(directory)
    await mkdir(fonts)
    await copyFile(bundledFont, join(fonts, 'NotoSansSC.ttf'))
    const video = join(directory, "演示.E01 [1080p],'test'.mp4")
    const subtitleFile = join(directory, `演示.E01 中文,'字幕'.${extension}`)
    await copyFile(seed, video)
    await writeFile(subtitleFile, subtitle, 'utf8')
    const subject = new SubtitleService({ status: async () => ({ available: true, path: executable, message: 'Test FFmpeg ready' }) }, fonts)
    subjects.push(subject)
    const fake = new BurnOwner(number)
    return { directory, fonts, video, subtitle: subtitleFile, subject, fake, scan: await subject.scanPath(video, owner(fake)) }
  }

  it('默认烧录 MP4，脱离源视频、外挂字幕与字体后仍能直接看到中文字幕', async () => {
    const test = await fixture()
    const sourceHashes = [digest(await readFile(test.video)), digest(await readFile(test.subtitle))]
    const start = await test.subject.start(request(test.scan), owner(test.fake))
    expect(start.mode).toBe('burn')
    const complete = await waitDone(test.subject, test.fake, start.batchId)
    expect(complete.items[0].error).toBeUndefined()
    expect(complete.items[0].status).toBe('succeeded')
    expect(complete.items[0].outputPath).toMatch(/\.mp4$/)
    expect([digest(await readFile(test.video)), digest(await readFile(test.subtitle))]).toEqual(sourceHashes)

    const videoOnly = join(evidenceRoot, 'video-only')
    await mkdir(videoOnly)
    const moved = join(videoOnly, '换名后独立成品.mp4')
    await copyFile(complete.items[0].outputPath, moved)
    const sourceRenamed = `${test.directory} 已隔离`
    await rename(test.directory, sourceRenamed)
    await rename(test.fonts, `${test.fonts} 已隔离`)
    expect(existsSync(test.video)).toBe(false)
    expect(existsSync(test.subtitle)).toBe(false)
    expect(existsSync(test.fonts)).toBe(false)
    expect(await readdir(videoOnly)).toEqual(['换名后独立成品.mp4'])
    const metadata = probe(moved)
    expect(metadata).toContain('Video: h264')
    expect(metadata).toContain('yuv420p')
    expect(metadata).toContain('Audio: aac')
    expect(metadata).not.toContain('Subtitle:')
    expect(metadata).toMatch(/Duration:\s*00:00:03\./)
    const before = countCaptionPixels(moved, .2)
    const during = countCaptionPixels(moved, 1)
    const after = countCaptionPixels(moved, 2.5)
    expect(before.white).toBeLessThan(10)
    expect(during.white).toBeGreaterThan(100)
    expect(after.white).toBeLessThan(10)
    const copiedSource = join(sourceRenamed, basename(test.video))
    expect(countCaptionPixels(copiedSource, 1).white).toBeLessThan(10)
    for (const [label, time] of [['before', .2], ['during', 1], ['after', 2.5]] as const) {
      ffmpeg(['-v', 'error', '-ss', String(time), '-sn', '-i', moved, '-frames:v', '1', join(evidenceRoot, `${label}-video-only.png`)])
    }
    await writeFile(join(evidenceRoot, 'report.json'), JSON.stringify({ mode: complete.mode, isolatedVideo: moved, noExternalFiles: await readdir(videoOnly), originalPathsUnavailable: true, before, during, after, codecs: 'H264 / AAC', subtitleStreams: 0, decodedWithSn: true, metadata }, null, 2))
  }, 30_000)

  it('ASS 中文字的颜色和样式保留在画面里', async () => {
    const ass = '[Script Info]\nScriptType: v4.00+\nPlayResX: 640\nPlayResY: 360\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: RedChinese,Noto Sans SC,30,&H000000FF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,2,20,20,24,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.60,0:00:01.60,RedChinese,,0,0,0,,红色样式中文字幕\n'
    const test = await fixture(ass, 'ass')
    const started = await test.subject.start(request(test.scan, { mode: 'burn' }), owner(test.fake))
    const complete = await waitDone(test.subject, test.fake, started.batchId)
    expect(complete.items[0].error).toBeUndefined()
    expect(complete.items[0].status).toBe('succeeded')
    const output = complete.items[0].outputPath
    expect(countCaptionPixels(output, .2).red).toBeLessThan(10)
    expect(countCaptionPixels(output, 1).red).toBeGreaterThan(100)
    expect(countCaptionPixels(output, 2).red).toBeLessThan(10)
    ffmpeg(['-v', 'error', '-ss', '1', '-sn', '-i', output, '-frames:v', '1', join(evidenceRoot, 'ass-red-style.png')])
  }, 30_000)

  it('VTT 的中文字幕同样直接成为视频像素', async () => {
    const test = await fixture('WEBVTT\n\n00:00:00.700 --> 00:00:01.800\nVTT 中文字幕\n\n', 'vtt')
    const started = await test.subject.start(request(test.scan, { mode: 'burn' }), owner(test.fake))
    const complete = await waitDone(test.subject, test.fake, started.batchId)
    expect(complete.items[0].error).toBeUndefined()
    expect(complete.items[0].status).toBe('succeeded')
    expect(countCaptionPixels(complete.items[0].outputPath, 1).white).toBeGreaterThan(100)
    expect(probe(complete.items[0].outputPath)).not.toContain('Subtitle:')
  }, 30_000)

  it.each(['gb18030', 'utf16le'] as const)('%s 字幕在真实烧录后仍显示正确中文', async (encoding) => {
    const test = await fixture()
    const encoded = iconv.encode(caption, encoding)
    await writeFile(test.subtitle, encoding === 'utf16le' ? Buffer.concat([Buffer.from([0xff, 0xfe]), encoded]) : encoded)
    const originalHash = digest(await readFile(test.subtitle))
    const started = await test.subject.start(request(test.scan), owner(test.fake))
    const complete = await waitDone(test.subject, test.fake, started.batchId)
    expect(complete.items[0].error).toBeUndefined()
    expect(complete.items[0].status).toBe('succeeded')
    expect(countCaptionPixels(complete.items[0].outputPath, 1).white).toBeGreaterThan(100)
    expect(digest(await readFile(test.subtitle))).toBe(originalHash)
    ffmpeg(['-v', 'error', '-ss', '1', '-sn', '-i', complete.items[0].outputPath, '-frames:v', '1', join(evidenceRoot, `${encoding}-chinese.png`)])
  }, 30_000)

  it('缺失内置字体明确失败并清理半成品，不生成方块字幕的视频', async () => {
    const test = await fixture()
    const originalHashes = [digest(await readFile(test.video)), digest(await readFile(test.subtitle))]
    await rm(join(test.fonts, 'NotoSansSC.ttf'))
    const started = await test.subject.start(request(test.scan), owner(test.fake))
    const complete = await waitDone(test.subject, test.fake, started.batchId)
    expect(complete.items[0].status).toBe('failed')
    expect(complete.items[0].error).toContain('字体')
    expect(complete.items[0].outputPath).toBe('')
    expect((await readdir(test.scan.outputDirectory)).some((name) => name.endsWith('.mp4') || name.includes('.partial.'))).toBe(false)
    expect([digest(await readFile(test.video)), digest(await readFile(test.subtitle))]).toEqual(originalHashes)
  }, 30_000)

  it('无音轨的视频也能烧录字幕并独立播放', async () => {
    const test = await fixture()
    ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', `color=c=blue:s=${WIDTH}x${HEIGHT}:r=10:d=3`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', '-y', test.video])
    const started = await test.subject.start(request(test.scan), owner(test.fake))
    const complete = await waitDone(test.subject, test.fake, started.batchId)
    expect(complete.items[0].error).toBeUndefined()
    expect(complete.items[0].status).toBe('succeeded')
    expect(countCaptionPixels(complete.items[0].outputPath, 1).white).toBeGreaterThan(100)
    expect(probe(complete.items[0].outputPath)).toContain('Video: h264')
    expect(probe(complete.items[0].outputPath)).not.toContain('Audio:')
  }, 30_000)

  it('正偏移延后字幕；负偏移跨零时准确裁剪并保持视频时长', async () => {
    const test = await fixture('1\n00:00:00,200 --> 00:00:00,800\n时间偏移中文字幕\n\n')
    const positiveStart = await test.subject.start(request(test.scan, { offsetSeconds: .6 }), owner(test.fake))
    const positive = await waitDone(test.subject, test.fake, positiveStart.batchId)
    expect(positive.items[0].error).toBeUndefined()
    expect(positive.items[0].status).toBe('succeeded')
    expect(countCaptionPixels(positive.items[0].outputPath, .4).white).toBeLessThan(10)
    expect(countCaptionPixels(positive.items[0].outputPath, 1).white).toBeGreaterThan(100)
    expect(countCaptionPixels(positive.items[0].outputPath, 1.8).white).toBeLessThan(10)
    const negativeStart = await test.subject.start(request(test.scan, { offsetSeconds: -.5 }), owner(test.fake))
    const negative = await waitDone(test.subject, test.fake, negativeStart.batchId)
    expect(negative.items[0].error).toBeUndefined()
    expect(negative.items[0].status).toBe('succeeded')
    expect(countCaptionPixels(negative.items[0].outputPath, .1).white).toBeGreaterThan(100)
    expect(countCaptionPixels(negative.items[0].outputPath, .5).white).toBeLessThan(10)
    expect(probe(negative.items[0].outputPath)).toMatch(/Duration:\s*00:00:03\./)
  }, 30_000)

  it('真实编码进度出现后取消整批，并由 stopAll 等待半成品清理', async () => {
    const test = await fixture('1\n00:00:00,000 --> 00:00:20,000\n需要取消的中文字幕\n\n')
    ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=s=${WIDTH}x${HEIGHT}:r=30:d=20`, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', test.video])
    let stopped: Promise<void> | undefined
    let observedEncoding = false
    test.fake.on('subtitle:event', (snapshot: SubtitleBatchSnapshot) => {
      if (observedEncoding || snapshot.items[0].status !== 'running' || snapshot.items[0].progress <= .03) return
      observedEncoding = true
      stopped = test.subject.stopAll()
    })
    const started = await test.subject.start(request(test.scan), owner(test.fake))
    const complete = await waitDone(test.subject, test.fake, started.batchId)
    await stopped
    expect(observedEncoding).toBe(true)
    expect(complete.status).toBe('cancelled')
    expect(complete.items[0].status).toBe('cancelled')
    expect(complete.items[0].outputPath).toBe('')
    expect((await readdir(test.scan.outputDirectory)).some((name) => name.includes('.partial.'))).toBe(false)
    expect((await readdir(test.scan.outputDirectory)).some((name) => name.endsWith('.mp4'))).toBe(false)
    expect(existsSync(test.video) && existsSync(test.subtitle)).toBe(true)
  }, 30_000)
})
