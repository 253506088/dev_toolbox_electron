import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { BrowserWindow, powerSaveBlocker, type WebContents } from 'electron'
import sharp from 'sharp'
import type {
  WechatExportEvent,
  WechatMarkdownToPdfRequest,
  WechatMarkdownToPdfResult,
  WechatOcrBeginRequest,
  WechatOcrBeginResult,
  WechatOcrDirectoryRequest,
  WechatOcrDirectoryStartResult,
  WechatOcrEngine,
  WechatOcrFinishResult,
  WechatOcrPageResult,
  WechatSlimImagesRequest,
  WechatSlimImagesResult,
  WechatStitchImagesRequest,
  WechatStitchImagesResult
} from '../../shared/wechat-export'
import { planStitchGroups } from '../../shared/wechat-export'
import { assembleTranscript, buildPageMessages, segmentChatPage, type ChatMessage, type OcrWord } from '../../shared/wechat-transcript'
import { WechatOcrController } from './wechat-ocr-controller'
import { DeepseekOcrClient, validateDeepseekConfig } from './wechat-dsocr-client'

const OCR_MAX_DIMENSION = 2400
/** 识别前把过小的图放大到该宽度附近，Windows OCR 对更大的字号明显更准。 */
const OCR_TARGET_WIDTH = 1800
const SLIM_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])

interface OcrSession {
  id: string
  sourcePath: string
  tempDir: string
  engine: WechatOcrEngine
  controller: WechatOcrController | null
  deepseekClient: DeepseekOcrClient | null
  pages: Map<number, ChatMessage[]>
  cancelled: boolean
  sender: WebContents | null
  throttlingDisabled: boolean
  blockerId: number | null
}

/** 微信截图后处理：MD 转 PDF、图片瘦身、分屏拼接长图、PDF 版面分析 OCR。 */
export class WechatExportService {
  private readonly ocrSessions = new Map<string, OcrSession>()

