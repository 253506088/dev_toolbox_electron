import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { copyFile, link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, parse, resolve } from 'node:path'
import { TextDecoder } from 'node:util'
import { pipeline } from 'node:stream/promises'
import type { WebContents } from 'electron'
import iconv from 'iconv-lite'
import type { FfmpegStatus } from '../../shared/media-api'
import {
  SUBTITLE_EXTENSIONS, SUBTITLE_VIDEO_EXTENSIONS,
  type SubtitleBatchItem, type SubtitleBatchRequest, type SubtitleBatchSnapshot,
  type SubtitleCandidate, type SubtitleEncoding, type SubtitleHardwareStatus, type SubtitleInputSource, type SubtitleMatchRow, type SubtitleScanResult
} from '../../shared/subtitle-api'
import { matchSubtitles } from '../../shared/subtitle-matching'
import { shiftSubtitleTimestamps } from '../../shared/subtitle-timing'
import { estimateSubtitleRemaining, SubtitleProgressReader } from '../../shared/subtitle-progress'
import { buildSubtitleEncodingArgs, parseSubtitleSourceInfo, SubtitleEncodingService, type SubtitleEncodingPlan } from './subtitle-encoding-service'
import { buildEmbeddedExtractionArgs, chooseEmbeddedSubtitle, embeddedTrackCandidates, embeddedTrackLabel, isChineseEmbeddedSubtitle, parseEmbeddedVideoInfo, type EmbeddedVideoInfo } from './embedded-subtitle-service'

const VIDEO_TYPES = new Set<string>(SUBTITLE_VIDEO_EXTENSIONS)
const SUBTITLE_TYPES = new Set<string>(SUBTITLE_EXTENSIONS)
const MAX_SUBTITLE_BYTES = 64 * 1024 * 1024

interface ScanContext {
  result: SubtitleScanResult
  owner: WebContents
  subtitles: Set<string>
  embedded: Map<string, { fingerprint: string; info: EmbeddedVideoInfo }>
}

interface BatchContext {
  snapshot: SubtitleBatchSnapshot
  owner: WebContents
  request: SubtitleBatchRequest
  executable: string
  cancelled: boolean
  done: Promise<void>
  videoFingerprints: Map<string, string>
  child?: ChildProcessWithoutNullStreams
  copyAbort?: AbortController
}

/** 外挂字幕的扫描、画面烧录/字幕轨封装与不覆盖源文件的输出管理。 */
export class SubtitleService {
  private readonly scans = new Map<string, ScanContext>()
  private readonly batches = new Map<string, BatchContext>()
  private readonly lockedOwners = new Set<number>()
  private readonly watchedOwners = new Set<number>()
  private readonly metadataCache = new Map<string, { fingerprint: string; info: EmbeddedVideoInfo }>()
  private readonly scanChildren = new Map<ChildProcessWithoutNullStreams, WebContents>()
  private readonly pendingScans = new Set<Promise<unknown>>()
  private scanGeneration = 0

  constructor(private readonly ffmpeg: { status(): Promise<FfmpegStatus> }, private readonly fontDirectory?: string, private readonly encoders = new SubtitleEncodingService()) {}

  async hardwareStatus(force = false): Promise<SubtitleHardwareStatus> {
    if (typeof force !== 'boolean') throw new Error('硬件检测参数无效')
    const status = await this.ffmpeg.status()
    if (!status.available || !status.path) throw new Error(status.message)
    return this.encoders.hardwareStatus(status.path, force)
  }

  /** 只扫描选中目录的一层；选中单个视频时仍从其同目录匹配字幕。 */
  async scanPath(inputPath: string, owner: WebContents): Promise<SubtitleScanResult> {
    this.assertOwner(owner)
    this.watchOwner(owner)
    const generation = this.scanGeneration
    const operation = this.performScan(inputPath, owner, generation)
    this.pendingScans.add(operation)
    try { return await operation }
    finally { this.pendingScans.delete(operation) }
  }

