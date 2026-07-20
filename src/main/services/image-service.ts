import { access, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import sharp from 'sharp'
import { IMAGE_EXTENSIONS, type ImageMattingOptions, type ImageMetadata, type ImagePreviewResult, type ImageResizeOptions } from '../../shared/media-api'
import { matteRgbaImage } from '../../shared/image-matting'
import { MediaSourceService } from './media-source-service'

const SUPPORTED_EXTENSIONS = new Set(IMAGE_EXTENSIONS.map((extension) => `.${extension}`))

/** 校验图片路径及扩展名。 */
export async function assertImagePath(filePath: string): Promise<void> {
  if (typeof filePath !== 'string' || !SUPPORTED_EXTENSIONS.has(extname(filePath).toLowerCase())) throw new Error('不支持的图片格式')
  await access(filePath)
}

/** 负责图片元数据、预览、缩放和抠图。 */
export class ImageService {
  constructor(private readonly sources: MediaSourceService) {}

  /** 读取图片尺寸、格式、大小和预览地址。 */
  async metadata(filePath: string): Promise<ImageMetadata> {
    await assertImagePath(filePath)
    const [metadata, fileInfo, previewUrl] = await Promise.all([
      sharp(filePath).rotate().metadata(),
      stat(filePath),
      this.sources.register(filePath)
    ])
    const width = metadata.autoOrient.width
    const height = metadata.autoOrient.height
    if (!width || !height) throw new Error('无法读取图片尺寸')
    return {
      path: filePath,
      name: basename(filePath),
      width,
      height,
      format: metadata.format ?? extname(filePath).slice(1),
      size: fileInfo.size,
      previewUrl
    }
  }

  /** 生成限定尺寸的缩放裁剪 PNG 预览。 */
  async previewResize(filePath: string, options: ImageResizeOptions): Promise<ImagePreviewResult> {
    const input = await resolveImageInput(filePath)
    validateResizeOptions(options)
    const scale = Math.min(1, 900 / Math.max(options.width, options.height))
    const width = Math.max(1, Math.round(options.width * scale))
    const height = Math.max(1, Math.round(options.height * scale))
    const buffer = await sharp(input)
      .rotate()
      .resize(width, height, { fit: options.fit, position: 'centre', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer()
    return { dataUrl: `data:image/png;base64,${buffer.toString('base64')}`, width, height }
  }

  /** 生成最长边不超过 900 像素的抠图 PNG 预览。 */
  async previewMatting(filePath: string, options: ImageMattingOptions): Promise<ImagePreviewResult> {
    const input = await resolveImageInput(filePath)
    validateMattingOptions(options)
    const source = await sharp(input)
      .rotate()
      .resize({ width: 900, height: 900, fit: 'inside', withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const result = matteRgbaImage({ width: source.info.width, height: source.info.height, data: source.data }, options)
    const buffer = await sharp(result.data, { raw: { width: result.width, height: result.height, channels: 4 } }).png().toBuffer()
    return {
      dataUrl: `data:image/png;base64,${buffer.toString('base64')}`,
      width: result.width,
      height: result.height,
      background: result.background
    }
  }
}

/** 把受控文件路径或剪贴板 data URL 转为 sharp 输入。 */
async function resolveImageInput(source: string): Promise<string | Buffer> {
  const match = /^data:image\/(png|jpeg|webp|bmp);base64,([A-Za-z0-9+/=]+)$/.exec(source)
  if (match) {
    const buffer = Buffer.from(match[2], 'base64')
    if (buffer.length === 0 || buffer.length > 50 * 1024 * 1024) throw new Error('剪贴板图片大小无效')
    return buffer
  }
  await assertImagePath(source)
  return source
}

/** 校验缩放参数，防止异常尺寸耗尽内存。 */
export function validateResizeOptions(options: ImageResizeOptions): void {
  if (!options || !Number.isInteger(options.width) || !Number.isInteger(options.height)) throw new Error('目标宽高必须是整数')
  if (options.width < 1 || options.height < 1 || options.width > 20_000 || options.height > 20_000) throw new Error('目标宽高必须在 1 到 20000 像素之间')
  if (options.fit !== 'cover' && options.fit !== 'contain') throw new Error('缩放模式无效')
}

/** 校验抠图参数与手动背景色。 */
export function validateMattingOptions(options: ImageMattingOptions): void {
  if (!options || !Number.isFinite(options.thresholdOffset) || options.thresholdOffset < -200 || options.thresholdOffset > 200) throw new Error('阈值偏移必须在 -200 到 200 之间')
  if (!Number.isFinite(options.feather) || options.feather < 0 || options.feather > 80) throw new Error('羽化必须在 0 到 80 之间')
  if (options.background) {
    for (const channel of [options.background.r, options.background.g, options.background.b]) {
      if (!Number.isInteger(channel) || channel < 0 || channel > 255) throw new Error('背景色通道必须在 0 到 255 之间')
    }
  }
}
