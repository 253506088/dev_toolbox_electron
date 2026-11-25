import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SubtitleEncodingService } from '../src/main/services/subtitle-encoding-service'
import { SubtitleService } from '../src/main/services/subtitle-service'
import type { SubtitleBatchRequest, SubtitleBatchSnapshot } from '../src/shared/subtitle-api'

const mocked = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocked.spawn }))

const metadata = 'Duration: 00:00:10.00\nStream #0:0: Video: hevc (Main 10), yuv420p10le(tv, bt709), 3840x2160 [SAR 1:1], 24 fps\nStream #0:1: Audio: flac, 48000 Hz, stereo\n'
const caption = '1\n00:00:01,000 --> 00:00:08,000\n模拟字幕\n'

class TestOwner extends EventEmitter {
  id = 11
  history: SubtitleBatchSnapshot[] = []
  isDestroyed(): boolean { return false }
  send(channel: string, snapshot: SubtitleBatchSnapshot): void {
    if (channel === 'subtitle:event') this.history.push(snapshot)
    this.emit(channel, snapshot)
  }
}
function owner(value: TestOwner): WebContents { return value as unknown as WebContents }
function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }

class TestProcess extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  closed = false
  killed = false
  kill = vi.fn(() => {
    this.killed = true
    setTimeout(() => this.close(null), 10)
    return true
  })
  close(code: number | null): void {
    if (this.closed) return
    this.closed = true
    this.emit('close', code)
  }
}

interface ProcessScenario {
  failedProbe?: boolean
  firstEncodingFails?: boolean
  holdEncoding?: boolean
  onFonts?(files: string[]): void
}

function simulateProcesses(scenario: ProcessScenario = {}): { finish(): void; ready: Promise<void>; processes: TestProcess[] } {
  const processes: TestProcess[] = []
  let encodingCount = 0
  let held: TestProcess | undefined
  let resolveReady!: () => void
  const ready = new Promise<void>((resolveResult) => { resolveReady = resolveResult })
  mocked.spawn.mockImplementation((_executable: string, args: string[], options: { cwd?: string }) => {
    const child = new TestProcess()
    processes.push(child)
    setImmediate(() => {
      void (async () => {
        if (!args.includes('-vf')) {
          child.stderr.write(metadata)
          child.close(1)
          return
        }
        if (args.includes('-frames:v')) {
          child.stderr.write(scenario.failedProbe ? 'QSV device unavailable\n' : 'frame=4\nout_time_us=166667\nprogress=end\n')
          child.close(scenario.failedProbe ? 1 : 0)
          return
        }
        encodingCount++
        const output = args.at(-1)!
        await writeFile(output, 'mock encoded output')
        if (options.cwd) scenario.onFonts?.(await readdir(join(options.cwd, 'fonts')))
        if (scenario.firstEncodingFails && encodingCount === 1) {
          child.stderr.write('QSV device lost during encoding\n')
          child.close(1)
          return
        }
        child.stderr.write('frame=120\nfps=30.82\nout_time_us=5000000\nspeed=1.28x\nprogress=continue\n')
        held = child
        resolveReady()
        if (!scenario.holdEncoding) {
          child.stderr.write('[mp4 @ 0] Starting second pass: moving the moov atom to the beginning of the file\n')
          if (!child.killed) {
            child.stderr.write('frame=240\nfps=31.0\nout_time_us=10000000\nspeed=1.30x\nprogress=end\n')
            child.close(0)
          }
        }
      })().catch((error) => { child.emit('error', error); child.close(1) })
    })
    return child
  })
  return {
    ready, processes,
    finish: () => {
      if (!held || held.killed) return
      held.stderr.write('frame=121\nfps=29.0\nout_time_us=5100000\nspeed=1.20x\nprogress=continue\n')
      held.stderr.write('[mp4 @ 0] Starting second pass: moving the moov atom to the beginning of the file\n')
      held.stderr.write('frame=240\nfps=31.0\nout_time_us=10000000\nspeed=1.30x\nprogress=end\n')
      held.close(0)
    }
  }
}