  private async performScan(inputPath: string, owner: WebContents, generation: number): Promise<SubtitleScanResult> {
    if (typeof inputPath !== 'string' || !isAbsolute(inputPath)) throw new Error('请选择有效的绝对文件路径')
    const canonical = await realpath(inputPath)
    const info = await stat(canonical)
    this.assertScanActive(owner, generation)
    const mode = info.isDirectory() ? 'folder' : 'video'
    if (!info.isDirectory()) await assertFile(canonical, VIDEO_TYPES, '视频')
    const directory = info.isDirectory() ? canonical : dirname(canonical)
    const entries = await readdir(directory, { withFileTypes: true })
    const files = entries.filter((entry) => entry.isFile()).map((entry) => join(directory, entry.name))
    const videos = mode === 'video' ? [canonical] : files.filter((file) => VIDEO_TYPES.has(extension(file)))
    const subtitles = files.filter((file) => SUBTITLE_TYPES.has(extension(file)))
    const rows = matchSubtitles(videos, subtitles)
    const embedded = new Map<string, { fingerprint: string; info: EmbeddedVideoInfo }>()
    let ffmpegPath: string | undefined
    if (rows.length > 0) {
      const status = await this.ffmpeg.status()
      this.assertScanActive(owner, generation)
      if (status.available && status.path) ffmpegPath = status.path
    }
    let next = 0
    let completed = 0
    const worker = async (): Promise<void> => {
      while (next < rows.length) {
        this.assertScanActive(owner, generation)
        const row = rows[next++]
        for (const candidate of row.candidates) candidate.source = { kind: 'external', path: candidate.path }
        if (row.subtitlePath) row.subtitleSource = { kind: 'external', path: row.subtitlePath }
        try {
          if (!ffmpegPath) throw new Error('FFmpeg 尚不可用，无法读取视频内置字幕')
          const fingerprint = await fileFingerprint(row.videoPath)
          this.assertScanActive(owner, generation)
          const cacheKey = pathKey(row.videoPath)
          let record = this.metadataCache.get(cacheKey)
          if (!record || record.fingerprint !== fingerprint) {
            const text = await this.probeEmbeddedMetadata(ffmpegPath, row.videoPath, owner, generation)
            this.assertScanActive(owner, generation)
            const currentFingerprint = await fileFingerprint(row.videoPath)
            if (currentFingerprint !== fingerprint) throw new Error('视频在扫描过程中已改变，请重新扫描')
            record = { fingerprint, info: parseEmbeddedVideoInfo(text) }
            if (this.metadataCache.size >= 128) this.metadataCache.delete(this.metadataCache.keys().next().value!)
            this.metadataCache.set(cacheKey, record)
          }
          embedded.set(row.id, record)
          this.applyEmbeddedCandidates(row, record.info)
        } catch (error) {
          this.assertScanActive(owner, generation)
          row.scanError = errorMessage(error)
          row.embeddedTracks = []
          row.embeddedFontCount = 0
          if (!row.subtitlePath) row.reason = `未能读取内置字幕：${row.scanError}`
        }
        completed++
        this.sendScanProgress(owner, completed, rows.length, row.videoName)
      }
    }
    this.sendScanProgress(owner, 0, rows.length, '')
    const workers = await Promise.allSettled(Array.from({ length: Math.min(2, rows.length) }, () => worker()))
    const failure = workers.find((entry): entry is PromiseRejectedResult => entry.status === 'rejected')
    if (failure) throw failure.reason
    const result: SubtitleScanResult = {
      scanId: randomUUID(), directory,
      outputDirectory: join(directory, `内嵌字幕处理+${basename(directory) || '根目录'}`),
      mode, subtitleCount: subtitles.length,
      embeddedSubtitleCount: rows.reduce((sum, row) => sum + (row.embeddedTracks?.length ?? 0), 0), rows
    }
    this.assertScanActive(owner, generation)
    const existing = [...this.scans.entries()].filter(([, scan]) => scan.owner.id === owner.id)
    for (const [id] of existing.slice(0, Math.max(0, existing.length - 3))) this.scans.delete(id)
    this.scans.set(result.scanId, { result, owner, subtitles: new Set(subtitles.map(pathKey)), embedded })
    return structuredClone(result)
  }

  private applyEmbeddedCandidates(row: SubtitleMatchRow, info: EmbeddedVideoInfo): void {
    row.embeddedTracks = structuredClone(info.tracks)
    row.embeddedFontCount = info.fonts.length
    row.candidates = [...embeddedTrackCandidates(info.tracks), ...row.candidates]
    const preferred = chooseEmbeddedSubtitle(info.tracks)
    if (!preferred) {
      if (!row.subtitlePath && info.tracks.length) row.reason = info.tracks.some((track) => track.supported)
        ? '内置候选仅含强制或招牌字幕，请手动确认完整对白轨'
        : '内置字幕为图片或暂不支持的格式，请选择外挂 ASS / SRT 文本字幕'
      return
    }
    if (!isChineseEmbeddedSubtitle(preferred) && row.subtitlePath) return
    row.subtitlePath = null
    row.subtitleSource = { kind: 'embedded', streamIndex: preferred.streamIndex }
    row.confidence = isChineseEmbeddedSubtitle(preferred) ? 'high' : 'medium'
    row.reason = isChineseEmbeddedSubtitle(preferred) ? '自动选择视频内的中文字幕，烧录时提取字幕和字体' : '视频没有标注中文轨，选择了内置默认候选，请确认语言'
  }

  private assertScanActive(owner: WebContents, generation: number): void {
    this.assertOwner(owner)
    if (generation !== this.scanGeneration) throw new Error('字幕扫描已取消')
  }

  private sendScanProgress(owner: WebContents, completed: number, total: number, videoName: string): void {
    if (owner.isDestroyed()) return
    try { owner.send('subtitle:scan-progress', { completed, total, videoName }) }
    catch { /* 页面关闭后不再发送扫描进度。 */ }
  }

