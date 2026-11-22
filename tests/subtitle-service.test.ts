import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { WebContents } from 'electron'
import iconv from 'iconv-lite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildSubtitleMuxArgs, decodeSubtitle, parseSubtitleVideoProbe, SubtitleService } from '../src/main/services/subtitle-service'
import { shiftSubtitleTimestamps } from '../src/shared/subtitle-timing'
import type { SubtitleBatchRequest, SubtitleBatchSnapshot, SubtitleScanResult } from '../src/shared/subtitle-api'

const executable = resolve('resources/ffmpeg/ffmpeg.exe')
const srt = '1\n00:00:00,250 --> 00:00:01,250\n你好，中文字幕\n\n'

class FakeOwner extends EventEmitter {
  destroyed = false
  constructor(readonly id: number) { super() }
  isDestroyed(): boolean { return this.destroyed }
  send(channel: string, payload: SubtitleBatchSnapshot): void { this.emit(channel, payload) }
  close(): void { this.destroyed = true; this.emit('destroyed') }
}

function owner(value: FakeOwner): WebContents { return value as unknown as WebContents }
function service(): SubtitleService { return new SubtitleService({ status: async () => ({ available: true, path: executable, message: 'Ready' }) }) }
function request(scan: SubtitleScanResult, overrides: Partial<SubtitleBatchRequest> = {}): SubtitleBatchRequest {
  return { scanId: scan.scanId, items: scan.rows.filter((row) => row.subtitlePath).map((row) => ({ rowId: row.id, subtitlePath: row.subtitlePath! })), format: 'mkv', encoding: 'auto', offsetSeconds: 0, ...overrides }
}
function ffmpeg(args: string[]): string {
  const result = spawnSync(executable, args, { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 })
  if (result.status !== 0) throw new Error(`FFmpeg test fixture failed: ${result.stderr || result.error?.message}`)
  return result.stdout
}
function probe(path: string): string { return spawnSync(executable, ['-hide_banner', '-i', path], { encoding: 'utf8', windowsHide: true }).stderr }
function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
function waitDone(service: SubtitleService, fake: FakeOwner, batchId: string): Promise<SubtitleBatchSnapshot> {
  const current = service.snapshot(owner(fake))
  if (current?.batchId === batchId && current.status !== 'running') return Promise.resolve(current)
  return new Promise((resolveResult, reject) => {
    const timer = setTimeout(() => { fake.removeListener('subtitle:event', listener); reject(new Error('Subtitle batch timed out')) }, 30_000)
    const listener = (snapshot: SubtitleBatchSnapshot): void => {
      if (snapshot.batchId !== batchId || snapshot.status === 'running') return
      clearTimeout(timer)
      fake.removeListener('subtitle:event', listener)
      resolveResult(snapshot)
    }
    fake.on('subtitle:event', listener)
  })
}

