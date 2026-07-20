import { randomUUID } from 'node:crypto'
import { access, mkdir, readdir } from 'node:fs/promises'
import { basename, dirname, extname, join, parse } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { WebContents } from 'electron'
import type { MediaJobEvent, FrameExtractOptions, FfmpegStatus, VideoMattingOptions, VideoMetadata } from '../../shared/media-api'
import { VIDEO_EXTENSIONS } from '../../shared/media-api'
import { buildFrameExtractArgs, buildVideoMattingArgs, parseFfmpegProgress, parseVideoMetadata, cropToPixels } from '../../shared/ffmpeg-helpers'
import { MediaSourceService } from './media-source-service'
import { writeLog } from './logger'

const SUPPORTED_VIDEO_EXTENSIONS = new Set(VIDEO_EXTENSIONS.map((extension) => `.${extension}`))

interface RunningJob {
  process: ChildProcessWithoutNullStreams
  owner: WebContents
  totalDuration: number
  outputPath: string
  cancelled: boolean
  startupError?: string
}

/** 统一管理 FFmpeg 探测、视频元数据、导出进度和子进程取消。 */
export class FfmpegService {
  private readonly jobs = new Map<string, RunningJob>()
  private cachedPath: string | null = null

  constructor(private readonly sources: MediaSourceService) {}

  /** 查找内置 FFmpeg 或系统 PATH 中的 FFmpeg。 */
  async status(): Promise<FfmpegStatus> {
    const candidates = this.getCandidates()
    for (const candidate of candidates) {
      try {
        const result = await this.probe(candidate, ['-version'])
        if (result.code === 0) {
          this.cachedPath = candidate
          const version = result.stdout.split(/\r?\n/)[0]?.trim()
          return { available: true, path: candidate, version, message: `FFmpeg 已就绪：${candidate}` }
        }
      } catch {
        // 当前候选路径不可用，继续检查下一项。
      }
    }
    return { available: false, message: `未找到 FFmpeg，已检查：${candidates.join(' | ')}` }
  }

  /** 获取指定视频的元数据和受控预览地址。 */
  async metadata(inputPath: string): Promise<VideoMetadata> {
    await this.assertVideoPath(inputPath)
    const ffmpeg = await this.resolvePath()
    const result = await this.probe(ffmpeg, ['-hide_banner', '-i', inputPath])
    const metadata = parseVideoMetadata(`${result.stdout}\n${result.stderr}`)
    if (!metadata) throw new Error('无法解析视频时长、分辨率或帧率')
    return { path: inputPath, name: basename(inputPath), ...metadata, previewUrl: await this.sources.register(inputPath) }
  }

  /** 启动视频序列帧任务并立即返回任务编号。 */
  async startFrameExtract(options: FrameExtractOptions, owner: WebContents): Promise<{ jobId: string; outputPath: string }> {
    await this.assertVideoPath(options.inputPath)
    const metadata = await this.metadata(options.inputPath)
    validateFrameOptions(options, metadata)
    const outputDirectory = await this.createOutputDirectory(options.outputRoot, '序列帧')
    const args = buildFrameExtractArgs(options, outputDirectory, metadata)
    const duration = options.endSeconds - options.startSeconds
    return this.startProcess(args, owner, duration, outputDirectory, '视频抽帧')
  }

  /** 启动视频抠图任务并立即返回任务编号。 */
  async startVideoMatting(options: VideoMattingOptions, owner: WebContents): Promise<{ jobId: string; outputPath: string }> {
    await this.assertVideoPath(options.inputPath)
    const metadata = await this.metadata(options.inputPath)
    validateVideoMattingOptions(options, metadata)
    const args = buildVideoMattingArgs(options, metadata)
    return this.startProcess(args, owner, metadata.duration, options.outputPath, '视频抠图')
  }

  /** 取消指定 FFmpeg 子进程。 */
  cancel(jobId: string): void {
    const job = this.jobs.get(jobId)
    if (!job) return
    job.cancelled = true
    job.process.kill()
  }

  /** 应用退出时终止所有视频任务。 */
  stopAll(): void {
    for (const jobId of this.jobs.keys()) this.cancel(jobId)
  }

  /** 解析当前 FFmpeg 可执行路径。 */
  private async resolvePath(): Promise<string> {
    if (this.cachedPath) return this.cachedPath
    const result = await this.status()
    if (!result.available || !result.path) throw new Error(result.message)
    return result.path
  }

  /** 返回打包目录、开发目录和 PATH 的候选路径。 */
  private getCandidates(): string[] {
    const resourcePath = process.resourcesPath
    const projectPath = process.cwd()
    return [
      join(resourcePath, 'ffmpeg', 'ffmpeg.exe'),
      join(projectPath, 'resources', 'ffmpeg', 'ffmpeg.exe'),
      'ffmpeg.exe',
      'ffmpeg'
    ]
  }