  private probeEmbeddedMetadata(executable: string, video: string, owner: WebContents, generation: number): Promise<string> {
    this.assertScanActive(owner, generation)
    return new Promise((resolveProbe, reject) => {
      // 只需容器头中的轨道/字体信息；真正编码前另有完整的视频探测。
      const child = spawn(executable, ['-hide_banner', '-nostdin', '-analyzeduration', '1', '-probesize', '32768', '-i', video], { windowsHide: true })
      this.scanChildren.set(child, owner)
      let stderr = ''
      let startupError: Error | undefined
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; child.kill() }, 12_000)
      child.stdout.resume()
      child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-1024 * 1024) })
      child.once('error', (error) => { startupError = error })
      child.once('close', () => {
        clearTimeout(timer)
        this.scanChildren.delete(child)
        try { this.assertScanActive(owner, generation) }
        catch (error) { reject(error); return }
        if (startupError) reject(new Error(`无法读取内置字幕：${startupError.message}`))
        else if (timedOut) reject(new Error('读取内置字幕超时，可重新扫描或手动选择外挂字幕'))
        else if (!/^\s{2}Stream #0:\d+.*:\s*(?:Video|Audio|Subtitle):/m.test(stderr)) reject(new Error(`无法读取视频内的媒体轨\n${stderr.slice(-1000)}`))
        else resolveProbe(stderr)
      })
    })
  }

  /** 登记用户手动选择的字幕，只授予当前扫描会话使用权限。 */
  async registerSubtitle(scanId: string, rowId: string, inputPath: string, owner: WebContents): Promise<SubtitleCandidate> {
    const scan = this.getScan(scanId, owner)
    if (!scan.result.rows.some((row) => row.id === rowId)) throw new Error('视频记录已失效，请重新扫描')
    if (typeof inputPath !== 'string' || !isAbsolute(inputPath)) throw new Error('字幕路径无效')
    const path = await realpath(inputPath)
    await assertFile(path, SUBTITLE_TYPES, '字幕')
    this.assertOwner(owner)
    scan.subtitles.add(pathKey(path))
    return { path, source: { kind: 'external', path }, name: basename(path), score: 100, confidence: 'high', reason: '手动选择' }
  }

  /** 校验会话内选择，创建批次并在 IPC 返回后开始处理。 */
  async start(request: SubtitleBatchRequest, owner: WebContents): Promise<SubtitleBatchSnapshot> {
    this.assertOwner(owner)
    if (this.lockedOwners.has(owner.id) || this.snapshot(owner)?.status === 'running') throw new Error('字幕批次正在处理，请先等待完成或取消')
    this.lockedOwners.add(owner.id)
    try {
      validateRequest(request)
      const scan = this.getScan(request.scanId, owner)
      const rows = new Map(scan.result.rows.map((row) => [row.id, row]))
      const seen = new Set<string>()
      const items: SubtitleBatchItem[] = []
      const videoFingerprints = new Map<string, string>()
      for (const selection of request.items) {
        const row = rows.get(selection.rowId)
        if (!row || seen.has(selection.rowId)) throw new Error('视频选择无效或重复，请重新扫描')
        seen.add(selection.rowId)
        await assertFile(row.videoPath, VIDEO_TYPES, '视频')
        const record = scan.embedded.get(row.id)
        const fingerprint = await fileFingerprint(row.videoPath)
        if (record && fingerprint !== record.fingerprint) throw new Error('视频在扫描后已改变，请重新扫描并选择字幕')
        videoFingerprints.set(row.id, fingerprint)
        const source: SubtitleInputSource = selection.source ?? { kind: 'external', path: selection.subtitlePath! }
        let subtitlePath = ''
        let subtitleName: string
        if (source.kind === 'embedded') {
          if (request.mode === 'soft') throw new Error('视频内置字幕请使用“烧录到画面”，不能重复内封已有字幕轨')
          const track = record?.info.tracks.find((candidate) => candidate.streamIndex === source.streamIndex)
          if (!track || !track.supported) throw new Error('内置字幕索引不属于当前视频或格式不支持，请重新扫描并选择文本字幕轨')
          subtitleName = embeddedTrackLabel(track)
        } else {
          if (!scan.subtitles.has(pathKey(source.path))) throw new Error('请从匹配候选或文件选择框中选择字幕')
          subtitlePath = await realpath(source.path)
          if (!scan.subtitles.has(pathKey(subtitlePath))) throw new Error('字幕路径已改变，请重新选择')
          await assertFile(subtitlePath, SUBTITLE_TYPES, '字幕')
          source.path = subtitlePath
          subtitleName = basename(subtitlePath)
        }
        items.push({
          id: row.id, videoPath: row.videoPath, videoName: row.videoName,
          source: structuredClone(source), subtitlePath, subtitleName, outputPath: '',
          status: 'queued', progress: 0, message: '等待处理'
        })
      }
      const ffmpeg = await this.ffmpeg.status()
      if (!ffmpeg.available || !ffmpeg.path) throw new Error(ffmpeg.message)
      await ensureOutputDirectory(scan.result.outputDirectory)
      this.assertOwner(owner)
      for (const [id, batch] of this.batches) {
        if (batch.owner.id === owner.id && batch.snapshot.status !== 'running') this.batches.delete(id)
      }
      const snapshot: SubtitleBatchSnapshot = {
        batchId: randomUUID(), outputDirectory: scan.result.outputDirectory,
        mode: request.mode ?? 'burn', acceleration: request.acceleration ?? 'auto',
        resolution: request.mode === 'soft' ? 'source' : request.resolution ?? 'source',
        status: 'running', items, startedAt: new Date().toISOString()
      }
      let resolveDone!: () => void
      const done = new Promise<void>((resolveResult) => { resolveDone = resolveResult })
      const batch: BatchContext = { snapshot, owner, request: { ...structuredClone(request), mode: snapshot.mode, acceleration: snapshot.acceleration, resolution: snapshot.resolution }, executable: ffmpeg.path, cancelled: false, done, videoFingerprints }
      this.batches.set(snapshot.batchId, batch)
      this.watchOwner(owner)
      setImmediate(() => {
        void this.runBatch(batch).catch((error: unknown) => {
          for (const item of snapshot.items) {
            if (item.status === 'running' || item.status === 'queued') {
              item.status = batch.cancelled ? 'cancelled' : 'failed'
              item.error = batch.cancelled ? undefined : errorMessage(error)
              item.message = batch.cancelled ? '已取消' : '字幕任务异常结束'
            }
          }
          snapshot.status = batch.cancelled ? 'cancelled' : 'completed'
          snapshot.finishedAt = new Date().toISOString()
          this.emit(batch)
        }).finally(() => {
          resolveDone()
          if (owner.isDestroyed()) this.batches.delete(snapshot.batchId)
        })
      })
      return structuredClone(snapshot)
    } finally {
      this.lockedOwners.delete(owner.id)
    }
  }

  /** 取消当前子进程与未开始的项，已完成的输出继续保留。 */
  cancel(batchId: string, owner: WebContents): void {
    const batch = this.getBatch(batchId, owner)
    if (batch.snapshot.status !== 'running') return
    this.cancelContext(batch)
  }

  /** 返回当前页面最近一个批次，页签切换后仍能恢复进度。 */
  snapshot(owner: WebContents): SubtitleBatchSnapshot | null {
    this.assertOwner(owner)
    const batch = [...this.batches.values()].reverse().find((context) => context.owner.id === owner.id)
    return batch ? structuredClone(batch.snapshot) : null
  }

  /** 仅允许打开当前页面创建的真实输出目录。 */
  outputDirectory(batchId: string, owner: WebContents): string {
    return this.getBatch(batchId, owner).snapshot.outputDirectory
  }

  /** 主进程在退出前等待此 Promise，确保子进程退出与半成品清理完成。 */
  async stopAll(): Promise<void> {
    this.scanGeneration++
    for (const child of this.scanChildren.keys()) child.kill()
    for (const batch of this.batches.values()) this.cancelContext(batch)
    await Promise.allSettled([this.encoders.stopAll(), ...this.pendingScans, ...[...this.batches.values()].map((batch) => batch.done)])
  }

  hasRunning(): boolean { return this.pendingScans.size > 0 || this.scanChildren.size > 0 || this.encoders.hasRunning() || [...this.batches.values()].some((batch) => batch.snapshot.status === 'running') }

  private async runBatch(batch: BatchContext): Promise<void> {
    for (const item of batch.snapshot.items) {
      if (batch.cancelled || batch.owner.isDestroyed()) {
        item.status = 'cancelled'
        item.message = '已取消'
        continue
      }
      item.status = 'running'
      item.message = '读取字幕与视频信息'
      this.emit(batch)
      try {
        await this.processItem(batch, item)
        item.status = 'succeeded'
        item.progress = 1
        item.estimatedRemainingSeconds = 0
        item.message = batch.snapshot.mode === 'burn' ? '字幕已烧录到画面，成品可独立播放' : '字幕轨已嵌入，音视频保持原画质'
      } catch (error) {
        item.status = batch.cancelled ? 'cancelled' : 'failed'
        item.estimatedRemainingSeconds = undefined
        item.error = batch.cancelled ? undefined : errorMessage(error)
        item.message = batch.cancelled ? '已取消，半成品已清理' : '处理失败，继续下一项'
      }
      this.emit(batch)
    }
    batch.snapshot.status = batch.cancelled ? 'cancelled' : 'completed'
    batch.snapshot.finishedAt = new Date().toISOString()
    this.emit(batch)
  }

  private async processItem(batch: BatchContext, item: SubtitleBatchItem): Promise<void> {
    const startedAt = Date.now()
    item.phase = 'preparing'
    item.elapsedSeconds = 0
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'dev-toolbox-subtitle-'))
    let lastProgressAt: number | undefined
    const timer = setInterval(() => {
      item.elapsedSeconds = Math.max(0, (Date.now() - startedAt) / 1000)
      if (!batch.cancelled && item.phase === 'encoding' && lastProgressAt !== undefined && Date.now() - lastProgressAt > 5000) {
        item.fps = undefined
        item.speed = undefined
        item.estimatedRemainingSeconds = undefined
        item.message = '编码处理中，暂未收到新的进度'
      }
      if (item.status === 'running') this.emit(batch)
    }, 1000)
    const partialPath = join(batch.snapshot.outputDirectory, `.subtitle-${randomUUID()}.partial.${batch.request.format}`)
    try {
      this.assertNotCancelled(batch)
      await ensureOutputDirectory(batch.snapshot.outputDirectory)
      await assertFile(item.videoPath, VIDEO_TYPES, '视频')
      if (await fileFingerprint(item.videoPath) !== batch.videoFingerprints.get(item.id)) throw new Error('视频在任务开始后已改变，请重新扫描')
      const probe = await this.execute(batch, ['-hide_banner', '-nostdin', '-i', item.videoPath], 30_000)
      this.assertNotCancelled(batch)
      const metadata = parseSubtitleVideoProbe(probe.stderr)
      const source = parseSubtitleSourceInfo(probe.stderr)
      if (!metadata.hasVideo) throw new Error(`无法读取视频流：${probe.stderr.slice(-1400)}`)
      if (source.width > 0) item.sourceWidth = source.width
      if (source.height > 0) item.sourceHeight = source.height
      const burning = batch.snapshot.mode === 'burn'
      if (burning) await this.prepareBurnFonts(batch, temporaryDirectory, item.videoPath)
      let rawSubtitlePath = item.subtitlePath
      let subtitleExtension = extension(item.subtitlePath)
      let subtitleEncoding = batch.request.encoding
      const embeddedSource = item.source
      if (embeddedSource?.kind === 'embedded') {
        const embedded = parseEmbeddedVideoInfo(probe.stderr)
        const track = embedded.tracks.find((entry) => entry.streamIndex === embeddedSource.streamIndex)
        if (!track?.supported) throw new Error('所选内置字幕轨已改变或不支持，请重新扫描')
        item.message = '正在提取视频内置字幕和字体（原视频只读）'
        this.emit(batch)
        const extraction = buildEmbeddedExtractionArgs(item.videoPath, track, embedded.fonts, temporaryDirectory)
        const result = await this.execute(batch, extraction.args, 0)
        this.assertNotCancelled(batch)
        if (result.code !== 0) throw new Error(`提取内置字幕或字体失败\n${result.stderr.slice(-2400)}`)
        for (const font of extraction.fontTargets) await assertExtractedFont(font.path)
        rawSubtitlePath = extraction.rawSubtitlePath
        subtitleExtension = extraction.subtitleExtension
        subtitleEncoding = 'utf8'
      }
      await assertFile(rawSubtitlePath, SUBTITLE_TYPES, '字幕')
      if (await fileFingerprint(item.videoPath) !== batch.videoFingerprints.get(item.id)) throw new Error('视频在字幕读取过程中已改变，请重新扫描')
      const subtitleBytes = await readFile(rawSubtitlePath)
      if (subtitleBytes.byteLength > MAX_SUBTITLE_BYTES) throw new Error('字幕文件超过 64 MB，请检查文件是否正确')
      const text = shiftSubtitleTimestamps(decodeSubtitle(subtitleBytes, subtitleEncoding), subtitleExtension, batch.request.offsetSeconds)
      const subtitlePath = join(temporaryDirectory, `subtitle.${subtitleExtension}`)
      await writeFile(subtitlePath, text, { encoding: 'utf8', flag: 'wx' })
      this.assertNotCancelled(batch)
      let plan: SubtitleEncodingPlan | undefined
      if (burning) {
        item.phase = batch.snapshot.acceleration === 'auto' ? 'probing' : 'preparing'
        item.message = batch.snapshot.acceleration === 'auto' ? '正在预检 Intel QSV 硬件解码与字幕烧录' : '准备 CPU 快速编码（veryfast，4 个编码线程）'
        this.emit(batch)
        plan = await this.encoders.select(batch.executable, source, batch.snapshot.acceleration, {
          inputPath: item.videoPath, subtitleName: basename(subtitlePath), resolution: batch.snapshot.resolution,
          probe: async (args) => {
            this.assertNotCancelled(batch)
            const result = await this.execute(batch, args, 20_000, undefined, temporaryDirectory)
            this.assertNotCancelled(batch)
            return result
          }
        })
        item.actualEncoder = plan.encoder
        item.actualDecoder = plan.decoder
        item.outputWidth = plan.outputWidth
        item.outputHeight = plan.outputHeight
      } else {
        item.actualEncoder = 'copy'
        item.actualDecoder = 'copy'
        item.outputWidth = item.sourceWidth
        item.outputHeight = item.sourceHeight
      }
      this.assertNotCancelled(batch)
      item.phase = 'encoding'
      item.message = burning ? '正在烧录字幕（重新编码视频）' : '正在封装字幕（复制音视频流）'
      item.progress = 0
      this.emit(batch)
      const args = burning
        ? buildSubtitleEncodingArgs(item.videoPath, basename(subtitlePath), partialPath, batch.request.format, plan!, source)
        : buildSubtitleMuxArgs(item.videoPath, subtitlePath, partialPath, { ...batch.request, offsetSeconds: 0 }, metadata.subtitleCount, item.subtitleName, metadata.subtitleCodecs)
      let missingGlyph = false
      const progress = new SubtitleProgressReader()
      const encodingStartedAt = Date.now()
      let processedSeconds = 0
      const result = await this.execute(batch, args, 0, (line) => {
        if (batch.cancelled) return
        if (burning && /fontselect: failed to find (?:any )?fallback with glyph/i.test(line)) missingGlyph = true
        const sample = progress.push(line)
        if (!sample) return
        lastProgressAt = Date.now()
        if (item.phase === 'encoding') item.message = burning ? '正在烧录字幕（重新编码视频）' : '正在封装字幕（复制音视频流）'
        if (sample.processedSeconds !== undefined) processedSeconds = Math.max(processedSeconds, sample.processedSeconds)
        if (sample.fps !== undefined) item.fps = sample.fps
        if (sample.speed !== undefined) item.speed = sample.speed
        item.elapsedSeconds = Math.max(0, (Date.now() - startedAt) / 1000)
        if (metadata.duration > 0) item.progress = Math.max(item.progress, Math.min(1, processedSeconds / metadata.duration))
        else if (sample.ended) item.progress = 1
        item.estimatedRemainingSeconds = estimateSubtitleRemaining(metadata.duration, processedSeconds, (Date.now() - encodingStartedAt) / 1000, sample.ended || Boolean(sample.finalizing) || item.phase === 'finalizing')
        if (sample.finalizing) {
          item.phase = 'finalizing'
          item.message = '视频编码完成，正在整理 MP4 快启索引'
        } else if (sample.ended) {
          item.phase = 'finalizing'
          item.message = '编码已完成，正在整理文件索引并保存成品'
        }
        this.emit(batch)
      }, burning ? temporaryDirectory : undefined)
      this.assertNotCancelled(batch)
      if (result.code !== 0) {
        if (plan?.kind === 'intel-qsv') {
          this.encoders.invalidate()
          throw new Error(`Intel QSV 烧录过程中失败，已停止并清理半成品；未自动回退 CPU 或降低分辨率\n${result.stderr.slice(-2400)}`)
        }
        const advice = !burning && batch.request.format === 'mp4' ? '；当前音视频编码或附件可能不兼容 MP4，可改用 MKV' : ''
        throw new Error(`FFmpeg ${burning ? '烧录字幕' : '封装'}失败${advice}\n${result.stderr.slice(-2400)}`)
      }
      if (missingGlyph) throw new Error('字幕包含内置字体无法绘制的字符，已停止输出；请检查字幕字符或使用支持该语言的字体')
      const outputInfo = await stat(partialPath)
      if (!outputInfo.isFile() || outputInfo.size === 0) throw new Error('FFmpeg 未生成有效的视频文件')
      item.phase = 'finalizing'
      item.message = '正在独占保存成品，避免覆盖已有文件'
      item.estimatedRemainingSeconds = undefined
      this.emit(batch)
      await ensureOutputDirectory(batch.snapshot.outputDirectory)
      this.assertNotCancelled(batch)
      item.outputPath = await this.publishOutput(batch, partialPath, parse(item.videoName).name)
    } finally {
      await Promise.allSettled([
        rm(partialPath, { force: true }),
        rm(temporaryDirectory, { recursive: true, force: true })
      ])
      clearInterval(timer)
      item.elapsedSeconds = Math.max(0, (Date.now() - startedAt) / 1000)
    }
  }

  /** 字体只在编码时使用，拷贝到固定相对路径；成品播放不再依赖字体或字幕文件。 */
  private async prepareBurnFonts(batch: BatchContext, temporaryDirectory: string, videoPath: string): Promise<void> {
    const candidates = this.fontDirectory ? [this.fontDirectory] : [
      join(dirname(dirname(batch.executable)), 'subtitle-fonts'),
      ...(typeof process.resourcesPath === 'string' ? [join(process.resourcesPath, 'subtitle-fonts')] : []),
      join(process.cwd(), 'resources', 'subtitle-fonts')
    ]
    let source: string | undefined
    for (const candidate of new Set(candidates)) {
      try {
        const path = await realpath(join(candidate, 'NotoSansSC.ttf'))
        const info = await stat(path)
        if (!info.isFile() || info.size < 1024) continue
        const handle = await open(path, 'r')
        try {
          const header = Buffer.alloc(4)
          await handle.read(header, 0, 4, 0)
          if (header.readUInt32BE(0) !== 0x00010000 && header.toString('ascii') !== 'OTTO') continue
        } finally { await handle.close() }
        source = path
        break
      } catch { /* 当前候选字体不可用，继续寻找完整的资源目录。 */ }
    }
    if (!source) throw new Error('烧录中文字幕需要内置 Noto Sans SC 字体，未找到完整字体资源；请重新安装完整版本')
    this.assertNotCancelled(batch)
    const fonts = join(temporaryDirectory, 'fonts')
    await mkdir(fonts)
    const target = join(fonts, 'NotoSansSC.ttf')
    try { await link(source, target) }
    catch { await copyFile(source, target) }
    let fontIndex = 0
    const directory = dirname(videoPath)
    for (const localDirectory of [directory, join(directory, 'fonts'), join(directory, '字体')]) {
      const directoryInfo = await lstat(localDirectory).catch(() => null)
      if (!directoryInfo?.isDirectory() || directoryInfo.isSymbolicLink()) continue
      const entries = await readdir(localDirectory, { withFileTypes: true })
      for (const entry of entries) {
        this.assertNotCancelled(batch)
        const extension = extname(entry.name).toLowerCase()
        if (!entry.isFile() || !['.ttf', '.otf', '.ttc'].includes(extension)) continue
        const fontPath = join(localDirectory, entry.name)
        const info = await lstat(fontPath).catch(() => null)
        if (!info?.isFile() || info.isSymbolicLink() || info.size < 1024) continue
        const fontTarget = join(fonts, `local-font-${fontIndex++}${extension}`)
        try { await link(fontPath, fontTarget) }
        catch { await copyFile(fontPath, fontTarget) }
      }
    }
    this.assertNotCancelled(batch)
  }

  /** 发布到新路径时使用独占创建，其他批次/应用产生的同名文件也不会被覆盖。 */
  private async publishOutput(batch: BatchContext, partialPath: string, stem: string): Promise<string> {
    for (let suffix = 1; suffix < 100_000; suffix++) {
      this.assertNotCancelled(batch)
      const target = join(batch.snapshot.outputDirectory, `${stem}${suffix === 1 ? '' : ` (${suffix})`}.${batch.request.format}`)
      try {
        await link(partialPath, target)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EEXIST') continue
        if (!['EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM'].includes(code ?? '')) throw error
        try { await this.copyOutput(batch, partialPath, target) }
        catch (copyError) {
          if ((copyError as NodeJS.ErrnoException).code === 'EEXIST') continue
          throw copyError
        }
      }
      if (batch.cancelled) {
        await rm(target, { force: true })
        this.assertNotCancelled(batch)
      }
      return target
    }
    throw new Error('输出目录内同名视频过多，请先整理输出目录')
  }

  /** 不支持硬链接的文件系统使用独占文件句柄复制，取消时移除本次创建的目标。 */
  private async copyOutput(batch: BatchContext, source: string, target: string): Promise<void> {
    const handle = await open(target, 'wx')
    const identity = await handle.stat()
    const abort = new AbortController()
    batch.copyAbort = abort
    try {
      this.assertNotCancelled(batch)
      await pipeline(createReadStream(source), handle.createWriteStream(), { signal: abort.signal })
      this.assertNotCancelled(batch)
    } catch (error) {
      await handle.close().catch(() => {})
      const current = await lstat(target).catch(() => null)
      if (current?.ino === identity.ino && current?.dev === identity.dev) await rm(target, { force: true }).catch(() => {})
      throw error
    } finally {
      await handle.close().catch(() => {})
      if (batch.copyAbort === abort) batch.copyAbort = undefined
    }
  }

  /** 启动无 shell 的进程；探测超时与取消都等待 close，避免 Windows 文件仍被占用。 */
  private execute(batch: BatchContext, args: string[], timeoutMs: number, onLine?: (line: string) => void, cwd?: string): Promise<{ code: number | null; stderr: string }> {
    this.assertNotCancelled(batch)
    return new Promise((resolveResult, reject) => {
      const child = spawn(batch.executable, args, { windowsHide: true, cwd })
      batch.child = child
      let stderr = ''
      let lines = ''
      let startError: Error | undefined
      let timedOut = false
      const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; child.kill() }, timeoutMs) : undefined
      child.stdout.resume()
      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        stderr = (stderr + text).slice(-1024 * 1024)
        if (onLine) {
          lines += text
          const parts = lines.split(/\r?\n/)
          lines = (parts.pop() ?? '').slice(-4096)
          for (const line of parts) onLine(line)
        }
      })
      child.once('error', (error) => { startError = error })
      child.once('close', (code) => {
        if (timer) clearTimeout(timer)
        if (batch.child === child) batch.child = undefined
        if (onLine && lines) onLine(lines)
        if (startError) reject(new Error(`FFmpeg 启动失败：${startError.message}`))
        else if (timedOut) reject(new Error(args.includes('-init_hw_device') ? 'Intel QSV 硬件解码与字幕烧录预检超时；未自动回退 CPU，请检查驱动或明确选择 CPU 快速编码' : '读取视频信息超时，请确认视频文件可正常访问'))
        else resolveResult({ code, stderr })
      })
    })
  }

  private getScan(id: string, owner: WebContents): ScanContext {
    this.assertOwner(owner)
    const scan = this.scans.get(id)
    if (!scan || scan.owner.id !== owner.id) throw new Error('扫描会话已失效，请重新选择视频或文件夹')
    return scan
  }

  private getBatch(id: string, owner: WebContents): BatchContext {
    this.assertOwner(owner)
    const batch = this.batches.get(id)
    if (!batch || batch.owner.id !== owner.id) throw new Error('字幕批次不存在或不属于当前页面')
    return batch
  }

  private assertOwner(owner: WebContents): void {
    if (owner.isDestroyed()) throw new Error('页面已经关闭')
  }

  private assertNotCancelled(batch: BatchContext): void {
    if (batch.owner.isDestroyed()) this.cancelContext(batch)
    if (batch.cancelled) throw new Error('字幕任务已取消')
  }

  private watchOwner(owner: WebContents): void {
    if (this.watchedOwners.has(owner.id)) return
    this.watchedOwners.add(owner.id)
    owner.once('destroyed', () => {
      for (const [child, scanOwner] of this.scanChildren) if (scanOwner.id === owner.id) child.kill()
      for (const [id, scan] of this.scans) if (scan.owner.id === owner.id) this.scans.delete(id)
      for (const [id, batch] of this.batches) {
        if (batch.owner.id !== owner.id) continue
        if (batch.snapshot.status === 'running') this.cancelContext(batch)
        else this.batches.delete(id)
      }
      this.watchedOwners.delete(owner.id)
    })
  }

  private cancelContext(batch: BatchContext): void {
    if (batch.snapshot.status !== 'running' || batch.cancelled) return
    batch.cancelled = true
    batch.child?.kill()
    batch.copyAbort?.abort()
    for (const item of batch.snapshot.items) {
      if (item.status === 'queued') { item.status = 'cancelled'; item.message = '已取消' }
      else if (item.status === 'running') item.message = '正在取消并清理半成品…'
    }
    this.emit(batch)
  }

  private emit(batch: BatchContext): void {
    if (batch.owner.isDestroyed()) return
    try { batch.owner.send('subtitle:event', structuredClone(batch.snapshot)) }
    catch { if (batch.owner.isDestroyed()) this.cancelContext(batch) }
  }
}