  /** 把截图 Markdown 转为体积可控的 PDF：图片按宽度缩放并转 JPEG 后内联，再交给隐藏窗口打印。 */
  async markdownToPdf(request: WechatMarkdownToPdfRequest, sender: WebContents): Promise<WechatMarkdownToPdfResult> {
    validatePdfRequest(request)
    const markdown = await readFile(request.markdownPath, 'utf8')
    const baseDirectory = dirname(request.markdownPath)
    const emit = (message: string, current?: number, total?: number): void =>
      this.emit(sender, { task: 'pdf', stage: 'running', message, current, total })

    const imageLines = markdown.split('\n').filter((line) => /^!\[.*\]\(.+\)$/.test(line.trim()))
    const totalImages = imageLines.length
    let convertedImages = 0
    let skippingSection = false
    const htmlParts: string[] = []
    for (const rawLine of markdown.split('\n')) {
      const line = rawLine.trim()
      if (line.startsWith('## ')) {
        skippingSection = request.onlyScreens && line.includes('无缝长图')
        if (!skippingSection) htmlParts.push(`<h2>${escapeHtml(line.slice(3))}</h2>`)
        continue
      }
      if (skippingSection) continue
      if (line.startsWith('# ')) {
        htmlParts.push(`<h1>${escapeHtml(line.slice(2))}</h1>`)
        continue
      }
      const imageMatch = /^!\[(.*)\]\((.+)\)$/.exec(line)
      if (imageMatch) {
        const imagePath = join(baseDirectory, decodeURI(imageMatch[2]).replace(/^\.\//, ''))
        const jpeg = await sharp(imagePath)
          .resize({ width: request.imageWidth, withoutEnlargement: true })
          .flatten({ background: '#ffffff' })
          .jpeg({ quality: request.jpegQuality })
          .toBuffer()
        htmlParts.push(`<img src="data:image/jpeg;base64,${jpeg.toString('base64')}" alt="${escapeHtml(imageMatch[1])}" />`)
        convertedImages += 1
        if (convertedImages % 5 === 0 || convertedImages === totalImages) {
          emit(`正在压缩嵌入图片 ${convertedImages}/${totalImages}...`, convertedImages, totalImages)
        }
        continue
      }
      if (line.startsWith('- ')) {
        htmlParts.push(`<p class="meta">${escapeHtml(line.slice(2))}</p>`)
        continue
      }
      if (line) htmlParts.push(`<p>${escapeHtml(line)}</p>`)
    }

    emit('正在渲染并打印 PDF...')
    const html = buildPdfHtml(htmlParts.join('\n'))
    const tempHtmlPath = join(tmpdir(), `wechat-md-${crypto.randomUUID()}.html`)
    await writeFile(tempHtmlPath, html, 'utf8')
    const window = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true }
    })
    try {
      await window.loadFile(tempHtmlPath)
      await delay(400)
      const pdf = await window.webContents.printToPDF({
        printBackground: true,
        pageSize: 'A4',
        margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 }
      })
      const pdfPath = `${request.markdownPath.replace(/\.md$/i, '')}.pdf`
      await writeFile(pdfPath, pdf)
      this.emit(sender, { task: 'pdf', stage: 'complete', message: `PDF 已生成：${basename(pdfPath)}` })
      return { pdfPath, pdfBytes: pdf.byteLength, imageCount: convertedImages }
    } finally {
      window.destroy()
      await rm(tempHtmlPath, { force: true })
    }
  }

  /** 批量把目录里的图片缩放并转成 WebP/JPEG，输出到同级“_瘦身”目录。 */
  async slimImages(request: WechatSlimImagesRequest, sender: WebContents): Promise<WechatSlimImagesResult> {
    validateSlimRequest(request)
    const entries = await readdir(request.inputDirectory, { withFileTypes: true })
    const files = entries
      .filter((entry) => entry.isFile() && SLIM_EXTENSIONS.has(extname(entry.name).toLowerCase()))
      .map((entry) => entry.name)
      .sort()
    if (files.length === 0) throw new Error('目录中没有可处理的图片（支持 png/jpg/webp）')

    const outputDirectory = `${request.inputDirectory.replace(/[\\/]+$/, '')}_瘦身`
    await rm(outputDirectory, { recursive: true, force: true })
    await mkdir(outputDirectory, { recursive: true })

    let inputBytes = 0
    let outputBytes = 0
    for (let index = 0; index < files.length; index += 1) {
      const name = files[index]
      const sourcePath = join(request.inputDirectory, name)
      const targetName = `${name.slice(0, name.length - extname(name).length)}.${request.format === 'webp' ? 'webp' : 'jpg'}`
      const targetPath = join(outputDirectory, targetName)
      const pipeline = sharp(sourcePath).resize({ width: request.maxWidth, withoutEnlargement: true })
      const output =
        request.format === 'webp'
          ? await pipeline.webp({ quality: request.quality }).toBuffer()
          : await pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: request.quality }).toBuffer()
      await writeFile(targetPath, output)
      inputBytes += (await stat(sourcePath)).size
      outputBytes += output.byteLength
      if ((index + 1) % 5 === 0 || index + 1 === files.length) {
        this.emit(sender, {
          task: 'slim',
          stage: 'running',
          message: `正在压缩 ${index + 1}/${files.length}...`,
          current: index + 1,
          total: files.length
        })
      }
    }
    this.emit(sender, {
      task: 'slim',
      stage: 'complete',
      message: `压缩完成：${formatBytes(inputBytes)} → ${formatBytes(outputBytes)}`
    })
    return { outputDirectory, fileCount: files.length, inputBytes, outputBytes }
  }

  /** 把目录里按文件名排序的分屏截图纵向拼接成一张或多张长图，超过高度上限就另起一张。 */
  async stitchImages(request: WechatStitchImagesRequest, sender: WebContents): Promise<WechatStitchImagesResult> {
    validateStitchRequest(request)
    const entries = await readdir(request.inputDirectory, { withFileTypes: true })
    const files = entries
      .filter((entry) => entry.isFile() && SLIM_EXTENSIONS.has(extname(entry.name).toLowerCase()))
      .map((entry) => entry.name)
      .sort()
    if (files.length === 0) throw new Error('目录中没有可拼接的图片（支持 png/jpg/webp）')

    // 以第一张图的宽度为基准，宽度不同的图等比缩放对齐
    const widths: number[] = []
    const heights: number[] = []
    for (const name of files) {
      const metadata = await sharp(join(request.inputDirectory, name)).metadata()
      if (!metadata.width || !metadata.height) throw new Error(`无法读取图片尺寸：${name}`)
      widths.push(metadata.width)
      heights.push(metadata.height)
    }
    const width = widths[0]
    const scaledHeights = heights.map((height, index) =>
      widths[index] === width ? height : Math.max(1, Math.round((height * width) / widths[index]))
    )

    const groups = planStitchGroups(scaledHeights, request.maxHeight)
    const outputDirectory = `${request.inputDirectory.replace(/[\\/]+$/, '')}_拼接长图`
    await rm(outputDirectory, { recursive: true, force: true })
    await mkdir(outputDirectory, { recursive: true })

    let stitched = 0
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      const pieces: Array<{ input: string | Buffer; top: number; left: number }> = []
      let top = 0
      for (const fileIndex of groups[groupIndex]) {
        const sourcePath = join(request.inputDirectory, files[fileIndex])
        pieces.push({
          input: widths[fileIndex] === width ? sourcePath : await sharp(sourcePath).resize({ width }).png().toBuffer(),
          top,
          left: 0
        })
        top += scaledHeights[fileIndex]
        stitched += 1
      }
      this.emit(sender, {
        task: 'stitch',
        stage: 'running',
        message: `正在拼接第 ${groupIndex + 1}/${groups.length} 张长图（${stitched}/${files.length}）...`,
        current: stitched,
        total: files.length
      })
      const outputPath = join(outputDirectory, `long_${String(groupIndex + 1).padStart(3, '0')}.png`)
      await sharp({ create: { width, height: top, channels: 3, background: '#ffffff' } })
        .composite(pieces)
        .png()
        .toFile(outputPath)
    }
    this.emit(sender, {
      task: 'stitch',
      stage: 'complete',
      message: `拼接完成：${files.length} 张分屏 → ${groups.length} 张长图`,
      resultPath: outputDirectory
    })
    return { outputDirectory, fileCount: files.length, imageCount: groups.length }
  }

  /** 开始一次 PDF OCR 会话，返回会话 ID 和 PDF 原始字节（供渲染层用 pdfjs 逐页光栅化）。 */
  async ocrBegin(request: WechatOcrBeginRequest, sender: WebContents): Promise<WechatOcrBeginResult & { pdfData: Uint8Array }> {
    if (typeof request?.pdfPath !== 'string' || !/\.pdf$/i.test(request.pdfPath)) throw new Error('请选择 PDF 文件')
    const pdfData = await readFile(request.pdfPath)
    const session = await this.createSession(request.pdfPath, sender, true, request.engine, request.deepseek)
    return { sessionId: session.id, pdfData: new Uint8Array(pdfData) }
  }

  /** 图片目录 OCR：整个循环在主进程后台执行，不受窗口最小化节流影响。 */
  async ocrDirectoryStart(request: WechatOcrDirectoryRequest, sender: WebContents): Promise<WechatOcrDirectoryStartResult> {
    if (typeof request?.directory !== 'string' || !request.directory.trim()) throw new Error('请选择图片目录')
    const entries = await readdir(request.directory, { withFileTypes: true })
    const files = entries
      .filter((entry) => entry.isFile() && SLIM_EXTENSIONS.has(extname(entry.name).toLowerCase()))
      .map((entry) => join(request.directory, entry.name))
      .sort()
    if (files.length === 0) throw new Error('目录中没有可识别的图片（支持 png/jpg/webp）')
    const session = await this.createSession(request.directory, sender, false, request.engine, request.deepseek)
    void this.executeDirectoryOcr(session, files, sender)
    return { runId: session.id, fileCount: files.length }
  }

  private async executeDirectoryOcr(session: OcrSession, files: string[], sender: WebContents): Promise<void> {
    try {
      const pages: ChatMessage[][] = []
      for (let index = 0; index < files.length; index += 1) {
        if (session.cancelled) {
          this.emit(sender, { task: 'ocr', stage: 'stopped', message: '已取消' })
          return
        }
        const messages = await this.recognizeImage(session, files[index], index)
        pages.push(messages)
        this.emit(sender, {
          task: 'ocr',
          stage: 'running',
          message: `已识别 ${index + 1}/${files.length} 张`,
          current: index + 1,
          total: files.length
        })
      }
      const transcript = assembleTranscript(pages, basename(session.sourcePath))
      const transcriptPath = `${session.sourcePath.replace(/[\\/]+$/, '')}_聊天文稿.md`
      await writeFile(transcriptPath, transcript, 'utf8')
      const messageCount = pages.reduce((sum, page) => sum + page.length, 0)
      this.emit(sender, {
        task: 'ocr',
        stage: 'complete',
        message: `文稿已生成，共 ${messageCount} 条消息`,
        resultPath: transcriptPath
      })
    } catch (error) {
      if (session.cancelled) {
        this.emit(sender, { task: 'ocr', stage: 'stopped', message: '已取消' })
      } else {
        this.emit(sender, { task: 'ocr', stage: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    } finally {
      await this.disposeSession(session)
    }
  }

  /** 处理一页：版面分割 → OCR → 词框过滤 → 页内消息。 */
  async ocrPage(sessionId: string, pageIndex: number, png: Uint8Array, sender: WebContents): Promise<WechatOcrPageResult> {
    const session = this.ocrSessions.get(sessionId)
    if (!session || session.cancelled) throw new Error('OCR 会话不存在或已取消')
    const messages = await this.recognizeImage(session, Buffer.from(png), pageIndex)
    session.pages.set(pageIndex, messages)
    this.emit(sender, {
      task: 'ocr',
      stage: 'running',
      message: `已识别第 ${pageIndex + 1} 页，${messages.length} 条消息`,
      current: pageIndex + 1
    })
    return { pageIndex, messageCount: messages.length }
  }

  /** 识别单张图像：小图先放大（提升中文识别率），阈值随放大倍数同步缩放。 */
  private async recognizeImage(session: OcrSession, source: Buffer | string, pageIndex: number): Promise<ChatMessage[]> {
    let image = sharp(source)
    const metadata = await image.metadata()
    if (!metadata.width || !metadata.height) throw new Error('无法读取页面图像')
    let factor = metadata.width < OCR_TARGET_WIDTH ? Math.min(2, OCR_TARGET_WIDTH / metadata.width) : 1
    factor = Math.min(factor, OCR_MAX_DIMENSION / metadata.width, OCR_MAX_DIMENSION / metadata.height)
    if (Math.abs(factor - 1) > 0.01) image = image.resize({ width: Math.round(metadata.width * factor) })
    const pagePath = join(session.tempDir, `page_${String(pageIndex).padStart(4, '0')}.png`)
    await image.png().toFile(pagePath)
    const { data, info } = await sharp(pagePath).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const effectiveFactor = info.width / metadata.width
    const regions = segmentChatPage(data, info.width, info.height, {
      avatarMaxSize: Math.round(52 * effectiveFactor),
      mediaMinSize: Math.round(56 * effectiveFactor)
    })
    const words = await this.recognizeWords(session, pagePath, info.width, info.height)
    return buildPageMessages(regions, words, info.width)
  }

  /** 按会话选择的引擎识别词框：本地 Windows OCR 或 DeepSeek-OCR API。 */
  private async recognizeWords(session: OcrSession, pagePath: string, width: number, height: number): Promise<OcrWord[]> {
    if (session.engine === 'deepseek') {
      if (!session.deepseekClient) throw new Error('DeepSeek-OCR 客户端未初始化')
      const jpeg = await sharp(pagePath).flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer()
      return session.deepseekClient.recognize(jpeg, width, height)
    }
    if (!session.controller) throw new Error('本地 OCR 进程未启动')
    return session.controller.recognize(pagePath)
  }

  /** 汇总所有页并写出文稿。 */
  async ocrFinish(sessionId: string, sender: WebContents): Promise<WechatOcrFinishResult> {
    const session = this.ocrSessions.get(sessionId)
    if (!session) throw new Error('OCR 会话不存在')
    try {
      const orderedPages = [...session.pages.entries()].sort((first, second) => first[0] - second[0]).map((entry) => entry[1])
      const transcript = assembleTranscript(orderedPages, basename(session.sourcePath))
      const transcriptPath = `${session.sourcePath.replace(/\.pdf$/i, '')}_聊天文稿.md`
      await writeFile(transcriptPath, transcript, 'utf8')
      const messageCount = orderedPages.reduce((sum, page) => sum + page.length, 0)
      this.emit(sender, {
        task: 'ocr',
        stage: 'complete',
        message: `文稿已生成：${basename(transcriptPath)}`,
        resultPath: transcriptPath
      })
      return { transcriptPath, messageCount }
    } finally {
      await this.disposeSession(session)
    }
  }

  async ocrCancel(sessionId: string): Promise<void> {
    const session = this.ocrSessions.get(sessionId)
    if (!session) return
    session.cancelled = true
    await this.disposeSession(session)
  }

  dispose(): void {
    for (const session of this.ocrSessions.values()) void this.disposeSession(session)
  }

  /** 创建 OCR 会话；期间阻止系统休眠，PDF 模式还会关闭渲染进程后台节流，避免最小化后停摆。 */
  private async createSession(
    sourcePath: string,
    sender: WebContents,
    disableThrottling: boolean,
    engine: WechatOcrEngine = 'windows',
    deepseekConfig?: WechatOcrBeginRequest['deepseek']
  ): Promise<OcrSession> {
    const resolvedEngine: WechatOcrEngine = engine === 'deepseek' ? 'deepseek' : 'windows'
    const deepseekClient = resolvedEngine === 'deepseek' ? new DeepseekOcrClient(validateDeepseekConfig(deepseekConfig)) : null
    const tempDir = await mkdtemp(join(tmpdir(), 'wechat-ocr-'))
    const session: OcrSession = {
      id: crypto.randomUUID(),
      sourcePath,
      tempDir,
      engine: resolvedEngine,
      controller: resolvedEngine === 'windows' ? WechatOcrController.start() : null,
      deepseekClient,
      pages: new Map(),
      cancelled: false,
      sender,
      throttlingDisabled: false,
      blockerId: powerSaveBlocker.start('prevent-app-suspension')
    }
    if (disableThrottling && !sender.isDestroyed()) {
      sender.setBackgroundThrottling(false)
      session.throttlingDisabled = true
    }
    this.ocrSessions.set(session.id, session)
    return session
  }

  private async disposeSession(session: OcrSession): Promise<void> {
    this.ocrSessions.delete(session.id)
    if (session.blockerId !== null && powerSaveBlocker.isStarted(session.blockerId)) powerSaveBlocker.stop(session.blockerId)
    session.blockerId = null
    if (session.throttlingDisabled && session.sender && !session.sender.isDestroyed()) {
      session.sender.setBackgroundThrottling(true)
      session.throttlingDisabled = false
    }
    if (session.controller) await session.controller.stop()
    await rm(session.tempDir, { recursive: true, force: true }).catch(() => undefined)
  }

  private emit(sender: WebContents, event: WechatExportEvent): void {
    if (!sender.isDestroyed()) sender.send('wechat-export:event', event)
  }
}

function validatePdfRequest(request: WechatMarkdownToPdfRequest): void {
  if (typeof request.markdownPath !== 'string' || !/\.md$/i.test(request.markdownPath)) throw new Error('请选择 Markdown 文件')
  if (!Number.isInteger(request.imageWidth) || request.imageWidth < 320 || request.imageWidth > 2400) throw new Error('图片宽度必须在 320 到 2400 之间')
  if (!Number.isInteger(request.jpegQuality) || request.jpegQuality < 30 || request.jpegQuality > 100) throw new Error('JPEG 质量必须在 30 到 100 之间')
}

function validateSlimRequest(request: WechatSlimImagesRequest): void {
  if (typeof request.inputDirectory !== 'string' || !request.inputDirectory.trim()) throw new Error('请选择图片目录')
  if (request.format !== 'webp' && request.format !== 'jpeg') throw new Error('输出格式无效')
  if (!Number.isInteger(request.maxWidth) || request.maxWidth < 320 || request.maxWidth > 4000) throw new Error('最大宽度必须在 320 到 4000 之间')
  if (!Number.isInteger(request.quality) || request.quality < 30 || request.quality > 100) throw new Error('压缩质量必须在 30 到 100 之间')
}

function validateStitchRequest(request: WechatStitchImagesRequest): void {
  if (typeof request.inputDirectory !== 'string' || !request.inputDirectory.trim()) throw new Error('请选择图片目录')
  if (!Number.isInteger(request.maxHeight) || request.maxHeight < 2000 || request.maxHeight > 200000) throw new Error('长度上限必须在 2000 到 200000 之间')
}

function buildPdfHtml(body: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<style>
  body { margin: 0; font-family: "Microsoft YaHei", sans-serif; color: #222; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  h2 { font-size: 15px; margin: 18px 0 8px; }
  p { font-size: 12px; margin: 2px 0; }
  p.meta { color: #555; }
  img { display: block; width: 100%; margin: 6px 0; break-inside: avoid; }
</style>
</head>
<body>
${body}
</body>
</html>`
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.round(bytes / 1024)} KB`
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
