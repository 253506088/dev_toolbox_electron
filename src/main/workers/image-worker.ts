import { parentPort } from 'node:worker_threads'
import sharp from 'sharp'
import type { ImageMattingOptions, ImageResizeOptions } from '../../shared/media-api'
import { matteRgbaImage } from '../../shared/image-matting'

interface ImageWorkerRequest {
  operation: 'image-resize' | 'image-matting'
  inputPath: string
  outputPath: string
  resize?: ImageResizeOptions
  matting?: ImageMattingOptions
}

/** 向任务池报告当前处理阶段。 */
function report(progress: number, stage: string): void {
  parentPort?.postMessage({ type: 'progress', progress, stage })
}

/** 执行一个缩放或抠图文件任务。 */
async function processImage(request: ImageWorkerRequest): Promise<void> {
  report(0.12, '读取图片')
  if (request.operation === 'image-resize') {
    if (!request.resize) throw new Error('缺少缩放参数')
    report(0.35, '缩放与裁剪')
    await sharp(request.inputPath)
      .rotate()
      .resize(request.resize.width, request.resize.height, {
        fit: request.resize.fit,
        position: 'centre',
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .png()
      .toFile(request.outputPath)
  } else {
    if (!request.matting) throw new Error('缺少抠图参数')
    report(0.28, '解码像素')
    const source = await sharp(request.inputPath).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    report(0.52, '分析背景并抠图')
    const result = matteRgbaImage({ width: source.info.width, height: source.info.height, data: source.data }, request.matting)
    report(0.82, '写入透明 PNG')
    await sharp(result.data, { raw: { width: result.width, height: result.height, channels: 4 } }).png().toFile(request.outputPath)
  }
  report(1, '处理完成')
}

parentPort?.once('message', (request: ImageWorkerRequest) => {
  void processImage(request)
    .then(() => parentPort?.postMessage({ type: 'completed' }))
    .catch((error: unknown) => parentPort?.postMessage({ type: 'failed', error: error instanceof Error ? error.message : String(error) }))
})