/** 按显式选择或 BOM/有效 UTF-8 检测解码，兼容常见中文旧编码。 */
export function decodeSubtitle(bytes: Uint8Array, encoding: SubtitleEncoding): string {
  const buffer = Buffer.from(bytes)
  let text: string
  if (encoding !== 'auto') {
    if (encoding === 'utf8') {
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer) }
      catch { throw new Error('字幕不是有效的 UTF-8，请选择正确的字幕编码') }
    } else text = iconv.decode(buffer, encoding)
  } else if (buffer[0] === 0xff && buffer[1] === 0xfe) text = iconv.decode(buffer.subarray(2), 'utf16le')
  else if (buffer[0] === 0xfe && buffer[1] === 0xff) text = iconv.decode(buffer.subarray(2), 'utf16be')
  else {
    const sample = buffer.subarray(0, Math.min(buffer.length, 2048))
    let evenZeros = 0
    let oddZeros = 0
    for (let index = 0; index < sample.length; index++) if (sample[index] === 0) { if (index % 2) oddZeros++; else evenZeros++ }
    if (oddZeros > sample.length / 8 && evenZeros < sample.length / 32) text = iconv.decode(buffer, 'utf16le')
    else if (evenZeros > sample.length / 8 && oddZeros < sample.length / 32) text = iconv.decode(buffer, 'utf16be')
    else {
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer) }
      catch { text = iconv.decode(buffer, 'gb18030') }
    }
  }
  text = text.replace(/^\uFEFF/, '')
  if (!text.trim()) throw new Error('字幕文件为空')
  if (text.includes('\u0000')) throw new Error('字幕包含无效字符，请选择正确的字幕编码')
  return text
}