describe('外挂字幕编码和封装参数', () => {
  it('识别 UTF-8、UTF-16 BOM、GB18030 并支持显式 Big5', () => {
    expect(decodeSubtitle(Buffer.from(`\uFEFF${srt}`), 'auto')).toBe(srt)
    expect(decodeSubtitle(Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode(srt, 'utf16le')]), 'auto')).toBe(srt)
    expect(decodeSubtitle(Buffer.concat([Buffer.from([0xfe, 0xff]), iconv.encode(srt, 'utf16be')]), 'auto')).toBe(srt)
    expect(decodeSubtitle(iconv.encode(srt, 'utf16le'), 'auto')).toBe(srt)
    expect(decodeSubtitle(iconv.encode(srt, 'gb18030'), 'auto')).toBe(srt)
    expect(decodeSubtitle(iconv.encode('繁體字幕', 'big5'), 'big5')).toBe('繁體字幕')
    expect(() => decodeSubtitle(iconv.encode(srt, 'gb18030'), 'utf8')).toThrow('UTF-8')
    expect(() => decodeSubtitle(Buffer.from(' \n'), 'auto')).toThrow('为空')
  })

  it('保留原始流、章节与字幕强制标记，将新增轨设为默认', () => {
    const args = buildSubtitleMuxArgs('movie.mkv', 'subtitle.ass', 'output.mkv', { format: 'mkv', offsetSeconds: -1.5 }, 2, '字幕.chs.ass')
    expect(args.slice(args.indexOf('-map'), args.indexOf('-map') + 6)).toEqual(['-map', '0', '-map', '-0:d?', '-map', '1:s:0'])
    expect(args[args.indexOf('-c') + 1]).toBe('copy')
    expect(args[args.indexOf('-itsoffset') + 1]).toBe('-1.5')
    expect(args[args.indexOf('-disposition:s:0') + 1]).toBe('-default')
    expect(args[args.indexOf('-disposition:s:2') + 1]).toBe('default')
    expect(args).toContain('language=chi')
    expect(args).toContain('-n')
    const mp4 = buildSubtitleMuxArgs('movie.mp4', 'subtitle.srt', 'out.mp4', { format: 'mp4', offsetSeconds: 0 }, 0, 'movie.en.srt')
    expect(mp4[mp4.indexOf('-c:s') + 1]).toBe('mov_text')
  })

  it('探测带语言与默认标记的视频，未知时长不阻止封装', () => {
    expect(parseSubtitleVideoProbe('Duration: 01:02:03.50\nStream #0:0: Video: h264\nStream #0:2(eng): Subtitle: ass (default)')).toEqual({ duration: 3723.5, subtitleCount: 1, subtitleCodecs: ['ass'], hasVideo: true })
    expect(parseSubtitleVideoProbe('Duration: N/A\nStream #0:0: Video: h264')).toEqual({ duration: 0, subtitleCount: 0, subtitleCodecs: [], hasVideo: true })
  })

  it('SRT/VTT/ASS 负偏移裁切跨零字幕，保留样式、文本与 VTT cue 设置', () => {
    const clipped = shiftSubtitleTimestamps(srt, 'srt', -0.5)
    expect(clipped).toContain('00:00:00,000 --> 00:00:00,750')
    const vtt = shiftSubtitleTimestamps('WEBVTT\n\ncue-id\n00:00.100 --> 00:00.900 align:start\ntext\n', 'vtt', -0.5)
    expect(vtt).toContain('00:00:00.000 --> 00:00:00.400 align:start')
    expect(vtt).toContain('cue-id')
    const ass = '[V4+ Styles]\nStyle: Default,Arial,20\n[Events]\nFormat: Layer, Start, End, Style, Text\nDialogue: 0,0:00:00.10,0:00:00.90,Default,{\\b1}text,with,commas'
    expect(shiftSubtitleTimestamps(ass, 'ass', -0.5)).toContain('Dialogue: 0,0:00:00.00,0:00:00.40,Default,{\\b1}text,with,commas')
    expect(shiftSubtitleTimestamps(ass, 'ass', 1)).toContain('Style: Default,Arial,20')
    expect(() => shiftSubtitleTimestamps(srt, 'srt', -10)).toThrow('没有可用')
  })
})

