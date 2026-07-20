import { describe, expect, it } from 'vitest'
import { summarizeBatch, type BatchTaskItem } from '../src/shared/batch-task'
import { buildFrameExtractArgs, buildVideoMattingFilters, cropToPixels, parseFfmpegProgress, parseVideoMetadata } from '../src/shared/ffmpeg-helpers'
import { detectBackgroundColor, matteRgbaImage, type RgbaImage } from '../src/shared/image-matting'
import type { FrameExtractOptions, VideoMattingOptions } from '../src/shared/media-api'

/** 创建指定填充色的 RGBA 测试图片。 */
function createImage(width: number, height: number, color: [number, number, number, number]): RgbaImage {
  const data = new Uint8Array(width * height * 4)
  for (let index = 0; index < width * height; index += 1) data.set(color, index * 4)
  return { width, height, data }
}

/** 修改测试图片中的一个像素。 */
function setPixel(image: RgbaImage, x: number, y: number, color: [number, number, number, number]): void {
  image.data.set(color, (y * image.width + x) * 4)
}

/** 读取测试图片中的 alpha 通道。 */
function alphaAt(image: RgbaImage, x: number, y: number): number {
  return image.data[(y * image.width + x) * 4 + 3]
}

describe('图片抠图算法', () => {
  it('从白色边缘检测出白色背景', () => {
    const image = createImage(5, 5, [250, 249, 251, 255])
    setPixel(image, 2, 2, [255, 0, 0, 255])
    expect(detectBackgroundColor(image)).toEqual({ r: 250, g: 249, b: 251 })
  })

  it('清除与边缘连通的背景并保留主体', () => {
    const image = createImage(5, 5, [255, 255, 255, 255])
    for (let y = 1; y < 4; y += 1) for (let x = 1; x < 4; x += 1) setPixel(image, x, y, [220, 20, 20, 255])
    const result = matteRgbaImage(image, { thresholdOffset: 20, feather: 0 })
    expect(alphaAt(result, 0, 0)).toBe(0)
    expect(alphaAt(result, 2, 2)).toBe(255)
  })

  it('保留被主体包围且不与边缘连通的相近颜色', () => {
    const image = createImage(5, 5, [255, 255, 255, 255])
    for (let y = 1; y < 4; y += 1) for (let x = 1; x < 4; x += 1) setPixel(image, x, y, [200, 0, 0, 255])
    setPixel(image, 2, 2, [255, 255, 255, 255])
    const result = matteRgbaImage(image, { thresholdOffset: 20, feather: 0 })
    expect(alphaAt(result, 2, 2)).toBe(255)
  })

  it('优先使用手动背景色', () => {
    const image = createImage(3, 3, [0, 255, 0, 255])
    const result = matteRgbaImage(image, { thresholdOffset: 20, feather: 12, background: { r: 0, g: 255, b: 0 } })
    expect(result.background).toEqual({ r: 0, g: 255, b: 0 })
    expect([...result.data.filter((_value, index) => index % 4 === 3)]).toEqual(new Array(9).fill(0))
  })
})

describe('FFmpeg 参数与进度', () => {
  it('解析时长、尺寸和普通帧率', () => {
    const text = 'Duration: 00:01:02.50, start: 0.0\nStream #0:0: Video: h264, yuv420p, 1920x1080, 29.97 fps'
    expect(parseVideoMetadata(text)).toEqual({ duration: 62.5, width: 1920, height: 1080, fps: 29.97 })
  })

  it('解析分数帧率', () => {
    const text = 'Duration: 00:00:10.00\nVideo: h264, 1280x720, 30000/1001 fps'
    expect(parseVideoMetadata(text)?.fps).toBeCloseTo(29.970, 3)
  })

  it('兼容 progress pipe 微秒和旧式 time', () => {
    expect(parseFfmpegProgress('out_time_us=2500000', 10)).toBe(0.25)
    expect(parseFfmpegProgress('frame=12 time=00:00:05.00 bitrate=0', 10)).toBe(0.5)
    expect(parseFfmpegProgress('progress=end', 10)).toBe(1)
  })

  it('抽帧滤镜保持裁剪后 FPS 且限制帧数', () => {
    const options: FrameExtractOptions = { inputPath: 'D:\\输入.mp4', outputRoot: 'D:\\输出', fps: 12, startSeconds: 1, endSeconds: 5, maxFrames: 30, crop: { x: .1, y: .1, width: .8, height: .8 } }
    const args = buildFrameExtractArgs(options, 'D:\\输出\\序列帧', { width: 1920, height: 1080 })
    expect(args[args.indexOf('-vf') + 1]).toBe('crop=1536:864:192:108,fps=12')
    expect(args[args.indexOf('-frames:v') + 1]).toBe('30')
    expect(args.at(-1)).toBe('D:\\输出\\序列帧\\frame_%05d.png')
  })

  it('视频抠图滤镜严格按降噪、翻转、裁剪、颜色键排序', () => {
    const options: VideoMattingOptions = {
      inputPath: 'D:\\输入.mp4', outputPath: 'D:\\输出.webm', background: { r: 1, g: 2, b: 3 }, similarity: .3, blend: .15,
      enableMatting: true, denoise: true, flipHorizontal: true, flipVertical: true, crop: { x: .1, y: .1, width: .8, height: .8 }, outputFormat: 'webm'
    }
    expect(buildVideoMattingFilters(options, { width: 1000, height: 500 })).toBe('hqdn3d=4:3:6:4,hflip,vflip,crop=800:400:100:50,colorkey=0x010203:0.30:0.15')
  })

  it('异常裁剪值会被限制在视频边界和偶数尺寸', () => {
    const result = cropToPixels({ x: .99, y: -.2, width: .9, height: 2 }, 1920, 1080)
    expect(result.x % 2).toBe(0)
    expect(result.width % 2).toBe(0)
    expect(result.x + result.width).toBeLessThanOrEqual(1920)
    expect(result.y + result.height).toBeLessThanOrEqual(1080)
  })
})

describe('批量任务汇总', () => {
  it('准确统计五种任务状态', () => {
    const statuses = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const
    const items = statuses.map((status, index): BatchTaskItem => ({ id: String(index), batchId: 'batch', kind: 'image-resize', inputPath: '', outputPath: '', status, progress: 0, stage: '' }))
    expect(summarizeBatch('batch', items)).toEqual({ batchId: 'batch', total: 5, queued: 1, running: 1, succeeded: 1, failed: 1, cancelled: 1 })
  })
})
