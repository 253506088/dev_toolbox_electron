import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { stat } from 'node:fs/promises'
import type { SubtitleAcceleration, SubtitleHardwareStatus, SubtitleResolution } from '../../shared/subtitle-api'

export interface SubtitleSourceInfo {
  codec: string
  pixelFormat: string
  width: number
  height: number
}

export interface SubtitleEncodingPlan {
  kind: 'intel-qsv' | 'cpu-fast'
  encoder: 'h264_qsv' | 'libx264'
  decoder: string
  outputWidth: number
  outputHeight: number
}

export interface SubtitleProbeResult { code: number | null; stderr: string }
export interface SubtitleHardwareInfo { cpuName?: string; gpuName?: string; driverVersion?: string }
interface EncodingContext {
  inputPath: string
  subtitleName: string
  resolution: SubtitleResolution
  probe(args: string[]): Promise<SubtitleProbeResult>
}

interface EncodingOptions {
  platform?: string
  now?: () => number
  hardwareInfo?: () => Promise<SubtitleHardwareInfo>
  hardwareProbe?: (executable: string, args: string[]) => Promise<SubtitleProbeResult>
}

const QSV_DECODERS: Record<string, string> = { hevc: 'hevc_qsv', h264: 'h264_qsv', av1: 'av1_qsv', vp9: 'vp9_qsv', mpeg2video: 'mpeg2_qsv' }
const QSV_INITIALIZATION = ['-init_hw_device', 'qsv=hw,child_device_type=d3d11va', '-filter_hw_device', 'hw']
// 本机 Arc 的原源对白实测参数。decoder/vpp 保持默认深度，只将编码器深度设为 8。
const QSV_ENCODING = ['-preset', 'veryfast', '-global_quality', '20', '-look_ahead', '0', '-low_power', '1', '-async_depth', '8']
const QSV_STRATEGY = 'qsv-d3d11-native-libass-nv12-encoder-depth8-v2'

/** 实测硬件编码与每种源格式的烧录链路；从不把 GPU 运行失败改成耗时的 CPU 编码。 */
export class SubtitleEncodingService {
  private readonly capabilities = new Map<string, { checkedAt: number; supported: boolean; reason: string }>()
  private hardwareCache?: { key: string; status: SubtitleHardwareStatus }
  private hardwarePending?: Promise<SubtitleHardwareStatus>
  private readonly processes = new Set<ChildProcessWithoutNullStreams>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly platform: string
  private readonly now: () => number
  private stopGeneration = 0

  constructor(private readonly options: EncodingOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.now = options.now ?? Date.now
  }