export function parseSubtitleVideoProbe(stderr: string): { duration: number; subtitleCount: number; subtitleCodecs: string[]; hasVideo: boolean } {
  const duration = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
  const subtitleCodecs = [...stderr.matchAll(/Stream #\d+:\d+[^\n]*:\s*Subtitle:\s*([^,\s(]+)/g)].map((match) => match[1])
  return {
    duration: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : 0,
    subtitleCount: subtitleCodecs.length,
    subtitleCodecs,
    hasVideo: /Stream #\d+:\d+[^\n]*:\s*Video:/.test(stderr)
  }
}

/** MKV 复制字幕格式与 ASS 样式；MP4 将字幕转为兼容的 mov_text。 */
export function buildSubtitleMuxArgs(video: string, subtitle: string, output: string, request: Pick<SubtitleBatchRequest, 'format' | 'offsetSeconds'>, existingSubtitleCount: number, subtitleName: string, existingSubtitleCodecs: string[] = []): string[] {
  const args = ['-hide_banner', '-nostdin', '-progress', 'pipe:2', '-nostats', '-i', video]
  if (request.offsetSeconds !== 0) args.push('-itsoffset', String(request.offsetSeconds))
  args.push('-i', subtitle, '-map', '0')
  if (request.format === 'mkv') args.push('-map', '-0:d?')
  args.push('-map', '1:s:0', '-map_metadata', '0', '-map_chapters', '0', '-c', 'copy')
  if (request.format === 'mp4') args.push('-c:s', 'mov_text', '-movflags', '+faststart')
  else existingSubtitleCodecs.forEach((codec, index) => {
    if (['mov_text', 'text', 'ttml'].includes(codec)) args.push(`-c:s:${index}`, 'srt')
  })
  args.push(`-metadata:s:s:${existingSubtitleCount}`, `title=${subtitleName}`, `-metadata:s:s:${existingSubtitleCount}`, `language=${subtitleLanguage(subtitleName)}`)
  for (let index = 0; index < existingSubtitleCount; index++) args.push(`-disposition:s:${index}`, '-default')
  args.push(`-disposition:s:${existingSubtitleCount}`, 'default', '-max_muxing_queue_size', '4096', '-n', output)
  return args
}

/** 滤镜仅使用受控的 ASCII 相对文件名；输入/输出路径独立传递，不进入滤镜语法。 */
export function buildSubtitleBurnArgs(video: string, subtitleName: string, output: string, format: 'mp4' | 'mkv'): string[] {
  if (!/^subtitle\.(?:srt|ass|ssa|vtt)$/.test(subtitleName)) throw new Error('临时字幕文件名无效')
  const styled = /\.(?:ass|ssa)$/.test(subtitleName)
  const filter = `subtitles=filename=${subtitleName}:fontsdir=fonts:charenc=UTF-8${styled ? '' : ":force_style='FontName=Noto Sans SC'"},pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p`
  const args = [
    '-hide_banner', '-nostdin', '-progress', 'pipe:2', '-nostats', '-i', video,
    '-map', '0:V:0', '-map', '0:a?', '-map_metadata', '0', '-map_chapters', '0',
    '-vf', filter, '-sn', '-dn', '-c:v', 'libx264', '-preset', 'veryfast', '-threads', '4', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ac', '2'
  ]
  if (format === 'mp4') args.push('-movflags', '+faststart')
  args.push('-n', output)
  return args
}

function subtitleLanguage(name: string): string {
  if (/(?:简体|繁体|中文|双语|chs|cht|sc|tc|zh(?:[-_.](?:cn|tw|hans|hant))?)(?:[\W_]|$)/i.test(name)) return 'chi'
  if (/(?:[._\-\[\s]|^)(?:en|eng|english)(?:[\W_]|$)/i.test(name)) return 'eng'
  if (/(?:[._\-\[\s]|^)(?:ja|jpn|japanese)(?:[\W_]|$)/i.test(name)) return 'jpn'
  return 'und'
}

function validateRequest(request: SubtitleBatchRequest): void {
  if (!request || typeof request.scanId !== 'string') throw new Error('字幕扫描会话无效')
  if (!Array.isArray(request.items) || request.items.length === 0 || request.items.length > 10_000) throw new Error('每批请选择 1 到 10000 个视频')
  if (!['mkv', 'mp4'].includes(request.format)) throw new Error('输出格式无效')
  if (request.mode !== undefined && !['burn', 'soft'].includes(request.mode)) throw new Error('字幕嵌入模式无效')
  if (request.acceleration !== undefined && !['auto', 'cpu-fast'].includes(request.acceleration)) throw new Error('硬件加速模式无效')
  if (request.resolution !== undefined && !['source', '1080p'].includes(request.resolution)) throw new Error('输出分辨率模式无效')
  if (!['auto', 'utf8', 'gb18030', 'big5', 'shift_jis'].includes(request.encoding)) throw new Error('字幕编码无效')
  if (!Number.isFinite(request.offsetSeconds) || Math.abs(request.offsetSeconds) > 3600) throw new Error('字幕时间偏移必须在 -3600 到 3600 秒之间')
  if (request.items.some((item) => !item || typeof item.rowId !== 'string')) throw new Error('字幕任务参数无效')
  for (const item of request.items) {
    if (item.source !== undefined) {
      if (item.subtitlePath !== undefined) throw new Error('请只指定一种字幕来源，不要同时提交外挂路径和内置轨')
      if (!item.source || typeof item.source !== 'object') throw new Error('字幕来源无效')
      if (item.source.kind === 'external') {
        if (typeof item.source.path !== 'string' || !isAbsolute(item.source.path)) throw new Error('外挂字幕路径无效')
      } else if (item.source.kind === 'embedded') {
        if (!Number.isSafeInteger(item.source.streamIndex) || item.source.streamIndex < 0) throw new Error('内置字幕流索引无效')
      } else throw new Error('字幕来源类型无效')
    } else if (typeof item.subtitlePath !== 'string' || !isAbsolute(item.subtitlePath)) throw new Error('字幕任务参数无效')
  }
}

async function fileFingerprint(path: string): Promise<string> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('视频文件不可访问或已被替换为链接')
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`
}

async function assertExtractedFont(path: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size < 4) throw new Error('视频字体附件未能完整导出')
  const file = await open(path, 'r')
  try {
    const header = Buffer.alloc(4)
    await file.read(header, 0, 4, 0)
    if (header.readUInt32BE(0) !== 0x00010000 && !['OTTO', 'ttcf'].includes(header.toString('ascii'))) throw new Error('视频字体附件格式无效，不能保证字幕正确显示')
  } finally { await file.close() }
}

async function assertFile(path: string, types: Set<string>, label: string): Promise<void> {
  if (!types.has(extension(path))) throw new Error(`不支持的${label}格式`)
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label}文件不可访问或已被替换为链接`)
  if (label === '字幕' && info.size > MAX_SUBTITLE_BYTES) throw new Error('字幕文件超过 64 MB，请检查文件是否正确')
}

async function ensureOutputDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || pathKey(await realpath(path)) !== pathKey(resolve(path))) throw new Error('输出目录是链接或路径已改变，请使用真实目录')
}

function extension(path: string): string { return extname(path).slice(1).toLowerCase() }
function pathKey(path: string): string { const value = resolve(path); return process.platform === 'win32' ? value.toLowerCase() : value }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
