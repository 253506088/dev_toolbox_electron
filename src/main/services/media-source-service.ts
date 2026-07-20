import { randomUUID } from 'node:crypto'
import { extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { access } from 'node:fs/promises'
import { net, protocol } from 'electron'
import { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from '../../shared/media-api'

const MEDIA_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS].map((extension) => `.${extension}`))

/** 为用户明确选择的媒体文件生成受控预览地址。 */
export class MediaSourceService {
  private readonly sources = new Map<string, string>()

  /** 注册自定义协议处理器。 */
  registerProtocol(): void {
    protocol.handle('media-file', async (request) => {
      const token = new URL(request.url).pathname.replace(/^\//, '')
      const filePath = this.sources.get(token)
      if (!filePath) return new Response('媒体地址已失效', { status: 404 })
      return net.fetch(pathToFileURL(filePath).toString())
    })
  }

  /** 校验并登记一个媒体路径，返回页面可访问的临时地址。 */
  async register(filePath: string): Promise<string> {
    if (!MEDIA_EXTENSIONS.has(extname(filePath).toLowerCase())) throw new Error('不支持的媒体格式')
    await access(filePath)
    const token = randomUUID()
    this.sources.set(token, filePath)
    return `media-file://local/${token}`
  }

  /** 清空当前会话登记的媒体路径。 */
  clear(): void {
    this.sources.clear()
  }
}
