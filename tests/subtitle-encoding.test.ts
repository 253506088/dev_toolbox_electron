import { describe, expect, it, vi } from 'vitest'
import { buildSubtitleEncodingArgs, outputDimensions, parseSubtitleSourceInfo, SubtitleEncodingService, type SubtitleSourceInfo } from '../src/main/services/subtitle-encoding-service'

const source: SubtitleSourceInfo = { codec: 'hevc', pixelFormat: 'yuv420p10le', width: 3840, height: 2160 }
const success = { code: 0, stderr: 'frame=4\nfps=30.82\nout_time_us=166667\nspeed=1.28x\nprogress=end\n' }
const context = (probe = vi.fn(async (_args: string[]) => success)) => ({ inputPath: "F:\\4K '动画',[字幕]\\video.mkv", subtitleName: 'subtitle.ass', resolution: 'source' as const, probe })

describe('字幕硬件编码方案与真实支持检测', () => {
  it('从实际源流解析 4K HEVC10 参数并排除封面图片', () => {
    const info = parseSubtitleSourceInfo('Stream #0:0: Video: mjpeg, yuvj420p, 600x800 (attached pic)\nStream #0:1: Video: hevc (Main 10), yuv420p10le(tv, bt709), 3840x2160 [SAR 1:1], 24 fps')
    expect(info).toEqual(source)
    expect(outputDimensions(info, 'source')).toEqual({ outputWidth: 3840, outputHeight: 2160 })
    expect(outputDimensions(info, '1080p')).toEqual({ outputWidth: 1920, outputHeight: 1080 })
    expect(outputDimensions({ ...info, width: 1080, height: 1920 }, '1080p')).toEqual({ outputWidth: 606, outputHeight: 1080 })
    expect(() => outputDimensions({ ...info, width: 0 }, 'source')).toThrow('分辨率')
  })

  it('用真实短烧录预检而非 encoder 列表确认 QSV，并按源格式和尺寸缓存', async () => {
    const subject = new SubtitleEncodingService({ platform: 'win32' })
    const test = context()
    const first = await subject.select('test-ffmpeg.exe', source, 'auto', test)
    expect(first).toEqual({ kind: 'intel-qsv', encoder: 'h264_qsv', decoder: 'hevc_qsv', outputWidth: 3840, outputHeight: 2160 })
    expect(test.probe).toHaveBeenCalledTimes(1)
    const args = test.probe.mock.calls[0][0]
    expect(args).not.toContain('-encoders')
    expect(args).toContain('-hwaccel')
    expect(args).toContain('hevc_qsv')
    expect(args).toContain('h264_qsv')
    expect(args[args.indexOf('-frames:v') + 1]).toBe('4')
    const filter = args[args.indexOf('-vf') + 1]
    expect(filter).toBe('vpp_qsv=format=nv12,hwdownload,format=nv12,subtitles=filename=subtitle.ass:fontsdir=fonts:charenc=UTF-8,format=nv12')
    expect(filter).not.toContain('hwupload')
    expect(filter).not.toContain('F:')
    expect(args[args.indexOf('-async_depth') + 1]).toBe('8')
    expect(args.filter((value) => value === '-async_depth')).toHaveLength(1)
    expect(filter).not.toContain('async_depth')
    await subject.select('test-ffmpeg.exe', source, 'auto', test)
    expect(test.probe).toHaveBeenCalledTimes(1)
    await subject.select('test-ffmpeg.exe', { ...source, width: 1920, height: 1080 }, 'auto', test)
    expect(test.probe).toHaveBeenCalledTimes(2)
  })

  it('GPU 失败或零编码帧明确终止，不自动把 4K 任务丢给 CPU', async () => {
    const subject = new SubtitleEncodingService({ platform: 'win32' })
    const probe = vi.fn(async (_args: string[]) => ({ code: -1, stderr: 'QSV device initialization failed' }))
    await expect(subject.select('test-ffmpeg.exe', source, 'auto', context(probe as never))).rejects.toThrow('未自动回退')
    await expect(subject.select('test-ffmpeg.exe', source, 'auto', context(probe as never))).rejects.toThrow('CPU 快速编码')
    expect(probe).toHaveBeenCalledTimes(1)
    subject.invalidate()
    const zero = vi.fn(async (_args: string[]) => ({ code: 0, stderr: 'frame=0\nprogress=end' }))
    await expect(subject.select('test-ffmpeg.exe', source, 'auto', context(zero as never))).rejects.toThrow('预检')
  })

  it('CPU 快速模式必须显式选择，veryfast 编码并保留源 4K，1080p 也必须显式请求', async () => {
    const subject = new SubtitleEncodingService({ platform: 'win32' })
    const test = context()
    const plan = await subject.select('test-ffmpeg.exe', source, 'cpu-fast', test)
    expect(test.probe).not.toHaveBeenCalled()
    const args = buildSubtitleEncodingArgs(test.inputPath, 'subtitle.srt', 'output.mp4', 'mp4', plan, source)
    expect(args).toContain('libx264')
    expect(args[args.indexOf('-preset') + 1]).toBe('veryfast')
    expect(args[args.indexOf('-threads') + 1]).toBe('4')
    expect(args.indexOf('-threads')).toBeGreaterThan(args.indexOf('-i'))
    expect(args.slice(0, args.indexOf('-i'))).not.toContain('-threads')
    expect(args[args.indexOf('-vf') + 1]).not.toContain('scale=')
    expect(plan.outputWidth).toBe(3840)
    const resized = await subject.select('test-ffmpeg.exe', source, 'cpu-fast', { ...test, resolution: '1080p' })
    const resizedArgs = buildSubtitleEncodingArgs(test.inputPath, 'subtitle.ass', 'output.mp4', 'mp4', resized, source)
    expect(resizedArgs[resizedArgs.indexOf('-vf') + 1]).toContain('scale=1920:1080')
    expect(resizedArgs[resizedArgs.indexOf('-vf') + 1]).not.toContain('force_style')
  })

  it('hardwareStatus 只有实际编码帧成功才为可用，并支持缓存与显式刷新', async () => {
    const probe = vi.fn(async (_executable: string, _args: string[]) => success)
    const subject = new SubtitleEncodingService({ platform: 'win32', hardwareInfo: async () => ({ cpuName: 'Core Ultra 5 125H', gpuName: 'Intel Arc Graphics', driverVersion: '32.0.101.8331' }), hardwareProbe: probe })
    const status = await subject.hardwareStatus('test-ffmpeg.exe')
    expect(status.qsvAvailable).toBe(true)
    expect(status.gpuName).toBe('Intel Arc Graphics')
    expect(status.message).toContain('真实短编码')
    await subject.hardwareStatus('test-ffmpeg.exe')
    expect(probe).toHaveBeenCalledTimes(1)
    await subject.hardwareStatus('test-ffmpeg.exe', true)
    expect(probe).toHaveBeenCalledTimes(2)
    const broken = new SubtitleEncodingService({ platform: 'win32', hardwareInfo: async () => ({}), hardwareProbe: async () => ({ code: 0, stderr: 'frame=0\nprogress=end' }) })
    expect((await broken.hardwareStatus('test-ffmpeg.exe')).qsvAvailable).toBe(false)
  })

  it('显式刷新硬件状态会使此前成功的源链路缓存失效，更新后的驱动重新预检', async () => {
    let driverVersion = '32.0.101.8331'
    const subject = new SubtitleEncodingService({ platform: 'win32', hardwareInfo: async () => ({ gpuName: 'Intel Arc Graphics', driverVersion }), hardwareProbe: async () => success })
    const test = context()
    await subject.hardwareStatus('test-ffmpeg.exe')
    await subject.select('test-ffmpeg.exe', source, 'auto', test)
    await subject.select('test-ffmpeg.exe', source, 'auto', test)
    expect(test.probe).toHaveBeenCalledTimes(1)
    driverVersion = 'new-driver'
    const refreshed = await subject.hardwareStatus('test-ffmpeg.exe', true)
    expect(refreshed.driverVersion).toBe('new-driver')
    await subject.select('test-ffmpeg.exe', source, 'auto', test)
    expect(test.probe).toHaveBeenCalledTimes(2)
  })

  it('退出时取消检测，硬件信息读取结束后不会又启动一个 GPU 子任务', async () => {
    let resolveInfo!: (value: {}) => void
    const info = new Promise<{}>((resolveResult) => { resolveInfo = resolveResult })
    const probe = vi.fn(async (_executable: string, _args: string[]) => success)
    const subject = new SubtitleEncodingService({ platform: 'win32', hardwareInfo: () => info, hardwareProbe: probe })
    const status = subject.hardwareStatus('test-ffmpeg.exe')
    await new Promise((resolveResult) => setTimeout(resolveResult, 10))
    expect(subject.hasRunning()).toBe(true)
    const stopping = subject.stopAll()
    resolveInfo({})
    await stopping
    expect((await status).qsvAvailable).toBe(false)
    expect(probe).not.toHaveBeenCalled()
    expect(subject.hasRunning()).toBe(false)
  })

  it('检测刚开始读取可执行文件状态时就退出，也不会再查询硬件或创建编码任务', async () => {
    const info = vi.fn(async () => ({}))
    const probe = vi.fn(async (_executable: string, _args: string[]) => success)
    const subject = new SubtitleEncodingService({ platform: 'win32', hardwareInfo: info, hardwareProbe: probe })
    const checking = subject.hardwareStatus('test-ffmpeg.exe')
    expect(subject.hasRunning()).toBe(true)
    await subject.stopAll()
    expect((await checking).qsvAvailable).toBe(false)
    expect(info).not.toHaveBeenCalled()
    expect(probe).not.toHaveBeenCalled()
    expect(subject.hasRunning()).toBe(false)
  })

  it('检测异常明确报告不可用；源预检超时缓存失败，用户取消不污染支持结果', async () => {
    const broken = new SubtitleEncodingService({ platform: 'win32', hardwareInfo: async () => ({}), hardwareProbe: async () => { throw new Error('driver disabled') } })
    const status = await broken.hardwareStatus('test-ffmpeg.exe')
    expect(status.qsvAvailable).toBe(false)
    expect(status.message).toContain('driver disabled')
    const subject = new SubtitleEncodingService({ platform: 'win32' })
    const timeout = vi.fn(async (_args: string[]) => { throw new Error('QSV 预检超时') })
    await expect(subject.select('test-ffmpeg.exe', source, 'auto', context(timeout))).rejects.toThrow('QSV 预检超时')
    await expect(subject.select('test-ffmpeg.exe', source, 'auto', context(timeout))).rejects.toThrow('未自动回退')
    expect(timeout).toHaveBeenCalledTimes(1)
    subject.invalidate()
    const cancel = vi.fn(async (_args: string[]) => success).mockRejectedValueOnce(new Error('字幕任务已取消'))
    await expect(subject.select('test-ffmpeg.exe', source, 'auto', context(cancel))).rejects.toThrow('已取消')
    await expect(subject.select('test-ffmpeg.exe', source, 'auto', context(cancel))).resolves.toHaveProperty('encoder', 'h264_qsv')
    expect(cancel).toHaveBeenCalledTimes(2)
  })
})