  /** 运行一次无 shell 的 FFmpeg 探测命令。 */
  private probe(executable: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, { windowsHide: true })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      child.once('error', reject)
      child.once('close', (code) => resolve({ code, stdout, stderr }))
    })
  }

  /** 启动一个 FFmpeg 子进程并绑定事件输出。 */
  private async startProcess(args: string[], owner: WebContents, totalDuration: number, outputPath: string, moduleName: string): Promise<{ jobId: string; outputPath: string }> {
    const executable = await this.resolvePath()
    const jobId = randomUUID()
    const child = spawn(executable, args, { windowsHide: true })
    const job: RunningJob = { process: child, owner, totalDuration, outputPath, cancelled: false }
    this.jobs.set(jobId, job)
    this.send(owner, { jobId, type: 'progress', progress: 0, message: `${moduleName}已启动` })
    void writeLog(moduleName, `启动任务 ${jobId}，输入参数已校验`)

    let buffer = ''
    child.stderr.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line) continue
        const progress = parseFfmpegProgress(line, totalDuration)
        if (progress !== null) this.send(owner, { jobId, type: 'progress', progress, message: `处理进度 ${(progress * 100).toFixed(0)}%` })
        else if (!line.startsWith('frame=') && !line.startsWith('bitrate=')) this.send(owner, { jobId, type: 'log', progress: 0, message: line })
      }
    })
    child.once('error', (error) => {
      job.startupError = error.message
    })
    child.once('close', (code) => {
      void this.finishProcess(jobId, job, code, moduleName)
    })
    return { jobId, outputPath }
  }

  /** 根据退出码统计结果并发送唯一终态。 */
  private async finishProcess(jobId: string, job: RunningJob, code: number | null, moduleName: string): Promise<void> {
      this.jobs.delete(jobId)
      if (job.cancelled) {
        this.send(job.owner, { jobId, type: 'cancelled', progress: 0, message: '任务已取消' })
        return
      }
      if (job.startupError) {
        const message = `FFmpeg 启动失败：${job.startupError}`
        this.send(job.owner, { jobId, type: 'failed', progress: 0, message })
        void writeLog(moduleName, `任务启动失败 ${jobId}：${message}`)
        return
      }
      if (code === 0) {
        const frameCount = moduleName === '视频抽帧' ? await countFrames(job.outputPath) : undefined
        this.send(job.owner, { jobId, type: 'completed', progress: 1, message: frameCount === undefined ? '处理完成' : `处理完成，共 ${frameCount} 帧`, outputPath: job.outputPath, frameCount })
        void writeLog(moduleName, `任务完成 ${jobId}`)
      } else {
        const message = `FFmpeg 退出码：${code ?? '未知'}，请查看日志`
        this.send(job.owner, { jobId, type: 'failed', progress: 0, message })
        void writeLog(moduleName, `任务失败 ${jobId}：${message}`)
      }
  }

  /** 在输出根目录中创建带时间戳且不重名的子目录。 */
  private async createOutputDirectory(root: string, prefix: string): Promise<string> {
    await mkdir(root, { recursive: true })
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
    let suffix = 0
    while (true) {
      const candidate = join(root, `${prefix}-${stamp}${suffix === 0 ? '' : `-${suffix}`}`)
      try {
        await access(candidate)
        suffix += 1
      } catch {
        await mkdir(candidate)
        return candidate
      }
    }
  }

  /** 校验视频路径及扩展名。 */
  private async assertVideoPath(inputPath: string): Promise<void> {
    if (typeof inputPath !== 'string' || !SUPPORTED_VIDEO_EXTENSIONS.has(extname(inputPath).toLowerCase())) throw new Error('不支持的视频格式')
    await access(inputPath)
  }

  /** 向页面发送任务事件，页面关闭后自动忽略。 */
  private send(owner: WebContents, event: MediaJobEvent): void {
    if (!owner.isDestroyed()) owner.send('media:job-event', event)
  }
}

/** 统计输出目录中符合命名规则的 PNG 帧数量。 */
async function countFrames(outputDirectory: string): Promise<number> {
  try {
    return (await readdir(outputDirectory)).filter((name) => /^frame_\d{5}\.png$/i.test(name)).length
  } catch {
    return 0
  }
}

/** 校验视频抽帧参数。 */
function validateFrameOptions(options: FrameExtractOptions, metadata: VideoMetadata): void {
  if (!Number.isFinite(options.fps) || options.fps <= 0 || options.fps > 240) throw new Error('目标 FPS 必须在 0 到 240 之间')
  if (!Number.isFinite(options.startSeconds) || options.startSeconds < 0) throw new Error('开始时间无效')
  if (!Number.isFinite(options.endSeconds) || options.endSeconds <= options.startSeconds) throw new Error('结束时间必须晚于开始时间')
  if (options.startSeconds >= metadata.duration) throw new Error('开始时间超出视频时长')
  if (options.endSeconds > metadata.duration + 0.01) throw new Error('结束时间超出视频时长')
  if (options.maxFrames < 1 || options.maxFrames > 100_000) throw new Error('最大帧数必须在 1 到 100000 之间')
  if (options.crop) cropToPixels(options.crop, metadata.width, metadata.height)
}

/** 校验视频抠图参数和输出格式。 */
function validateVideoMattingOptions(options: VideoMattingOptions, metadata: VideoMetadata): void {
  if (!Number.isFinite(options.similarity) || options.similarity < 0.01 || options.similarity > 1) throw new Error('相似度必须在 0.01 到 1 之间')
  if (!Number.isFinite(options.blend) || options.blend < 0 || options.blend > 1) throw new Error('混合必须在 0 到 1 之间')
  if (!['webm', 'mov', 'mp4'].includes(options.outputFormat)) throw new Error('输出格式无效')
  if (options.crop) cropToPixels(options.crop, metadata.width, metadata.height)
  if (extname(options.outputPath).toLowerCase() !== `.${options.outputFormat}`) throw new Error('输出文件扩展名与格式不一致')
  if (dirname(options.outputPath) === dirname(options.inputPath) && parse(options.outputPath).base === parse(options.inputPath).base) throw new Error('输出文件不能覆盖输入视频')
}