const roots: string[] = []
const services: SubtitleService[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(services.splice(0).map((service) => service.stopAll()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  mocked.spawn.mockReset()
})

async function fixture(count = 1): Promise<{ directory: string; fake: TestOwner; service: SubtitleService; request: SubtitleBatchRequest; outputDirectory: string; paths: string[] }> {
  const directory = await mkdtemp(join(tmpdir(), 'subtitle-runtime-mock-'))
  roots.push(directory)
  const fonts = join(directory, 'bundled-fonts')
  await mkdir(fonts)
  const font = Buffer.alloc(1024)
  font.writeUInt32BE(0x00010000)
  await writeFile(join(fonts, 'NotoSansSC.ttf'), font)
  const paths: string[] = []
  for (let index = 1; index <= count; index++) {
    const video = join(directory, `Movie.E0${index}.mkv`)
    const subtitle = join(directory, `Movie.E0${index}.srt`)
    await writeFile(video, `source video ${index} stays untouched`)
    await writeFile(subtitle, caption)
    paths.push(video, subtitle)
  }
  const service = new SubtitleService({ status: async () => ({ available: true, path: 'mock-ffmpeg.exe', message: 'mock FFmpeg' }) }, fonts, new SubtitleEncodingService({ platform: 'win32' }))
  services.push(service)
  const fake = new TestOwner()
  const scan = await service.scanPath(directory, owner(fake))
  return { directory, fake, service, paths, outputDirectory: scan.outputDirectory, request: { scanId: scan.scanId, items: scan.rows.map((row) => ({ rowId: row.id, subtitlePath: row.subtitlePath! })), mode: 'burn', acceleration: 'auto', resolution: 'source', format: 'mp4', encoding: 'auto', offsetSeconds: 0 } }
}

function waitDone(service: SubtitleService, fake: TestOwner, batchId: string): Promise<SubtitleBatchSnapshot> {
  const snapshot = service.snapshot(owner(fake))
  if (snapshot?.batchId === batchId && snapshot.status !== 'running') return Promise.resolve(snapshot)
  return new Promise((resolveResult, reject) => {
    const timeout = setTimeout(() => reject(new Error('Mock batch timed out')), 10_000)
    const listener = (value: SubtitleBatchSnapshot): void => {
      if (value.batchId !== batchId || value.status === 'running') return
      clearTimeout(timeout)
      fake.removeListener('subtitle:event', listener)
      resolveResult(value)
    }
    fake.on('subtitle:event', listener)
  })
}

describe('字幕服务控制流（所有编码和硬件子进程均模拟）', () => {
  it('4K QSV 预检失败后不启动 CPU 编码，失败结果缓存且源文件保持完整', async () => {
    simulateProcesses({ failedProbe: true })
    const test = await fixture()
    const hashes = await Promise.all(test.paths.map(async (path) => hash(await readFile(path))))
    for (let index = 0; index < 2; index++) {
      const start = await test.service.start(test.request, owner(test.fake))
      const end = await waitDone(test.service, test.fake, start.batchId)
      expect(end.items[0].status).toBe('failed')
      expect(end.items[0].error).toContain('未自动回退')
      expect(end.items[0].sourceWidth).toBe(3840)
    }
    const args = mocked.spawn.mock.calls.map((call) => call[1] as string[])
    expect(args.filter((value) => value.includes('-frames:v'))).toHaveLength(1)
    expect(args.some((value) => value.includes('libx264'))).toBe(false)
    expect(await Promise.all(test.paths.map(async (path) => hash(await readFile(path))))).toEqual(hashes)
    expect(await readdir(test.outputDirectory)).toEqual([])
  })

  it('保源 4K，显示真实编码器和 progress 数据，并在 moov 搬移时进入整理阶段', async () => {
    let copiedFonts: string[] = []
    simulateProcesses({ onFonts: (fonts) => { copiedFonts = fonts } })
    const test = await fixture()
    const font = Buffer.alloc(1024)
    font.writeUInt32BE(0x00010000)
    await writeFile(join(test.directory, "字体'[用户].ttf"), font)
    await mkdir(join(test.directory, 'fonts'))
    await writeFile(join(test.directory, 'fonts', 'author.otf'), font)
    await mkdir(join(test.directory, '字体'))
    await writeFile(join(test.directory, '字体', 'author.ttc'), font)
    const start = await test.service.start(test.request, owner(test.fake))
    const end = await waitDone(test.service, test.fake, start.batchId)
    expect(end.items[0].status).toBe('succeeded')
    expect(end.items[0]).toMatchObject({ actualEncoder: 'h264_qsv', actualDecoder: 'hevc_qsv', sourceWidth: 3840, sourceHeight: 2160, outputWidth: 3840, outputHeight: 2160, fps: 31, speed: 1.30 })
    expect(test.fake.history.some((value) => value.items[0].progress === .5 && value.items[0].fps === 30.82 && value.items[0].speed === 1.28)).toBe(true)
    expect(test.fake.history.some((value) => value.items[0].phase === 'finalizing' && value.items[0].message.includes('快启索引') && value.items[0].estimatedRemainingSeconds === undefined)).toBe(true)
    expect(copiedFonts.sort()).toEqual(['NotoSansSC.ttf', 'local-font-0.ttf', 'local-font-1.otf', 'local-font-2.ttc'])
  })

  it('整理阶段取消也等待子进程关闭，再删除半成品', async () => {
    const simulated = simulateProcesses()
    const test = await fixture()
    test.fake.on('subtitle:event', (value: SubtitleBatchSnapshot) => {
      if (value.items[0].phase === 'finalizing' && value.items[0].message.includes('快启索引')) test.service.cancel(value.batchId, owner(test.fake))
    })
    const start = await test.service.start(test.request, owner(test.fake))
    const end = await waitDone(test.service, test.fake, start.batchId)
    expect(end.status).toBe('cancelled')
    expect(end.items[0].status).toBe('cancelled')
    expect(simulated.processes.some((child) => child.killed && child.closed)).toBe(true)
    expect(await readdir(test.outputDirectory)).toEqual([])
  })

  it('GPU 在任务中失效后清除成功缓存，下一项重新预检并且仍只使用 QSV', async () => {
    simulateProcesses({ firstEncodingFails: true })
    const test = await fixture(2)
    const start = await test.service.start(test.request, owner(test.fake))
    const end = await waitDone(test.service, test.fake, start.batchId)
    expect(end.items.map((item) => item.status)).toEqual(['failed', 'succeeded'])
    expect(end.items[0].error).toContain('未自动回退 CPU')
    const args = mocked.spawn.mock.calls.map((call) => call[1] as string[])
    expect(args.filter((value) => value.includes('-frames:v'))).toHaveLength(2)
    expect(args.filter((value) => value.includes('-vf') && !value.includes('-frames:v')).every((value) => value.includes('h264_qsv') && !value.includes('libx264'))).toBe(true)
    expect((await readdir(test.outputDirectory)).some((name) => name.includes('.partial.'))).toBe(false)
  })

  it('长时间没有新 progress 时不沿用旧速度或 ETA；收到新采样才恢复', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    const simulated = simulateProcesses({ holdEncoding: true })
    const test = await fixture()
    const start = await test.service.start(test.request, owner(test.fake))
    await simulated.ready
    expect(test.service.snapshot(owner(test.fake))?.items[0].fps).toBe(30.82)
    vi.advanceTimersByTime(6000)
    expect(test.service.snapshot(owner(test.fake))?.items[0]).toMatchObject({ fps: undefined, speed: undefined, estimatedRemainingSeconds: undefined })
    expect(test.service.snapshot(owner(test.fake))?.items[0].message).toContain('暂未收到')
    vi.advanceTimersByTime(3000)
    simulated.finish()
    const end = await waitDone(test.service, test.fake, start.batchId)
    expect(end.items[0].status).toBe('succeeded')
    expect(test.fake.history.some((value) => value.items[0].fps === 29 && value.items[0].speed === 1.2 && value.items[0].estimatedRemainingSeconds !== undefined)).toBe(true)
  })
})