  async select(executable: string, source: SubtitleSourceInfo, acceleration: SubtitleAcceleration, context: EncodingContext): Promise<SubtitleEncodingPlan> {
    const output = outputDimensions(source, context.resolution)
    if (acceleration === 'cpu-fast') return { kind: 'cpu-fast', encoder: 'libx264', decoder: `${source.codec || '自动'}（CPU）`, ...output }
    if (this.platform !== 'win32') throw new Error('当前系统尚未验证 Intel QSV 烧录链路，请明确选择 CPU 快速编码')
    const decoder = QSV_DECODERS[source.codec]
    if (!decoder) throw new Error(`Intel QSV 未支持当前 ${source.codec || '未知'} 视频的硬件解码，请明确选择 CPU 快速编码`)
    const plan: SubtitleEncodingPlan = { kind: 'intel-qsv', encoder: 'h264_qsv', decoder, ...output }
    const key = await this.sourceKey(executable, source, context.resolution)
    const cached = this.capabilities.get(key)
    const lifetime = cached?.supported ? 30 * 60_000 : 30_000
    if (cached && this.now() - cached.checkedAt < lifetime) {
      if (cached.supported) return plan
      throw hardwareFailure(cached.reason, source)
    }
    let result: SubtitleProbeResult
    try { result = await context.probe(buildSubtitleEncodingArgs(context.inputPath, context.subtitleName, '-', 'mp4', plan, source, { probeFrames: 4 })) }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (/取消|cancel/i.test(reason)) throw error
      this.capabilities.set(key, { checkedAt: this.now(), supported: false, reason })
      throw hardwareFailure(reason, source)
    }
    const supported = encodedFrames(result) > 0 && result.code === 0
    const reason = result.stderr.slice(-2200)
    this.capabilities.set(key, { checkedAt: this.now(), supported, reason })
    if (!supported) throw hardwareFailure(reason, source)
    return plan
  }

  /** 编码设备在长任务中失效后，后续任务必须重新验证，绝不复用过期成功记录。 */
  invalidate(): void { this.capabilities.clear(); this.hardwareCache = undefined }

  hardwareStatus(executable: string, force = false): Promise<SubtitleHardwareStatus> {
    if (this.hardwarePending) return this.hardwarePending
    const generation = this.stopGeneration
    const promise = (async () => {
      const key = await this.executableKey(executable)
      if (generation !== this.stopGeneration) return { qsvAvailable: false, checkedAt: new Date(this.now()).toISOString(), message: '硬件检测已取消' }
      const cached = this.hardwareCache
      if (!force && cached?.key === key && this.now() - Date.parse(cached.status.checkedAt) < (cached.status.qsvAvailable ? 30 * 60_000 : 30_000)) return structuredClone(cached.status)
      if (force) this.invalidate()
      const status = await this.checkHardware(executable, generation)
      if (generation === this.stopGeneration) this.hardwareCache = { key, status }
      return structuredClone(status)
    })()
    this.hardwarePending = promise
    this.pending.add(promise)
    const finish = (): void => { this.pending.delete(promise); if (this.hardwarePending === promise) this.hardwarePending = undefined }
    void promise.then(finish, finish)
    return promise
  }

  hasRunning(): boolean { return this.processes.size > 0 || this.pending.size > 0 || Boolean(this.hardwarePending) }

  async stopAll(): Promise<void> {
    this.stopGeneration++
    this.invalidate()
    for (const child of this.processes) child.kill()
    await Promise.allSettled([...this.pending])
  }

  private async checkHardware(executable: string, generation: number): Promise<SubtitleHardwareStatus> {
    const info = await (this.options.hardwareInfo?.() ?? this.readHardwareInfo()).catch(() => ({} as SubtitleHardwareInfo))
    const checkedAt = (): string => new Date(this.now()).toISOString()
    if (generation !== this.stopGeneration) return { ...info, qsvAvailable: false, checkedAt: checkedAt(), message: '硬件检测已取消' }
    if (this.platform !== 'win32') return { ...info, qsvAvailable: false, checkedAt: checkedAt(), message: '当前系统尚未验证 Intel QSV，请选择 CPU 快速编码' }
    const args = ['-hide_banner', '-nostdin', '-progress', 'pipe:2', '-nostats', ...QSV_INITIALIZATION, '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=24:d=0.2', '-an', '-frames:v', '4', '-c:v', 'h264_qsv', ...QSV_ENCODING, '-f', 'null', '-']
    const result = await (this.options.hardwareProbe?.(executable, args) ?? this.runProcess(executable, args, 15_000)).catch((error: unknown): SubtitleProbeResult => ({ code: -1, stderr: error instanceof Error ? error.message : String(error) }))
    if (generation !== this.stopGeneration) return { ...info, qsvAvailable: false, checkedAt: checkedAt(), message: '硬件检测已取消' }
    const available = result.code === 0 && encodedFrames(result) > 0
    return {
      ...info, qsvAvailable: available, checkedAt: checkedAt(),
      message: available ? 'Intel QSV 已通过真实短编码检测；每种源视频还会预检硬解与字幕烧录' : `Intel QSV 实测不可用，请选择 CPU 快速编码\n${result.stderr.slice(-1500)}`
    }
  }

  private async sourceKey(executable: string, source: SubtitleSourceInfo, resolution: SubtitleResolution): Promise<string> {
    const hardware = this.hardwareCache?.status
    const driver = `${hardware?.gpuName ?? ''}|${hardware?.driverVersion ?? ''}`
    return `${QSV_STRATEGY}|${await this.executableKey(executable)}|${driver}|${source.codec}|${source.pixelFormat}|${source.width}x${source.height}|${resolution}`
  }

  private async executableKey(executable: string): Promise<string> {
    const info = await stat(executable).catch(() => null)
    return `${executable}|${info?.size ?? ''}|${info?.mtimeMs ?? ''}`
  }

  private async readHardwareInfo(): Promise<SubtitleHardwareInfo> {
    if (this.platform !== 'win32') return {}
    const script = "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1; $gpus = @(Get-CimInstance Win32_VideoController | Where-Object { $_.PNPDeviceID -like 'PCI*' }); $gpu = $gpus | Where-Object { $_.PNPDeviceID -match 'VEN_8086' } | Select-Object -First 1; if (-not $gpu) { $gpu = $gpus | Select-Object -First 1 }; @{cpuName=$cpu.Name;gpuName=$gpu.Name;driverVersion=$gpu.DriverVersion} | ConvertTo-Json -Compress"
    const result = await this.runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 10_000, true)
    if (result.code !== 0) return {}
    try { return JSON.parse(result.stderr.trim()) as SubtitleHardwareInfo }
    catch { return {} }
  }

  private runProcess(executable: string, args: string[], timeoutMs: number, captureStdout = false): Promise<SubtitleProbeResult> {
    const promise = new Promise<SubtitleProbeResult>((resolveResult) => {
      const child = spawn(executable, args, { windowsHide: true })
      this.processes.add(child)
      let output = ''
      let error: string | undefined
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; child.kill() }, timeoutMs)
      const stream = captureStdout ? child.stdout : child.stderr
      stream.on('data', (bytes: Buffer) => { output = (output + bytes.toString('utf8')).slice(-65536) })
      if (captureStdout) child.stderr.resume(); else child.stdout.resume()
      child.once('error', (failure) => { error = failure.message })
      child.once('close', (code) => {
        clearTimeout(timer)
        this.processes.delete(child)
        resolveResult({ code: error || timedOut ? -1 : code, stderr: timedOut ? `硬件检测超时\n${output}` : error ? `无法执行检测：${error}` : output })
      })
    })
    this.pending.add(promise)
    const finish = (): void => { this.pending.delete(promise) }
    void promise.then(finish, finish)
    return promise
  }
}