describe.skipIf(!existsSync(executable))('真实 FFmpeg 外挂字幕封装', () => {
  let root: string
  let seed: string
  let counter = 0
  const services: SubtitleService[] = []
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'dev-toolbox-subtitle-test-'))
    seed = join(root, 'seed.mp4')
    ffmpeg(['-hide_banner', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', seed])
  })
  afterAll(async () => {
    await Promise.all(services.map((subject) => subject.stopAll()))
    await rm(root, { recursive: true, force: true })
  })

  async function fixture(): Promise<{ dir: string; subject: SubtitleService; fake: FakeOwner }> {
    const dir = join(root, `剧集 中文 空格 ${++counter}`)
    await mkdir(dir)
    const subject = service()
    services.push(subject)
    return { dir, subject, fake: new FakeOwner(counter) }
  }

  it('目录只扫描当前层，单视频匹配同目录且手选字幕绑定会话', async () => {
    const { dir, subject, fake } = await fixture()
    const video = join(dir, 'Series.S01E01.mp4')
    await copyFile(seed, video)
    await writeFile(join(dir, 'Series.S01E01.chs.srt'), srt)
    await mkdir(join(dir, 'nested'))
    await copyFile(seed, join(dir, 'nested', 'Series.S01E02.mp4'))
    const scan = await subject.scanPath(dir, owner(fake))
    expect(scan.rows).toHaveLength(1)
    expect(scan.outputDirectory).toBe(join(dir, `内嵌字幕处理+${basename(dir)}`))
    const single = await subject.scanPath(video, owner(fake))
    expect(single.mode).toBe('video')
    expect(single.rows[0].subtitlePath).toContain('chs.srt')
    const manual = join(root, 'manual.srt')
    await writeFile(manual, srt)
    await expect(subject.start(request(single, { items: [{ rowId: single.rows[0].id, subtitlePath: manual }] }), owner(fake))).rejects.toThrow('匹配候选')
    const candidate = await subject.registerSubtitle(single.scanId, single.rows[0].id, manual, owner(fake))
    expect(candidate.reason).toBe('手动选择')
    await expect(subject.start(request(single), owner(new FakeOwner(900)))).rejects.toThrow('会话已失效')
    await expect(subject.start(request(single, { offsetSeconds: Number.NaN }), owner(fake))).rejects.toThrow('时间偏移')
    await expect(subject.start(request(single, { items: [...request(single).items, ...request(single).items] }), owner(fake))).rejects.toThrow('重复')
  })

  it('真实封装保留音视频字节、解码中文字幕、重复运行避让已有输出', async () => {
    const { dir, subject, fake } = await fixture()
    const video = join(dir, '剧集.S01E01.mp4')
    const subtitle = join(dir, '剧集.S01E01.chs.srt')
    await copyFile(seed, video)
    await writeFile(subtitle, iconv.encode(srt, 'gb18030'))
    const hashes = [digest(await readFile(video)), digest(await readFile(subtitle))]
    const scan = await subject.scanPath(dir, owner(fake))
    await mkdir(scan.outputDirectory)
    const existing = join(scan.outputDirectory, '剧集.S01E01.mkv')
    await writeFile(existing, 'existing output must survive')
    const start = await subject.start(request(scan), owner(fake))
    const end = await waitDone(subject, fake, start.batchId)
    expect(end.items[0].error).toBeUndefined()
    expect(end.items[0].status).toBe('succeeded')
    expect(end.items[0].outputPath).toContain(' (2).mkv')
    expect(await readFile(existing, 'utf8')).toBe('existing output must survive')
    expect([digest(await readFile(video)), digest(await readFile(subtitle))]).toEqual(hashes)
    for (const stream of ['v:0', 'a:0']) {
      const inputHash = ffmpeg(['-v', 'error', '-i', video, '-map', `0:${stream}`, '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-'])
      const outputHash = ffmpeg(['-v', 'error', '-i', end.items[0].outputPath, '-map', `0:${stream}`, '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-'])
      expect(outputHash).toBe(inputHash)
    }
    const extracted = ffmpeg(['-v', 'error', '-i', end.items[0].outputPath, '-map', '0:s:0', '-f', 'srt', '-'])
    expect(extracted).toContain('你好，中文字幕')
    expect(probe(end.items[0].outputPath)).toContain('(default)')
    const again = await subject.start(request(scan), owner(fake))
    const repeated = await waitDone(subject, fake, again.batchId)
    expect(repeated.items[0].status).toBe('succeeded')
    expect(repeated.items[0].outputPath).toContain(' (3).mkv')
    expect((await readdir(scan.outputDirectory)).some((name) => name.includes('.partial.'))).toBe(false)
  }, 30_000)

  it('VTT、ASS 和 MP4 的字幕轨可读取且时间偏移生效', async () => {
    const { dir, subject, fake } = await fixture()
    const video = join(dir, 'Movie.mp4')
    await copyFile(seed, video)
    const vtt = join(dir, 'Movie.vtt')
    await writeFile(vtt, 'WEBVTT\n\n00:00:00.250 --> 00:00:01.250\n中文字幕\n')
    const scan = await subject.scanPath(video, owner(fake))
    const start = await subject.start(request(scan, { offsetSeconds: 0.5 }), owner(fake))
    const result = await waitDone(subject, fake, start.batchId)
    expect(result.items[0].error).toBeUndefined()
    expect(result.items[0].status).toBe('succeeded')
    const extracted = ffmpeg(['-v', 'error', '-i', result.items[0].outputPath, '-map', '0:s:0', '-f', 'srt', '-'])
    const baselineStart = await subject.start(request(scan), owner(fake))
    const baselineResult = await waitDone(subject, fake, baselineStart.batchId)
    const baselineText = ffmpeg(['-v', 'error', '-i', baselineResult.items[0].outputPath, '-map', '0:s:0', '-f', 'srt', '-'])
    const startMilliseconds = (text: string): number => { const match = /00:00:(\d+),(\d+)/.exec(text)!; return Number(match[1]) * 1000 + Number(match[2]) }
    expect(startMilliseconds(extracted) - startMilliseconds(baselineText)).toBe(500)
    const ass = join(dir, 'Movie.ass')
    await writeFile(ass, '[Script Info]\nScriptType: v4.00+\nPlayResX: 160\nPlayResY: 90\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,20,&H0000FFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.25,0:00:01.25,Default,,0,0,0,,样式字幕\n')
    await subject.registerSubtitle(scan.scanId, scan.rows[0].id, ass, owner(fake))
    const assRequest = request(scan, { items: [{ rowId: scan.rows[0].id, subtitlePath: ass }] })
    const assStart = await subject.start(assRequest, owner(fake))
    const assResult = await waitDone(subject, fake, assStart.batchId)
    expect(assResult.items[0].status).toBe('succeeded')
    const assOut = ffmpeg(['-v', 'error', '-i', assResult.items[0].outputPath, '-map', '0:s:0', '-c', 'copy', '-f', 'ass', '-'])
    expect(assOut).toContain('Style: Default,Arial,20')
    const mp4Start = await subject.start(request(scan, { format: 'mp4' }), owner(fake))
    const mp4Result = await waitDone(subject, fake, mp4Start.batchId)
    expect(mp4Result.items[0].status).toBe('succeeded')
    expect(probe(mp4Result.items[0].outputPath)).toContain('Subtitle: mov_text')
  }, 30_000)

  it('单项失败后继续后续视频，失败和取消都不留下半成品', async () => {
    const { dir, subject, fake } = await fixture()
    await copyFile(seed, join(dir, 'Series.E01.mp4'))
    await copyFile(seed, join(dir, 'Series.E02.mp4'))
    await writeFile(join(dir, 'Series.E01.srt'), 'invalid subtitle')
    await writeFile(join(dir, 'Series.E02.srt'), srt)
    const scan = await subject.scanPath(dir, owner(fake))
    const start = await subject.start(request(scan), owner(fake))
    const result = await waitDone(subject, fake, start.batchId)
    expect(result.items.map((item) => item.status)).toEqual(['failed', 'succeeded'])
    expect((await readdir(scan.outputDirectory)).some((name) => name.includes('.partial.'))).toBe(false)
    const cancelled = await subject.start(request(scan), owner(fake))
    subject.cancel(cancelled.batchId, owner(fake))
    const cancelResult = await waitDone(subject, fake, cancelled.batchId)
    expect(cancelResult.status).toBe('cancelled')
    expect(cancelResult.items.every((item) => item.status === 'cancelled')).toBe(true)
    expect((await readdir(scan.outputDirectory)).some((name) => name.includes('.partial.'))).toBe(false)
  }, 30_000)

  it('MOV 时间码数据不妨碍 MKV 封装，既有 mov_text 字幕转为兼容内置轨', async () => {
    const { dir, subject, fake } = await fixture()
    const movie = join(dir, 'Movie.mov')
    ffmpeg(['-hide_banner', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-timecode', '00:00:00:00', movie])
    await writeFile(join(dir, 'Movie.srt'), srt)
    const scan = await subject.scanPath(movie, owner(fake))
    const start = await subject.start(request(scan), owner(fake))
    const result = await waitDone(subject, fake, start.batchId)
    expect(result.items[0].error).toBeUndefined()
    expect(result.items[0].status).toBe('succeeded')
    expect(probe(result.items[0].outputPath)).not.toContain('Data:')
    const originalSubtitle = join(root, `original-${counter}.srt`)
    await writeFile(originalSubtitle, '1\n00:00:00,100 --> 00:00:00,900\noriginal\n')
    const existing = join(dir, 'Existing.mp4')
    ffmpeg(['-hide_banner', '-i', seed, '-i', originalSubtitle, '-map', '0', '-map', '1', '-c', 'copy', '-c:s', 'mov_text', '-disposition:s:0', 'default+forced', existing])
    await writeFile(join(dir, 'Existing.chs.srt'), srt)
    const existingScan = await subject.scanPath(existing, owner(fake))
    const embedded = await subject.start(request(existingScan), owner(fake))
    const embeddedResult = await waitDone(subject, fake, embedded.batchId)
    expect(embeddedResult.items[0].status).toBe('succeeded')
    const description = probe(embeddedResult.items[0].outputPath)
    expect(parseSubtitleVideoProbe(description).subtitleCount).toBe(2)
    expect(description).toMatch(/Subtitle: subrip[^\r\n]*\(forced\)/)
    expect(description).toMatch(/Subtitle: subrip[^\r\n]*\(default\)/)
  }, 30_000)

  it('保留原有附件、强制字幕和章节，并在关闭页面时完成清理', async () => {
    const { dir, subject, fake } = await fixture()
    const existingSubtitle = join(root, `attachment-sub-${counter}.srt`)
    const attachment = join(root, `annotation-${counter}.txt`)
    const chapters = join(root, `chapters-${counter}.ffmetadata`)
    await writeFile(existingSubtitle, srt)
    await writeFile(attachment, 'attachment bytes survive')
    await writeFile(chapters, ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1000\ntitle=Preserved chapter\n')
    const video = join(dir, 'Attached.mkv')
    ffmpeg(['-hide_banner', '-i', seed, '-i', existingSubtitle, '-f', 'ffmetadata', '-i', chapters, '-map', '0', '-map', '1', '-map_chapters', '2', '-c', 'copy', '-disposition:s:0', 'default+forced', '-attach', attachment, '-metadata:s:t:0', 'mimetype=text/plain', video])
    await writeFile(join(dir, 'Attached.chs.srt'), srt)
    const scan = await subject.scanPath(video, owner(fake))
    const start = await subject.start(request(scan), owner(fake))
    const result = await waitDone(subject, fake, start.batchId)
    expect(result.items[0].status).toBe('succeeded')
    const description = probe(result.items[0].outputPath)
    expect(description).toContain('Attachment:')
    expect(description).toContain(basename(attachment))
    expect(description).toMatch(/Subtitle: subrip[^\r\n]*\(forced\)/)
    expect(description).toContain('Preserved chapter')
    let activeProcess = false
    const closed = new Promise<void>((resolveResult) => { fake.once('destroyed', resolveResult) })
    fake.on('subtitle:event', (snapshot: SubtitleBatchSnapshot) => {
      if (snapshot.items[0].message === '正在封装字幕（复制音视频流）') {
        setTimeout(() => {
          activeProcess = Boolean((subject as unknown as { batches: Map<string, { child?: unknown }> }).batches.get(snapshot.batchId)?.child)
          fake.close()
        }, 1)
      }
    })
    await subject.start(request(scan), owner(fake))
    await closed
    await subject.stopAll()
    expect(activeProcess).toBe(true)
    expect(subject.hasRunning()).toBe(false)
    expect((await readdir(scan.outputDirectory)).some((name) => name.includes('.partial.'))).toBe(false)
  }, 30_000)

  it('真实负偏移裁切零前字幕且视频时长不延长，全部移出的视频不输出', async () => {
    const { dir, subject, fake } = await fixture()
    const video = join(dir, 'Timing.mp4')
    await copyFile(seed, video)
    const subtitle = join(dir, 'Timing.srt')
    const content = '1\n00:00:00,100 --> 00:00:00,900\ncross zero\n\n2\n00:00:00,010 --> 00:00:00,020\ndiscard\n'
    await writeFile(subtitle, content)
    const scan = await subject.scanPath(video, owner(fake))
    const baseline = await subject.start(request(scan), owner(fake))
    const original = await waitDone(subject, fake, baseline.batchId)
    const shifted = await subject.start(request(scan, { offsetSeconds: -0.5 }), owner(fake))
    const shiftedResult = await waitDone(subject, fake, shifted.batchId)
    expect(shiftedResult.items[0].status).toBe('succeeded')
    expect(parseSubtitleVideoProbe(probe(shiftedResult.items[0].outputPath)).duration).toBe(parseSubtitleVideoProbe(probe(original.items[0].outputPath)).duration)
    const extracted = ffmpeg(['-v', 'error', '-i', shiftedResult.items[0].outputPath, '-map', '0:s:0', '-f', 'srt', '-'])
    expect(extracted).toContain('00:00:00,023 --> 00:00:00,423')
    expect(extracted).not.toContain('discard')
    expect(await readFile(subtitle, 'utf8')).toBe(content)
    const absent = await subject.start(request(scan, { offsetSeconds: -10 }), owner(fake))
    const absentResult = await waitDone(subject, fake, absent.batchId)
    expect(absentResult.items[0].status).toBe('failed')
    expect(absentResult.items[0].error).toContain('没有可用')
    expect((await readdir(scan.outputDirectory)).some((name) => name.includes('.partial.'))).toBe(false)
  }, 30_000)

  it('运行中取消等待子进程关闭，其他页面不能取消，输出目录链接被拒绝', async () => {
    const { dir, subject, fake } = await fixture()
    await copyFile(seed, join(dir, 'Movie.mp4'))
    await writeFile(join(dir, 'Movie.srt'), srt)
    const scan = await subject.scanPath(dir, owner(fake))
    let activeProcess = false
    fake.on('subtitle:event', (snapshot: SubtitleBatchSnapshot) => {
      if (snapshot.items[0].message === '正在封装字幕（复制音视频流）') {
        setTimeout(() => {
          activeProcess = Boolean((subject as unknown as { batches: Map<string, { child?: unknown }> }).batches.get(snapshot.batchId)?.child)
          subject.cancel(snapshot.batchId, owner(fake))
        }, 1)
      }
    })
    const started = await subject.start(request(scan), owner(fake))
    expect(() => subject.cancel(started.batchId, owner(new FakeOwner(999)))).toThrow('不属于当前页面')
    const cancelled = await waitDone(subject, fake, started.batchId)
    expect(activeProcess).toBe(true)
    expect(cancelled.items[0].status).toBe('cancelled')
    expect((await readdir(scan.outputDirectory)).some((name) => name.includes('.partial.'))).toBe(false)
    await rm(scan.outputDirectory, { recursive: true })
    await symlink(dir, scan.outputDirectory, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(subject.start(request(scan), owner(fake))).rejects.toThrow('输出目录是链接')
    expect((await readFile(join(dir, 'Movie.mp4'))).byteLength).toBeGreaterThan(0)
  }, 30_000)
})