/** 提取实际视频流参数，跳过封面图，硬件路径按真实格式选择。 */
export function parseSubtitleSourceInfo(stderr: string): SubtitleSourceInfo {
  const line = stderr.split(/\r?\n/).find((text) => /Stream #.*Video:/.test(text) && !/attached pic/.test(text)) ?? ''
  const codec = /Video:\s*([^,\s(]+)/.exec(line)?.[1] ?? ''
  const size = /(?:^|[,\s])(\d{2,5})x(\d{2,5})(?:[,\s\[]|$)/.exec(line)
  const pixelFormat = /\b((?:yuva?|gbrp|gray|nv12|p010|p016)[a-z\d]*(?:le|be)?)\b/.exec(line)?.[1] ?? ''
  return { codec, pixelFormat, width: Number(size?.[1] ?? 0), height: Number(size?.[2] ?? 0) }
}

/** 保持源尺寸；1080p 只有显式请求时才按比例缩小。 */
export function outputDimensions(source: SubtitleSourceInfo, resolution: SubtitleResolution): { outputWidth: number; outputHeight: number } {
  if (!(source.width > 0 && source.height > 0)) throw new Error('无法确定视频尺寸，不能保证输出保持原分辨率')
  const ratio = resolution === '1080p' ? Math.min(1, 1920 / source.width, 1080 / source.height) : 1
  return { outputWidth: resolution === 'source' ? Math.ceil(source.width / 2) * 2 : Math.max(2, Math.floor(source.width * ratio / 2) * 2), outputHeight: resolution === 'source' ? Math.ceil(source.height / 2) * 2 : Math.max(2, Math.floor(source.height * ratio / 2) * 2) }
}

export function buildSubtitleEncodingArgs(video: string, subtitleName: string, output: string, format: 'mp4' | 'mkv', plan: SubtitleEncodingPlan, source: SubtitleSourceInfo, options: { probeFrames?: number } = {}): string[] {
  if (!/^subtitle\.(?:srt|ass|ssa|vtt)$/.test(subtitleName)) throw new Error('临时字幕文件名无效')
  const subtitleFilter = `subtitles=filename=${subtitleName}:fontsdir=fonts:charenc=UTF-8${/\.(?:ass|ssa)$/.test(subtitleName) ? '' : ":force_style='FontName=Noto Sans SC'"}`
  const resizing = plan.outputWidth !== source.width || plan.outputHeight !== source.height
  const gpu = plan.kind === 'intel-qsv'
  const args = ['-hide_banner', '-nostdin', '-progress', 'pipe:2', '-nostats', '-filter_threads', '2']
  if (gpu) args.push(...QSV_INITIALIZATION, '-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv', '-c:v', plan.decoder)
  args.push('-i', video, '-map', '0:V:0')
  if (!options.probeFrames) args.push('-map', '0:a?', '-map_metadata', '0', '-map_chapters', '0')
  const filter = gpu
    ? `vpp_qsv=${resizing ? `w=${plan.outputWidth}:h=${plan.outputHeight}:` : ''}format=nv12,hwdownload,format=nv12,${subtitleFilter},format=nv12`
    : `${resizing ? `scale=${plan.outputWidth}:${plan.outputHeight},` : ''}${subtitleFilter},pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p`
  args.push('-vf', filter, '-sn', '-dn', '-c:v', plan.encoder)
  if (gpu) args.push(...QSV_ENCODING)
  else args.push('-preset', 'veryfast', '-threads', '4', '-crf', '18', '-pix_fmt', 'yuv420p')
  if (options.probeFrames) args.push('-frames:v', String(options.probeFrames), '-an', '-f', 'null', '-')
  else {
    args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2')
    if (format === 'mp4') args.push('-movflags', '+faststart')
    args.push('-n', output)
  }
  return args
}

function encodedFrames(result: SubtitleProbeResult): number { return Math.max(0, ...[...result.stderr.matchAll(/^frame=(\d+)\s*$/gm)].map((match) => Number(match[1]))) }
function hardwareFailure(reason: string, source: SubtitleSourceInfo): Error {
  return new Error(`Intel QSV 未通过 ${source.width}×${source.height} ${source.codec} 硬解与字幕烧录预检，已停止，未自动回退到 CPU；请明确选择 CPU 快速编码或检查显卡驱动\n${reason}`)
}
