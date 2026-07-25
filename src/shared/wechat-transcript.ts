/**
 * 微信聊天截图的版面分割与文稿组装。
 * 思路：先按像素颜色把页面分成 背景 / 白色气泡 / 绿色气泡 / 其他内容，
 * 再用连通域找出气泡矩形并分类（文本气泡 / 链接卡片 / 图片媒体），
 * OCR 词框只保留落在文本气泡内的部分，从根上排除表情包、头像、缩略图里的文字。
 * 当前规则面向浅色模式微信；全部为纯函数，便于单元测试与后续调参。
 */

/** OCR 识别出的单词及其在页面图像中的包围盒。 */
export interface OcrWord {
  x: number
  y: number
  width: number
  height: number
  text: string
}

export type ChatRegionKind = 'bubble' | 'own-bubble' | 'card' | 'media'

/** 版面分割出的区域（页面像素坐标，右/下为开区间）。 */
export interface ChatRegion {
  left: number
  top: number
  right: number
  bottom: number
  kind: ChatRegionKind
}

export type ChatMessageKind = 'text' | 'own-text' | 'card' | 'media' | 'meta'

/** 组装文稿用的单条消息。 */
export interface ChatMessage {
  kind: ChatMessageKind
  speaker?: string
  text: string
  top: number
}

const CLASS_BACKGROUND = 0
const CLASS_WHITE = 1
const CLASS_GREEN = 2
const CLASS_CONTENT = 3

/** 头像及小图标的尺寸上限：宽高都不超过该值的内容块直接忽略。 */
const AVATAR_MAX_SIZE = 52
/** 判定为媒体（图片/表情包/视频封面）的内容块最小边长。 */
const MEDIA_MIN_SIZE = 56
/** 卡片判定：气泡内“非白非背景”像素占比超过该值视为链接卡片。 */
const CARD_CONTENT_RATIO = 0.22

/** 估计聊天背景色：对下采样像素做量化直方图取众数。 */
export function estimateBackgroundColor(
  rgb: ArrayLike<number>,
  width: number,
  height: number
): { r: number; g: number; b: number } {
  const counts = new Map<number, number>()
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 40_000)))
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const offset = (y * width + x) * 3
      const key = ((rgb[offset] >> 3) << 10) | ((rgb[offset + 1] >> 3) << 5) | (rgb[offset + 2] >> 3)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  let bestKey = 0
  let bestCount = -1
  for (const [key, count] of counts) {
    if (count > bestCount) {
      bestCount = count
      bestKey = key
    }
  }
  return {
    r: ((bestKey >> 10) & 31) << 3,
    g: ((bestKey >> 5) & 31) << 3,
    b: (bestKey & 31) << 3
  }
}

/** 把 RGB 页面分类成背景/白气泡/绿气泡/内容四类像素。 */
function classifyPixels(rgb: ArrayLike<number>, width: number, height: number): Uint8Array {
  const background = estimateBackgroundColor(rgb, width, height)
  const classes = new Uint8Array(width * height)
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 3
    const r = rgb[offset]
    const g = rgb[offset + 1]
    const b = rgb[offset + 2]
    if (Math.min(r, g, b) >= 250) {
      classes[index] = CLASS_WHITE
    } else if (g >= 120 && g - Math.max(r, b) >= 30) {
      classes[index] = CLASS_GREEN
    } else if (
      Math.abs(r - background.r) <= 10 &&
      Math.abs(g - background.g) <= 10 &&
      Math.abs(b - background.b) <= 10
    ) {
      classes[index] = CLASS_BACKGROUND
    } else {
      classes[index] = CLASS_CONTENT
    }
  }
  return classes
}

interface Component {
  left: number
  top: number
  right: number
  bottom: number
  area: number
}

/** 对指定类别做四连通域标记，返回各组件包围盒。 */
function findComponents(
  classes: Uint8Array,
  width: number,
  height: number,
  matches: (value: number) => boolean
): Component[] {
  const visited = new Uint8Array(classes.length)
  const components: Component[] = []
  const stack: number[] = []
  for (let start = 0; start < classes.length; start += 1) {
    if (visited[start] || !matches(classes[start])) continue
    let left = width
    let right = 0
    let top = height
    let bottom = 0
    let area = 0
    stack.push(start)
    visited[start] = 1
    while (stack.length > 0) {
      const index = stack.pop() as number
      const x = index % width
      const y = (index / width) | 0
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
      area += 1
      if (x > 0 && !visited[index - 1] && matches(classes[index - 1])) {
        visited[index - 1] = 1
        stack.push(index - 1)
      }
      if (x + 1 < width && !visited[index + 1] && matches(classes[index + 1])) {
        visited[index + 1] = 1
        stack.push(index + 1)
      }
      if (y > 0 && !visited[index - width] && matches(classes[index - width])) {
        visited[index - width] = 1
        stack.push(index - width)
      }
      if (y + 1 < height && !visited[index + width] && matches(classes[index + width])) {
        visited[index + width] = 1
        stack.push(index + width)
      }
    }
    components.push({ left, top, right: right + 1, bottom: bottom + 1, area })
  }
  return components
}

/** 统计包围盒内某类像素的占比。 */
function classRatioInBox(classes: Uint8Array, width: number, box: Component, target: number): number {
  let hit = 0
  let total = 0
  for (let y = box.top; y < box.bottom; y += 1) {
    for (let x = box.left; x < box.right; x += 1) {
      total += 1
      if (classes[y * width + x] === target) hit += 1
    }
  }
  return total === 0 ? 0 : hit / total
}

/** 分割选项：识别前放大过图像时，需按放大倍数同步放大这两个像素阈值。 */
export interface SegmentOptions {
  avatarMaxSize?: number
  mediaMinSize?: number
}

/** 分割一页聊天截图，返回文本气泡、卡片和媒体区域。 */
export function segmentChatPage(
  rgb: ArrayLike<number>,
  width: number,
  height: number,
  options?: SegmentOptions
): ChatRegion[] {
  if (width < 8 || height < 8 || rgb.length !== width * height * 3) return []
  const avatarMaxSize = options?.avatarMaxSize ?? AVATAR_MAX_SIZE
  const mediaMinSize = options?.mediaMinSize ?? MEDIA_MIN_SIZE
  const classes = classifyPixels(rgb, width, height)
  const minBubbleWidth = Math.max(40, Math.round(width * 0.03))
  const minBubbleHeight = 22
  const regions: ChatRegion[] = []

  for (const kindClass of [CLASS_WHITE, CLASS_GREEN]) {
    const components = findComponents(classes, width, height, (value) => value === kindClass)
    for (const component of components) {
      const boxWidth = component.right - component.left
      const boxHeight = component.bottom - component.top
      if (boxWidth < minBubbleWidth || boxHeight < minBubbleHeight) continue
      if (component.area / (boxWidth * boxHeight) < 0.25) continue
      let kind: ChatRegionKind = kindClass === CLASS_GREEN ? 'own-bubble' : 'bubble'
      if (kind === 'bubble' && classRatioInBox(classes, width, component, CLASS_CONTENT) > CARD_CONTENT_RATIO) {
        kind = 'card'
      }
      regions.push({ left: component.left, top: component.top, right: component.right, bottom: component.bottom, kind })
    }
  }

  // 气泡之外的大块内容视为媒体（图片/表情包/视频封面）；头像尺寸的小块直接忽略。
  const inBubble = (x: number, y: number): boolean =>
    regions.some((region) => x >= region.left && x < region.right && y >= region.top && y < region.bottom)
  const contentComponents = findComponents(classes, width, height, (value) => value === CLASS_CONTENT)
  for (const component of contentComponents) {
    const boxWidth = component.right - component.left
    const boxHeight = component.bottom - component.top
    if (boxWidth <= avatarMaxSize && boxHeight <= avatarMaxSize) continue
    if (boxWidth < mediaMinSize && boxHeight < mediaMinSize) continue
    const centerX = (component.left + component.right) / 2
    const centerY = (component.top + component.bottom) / 2
    if (inBubble(centerX, centerY)) continue
    regions.push({ left: component.left, top: component.top, right: component.right, bottom: component.bottom, kind: 'media' })
  }

  return regions.sort((first, second) => first.top - second.top || first.left - second.left)
}

/** 判断词框中心是否落在区域内。 */
function wordInRegion(word: OcrWord, region: ChatRegion): boolean {
  const centerX = word.x + word.width / 2
  const centerY = word.y + word.height / 2
  return centerX >= region.left && centerX < region.right && centerY >= region.top && centerY < region.bottom
}

/** 把同一区域的词按行分组并连接成文本；相邻 ASCII 词之间补空格。 */
function joinWords(words: OcrWord[]): string {
  if (words.length === 0) return ''
  const sorted = [...words].sort((first, second) => first.y - second.y || first.x - second.x)
  const lines: OcrWord[][] = []
  for (const word of sorted) {
    const line = lines[lines.length - 1]
    if (line && Math.abs(word.y - line[0].y) <= Math.max(8, line[0].height * 0.6)) line.push(word)
    else lines.push([word])
  }
  return lines
    .map((line) =>
      line
        .sort((first, second) => first.x - second.x)
        .reduce((text, word, index) => {
          if (index === 0) return word.text
          const previous = line[index - 1].text
          const needsSpace = /[\w)>%.,;:!?]$/.test(previous) && /^[\w(<]/.test(word.text)
          return `${text}${needsSpace ? ' ' : ''}${word.text}`
        }, '')
    )
    .join('\n')
    .trim()
}

/** 根据分割区域给 OCR 词框归属并生成本页消息序列。 */
export function buildPageMessages(regions: ChatRegion[], words: OcrWord[], pageWidth: number): ChatMessage[] {
  const regionWords = new Map<ChatRegion, OcrWord[]>()
  const looseWords: OcrWord[] = []
  for (const word of words) {
    const region = regions.find((candidate) => wordInRegion(word, candidate))
    if (!region) {
      looseWords.push(word)
      continue
    }
    if (region.kind === 'media') continue
    const bucket = regionWords.get(region)
    if (bucket) bucket.push(word)
    else regionWords.set(region, [word])
  }

  // 气泡外的散词按行分组：居中的是时间戳/系统消息，贴在气泡上方的是群昵称。
  const looseLines: OcrWord[][] = []
  for (const word of [...looseWords].sort((first, second) => first.y - second.y || first.x - second.x)) {
    const line = looseLines[looseLines.length - 1]
    if (line && Math.abs(word.y - line[0].y) <= Math.max(8, line[0].height * 0.6)) line.push(word)
    else looseLines.push([word])
  }
  const messages: ChatMessage[] = []
  const speakerByRegion = new Map<ChatRegion, string>()
  for (const line of looseLines) {
    const text = joinWords(line)
    if (!text) continue
    const left = Math.min(...line.map((word) => word.x))
    const right = Math.max(...line.map((word) => word.x + word.width))
    const lineTop = line[0].y
    const center = (left + right) / 2
    if (Math.abs(center - pageWidth / 2) <= pageWidth * 0.12) {
      messages.push({ kind: 'meta', text, top: lineTop })
      continue
    }
    const owner = regions.find(
      (region) =>
        (region.kind === 'bubble' || region.kind === 'card') &&
        region.top - (lineTop + line[0].height) >= -4 &&
        region.top - (lineTop + line[0].height) <= 30 &&
        left >= region.left - 60 &&
        left <= region.right
    )
    if (owner && !speakerByRegion.has(owner)) speakerByRegion.set(owner, text)
  }

  for (const region of regions) {
    if (region.kind === 'media') {
      const side = (region.left + region.right) / 2 > pageWidth * 0.55 ? '我' : undefined
      messages.push({ kind: 'media', speaker: side, text: '[图片]', top: region.top })
      continue
    }
    const text = joinWords(regionWords.get(region) ?? [])
    if (!text) continue
    if (region.kind === 'own-bubble') {
      messages.push({ kind: 'own-text', speaker: '我', text, top: region.top })
    } else if (region.kind === 'card') {
      const title = text.split('\n')[0]
      messages.push({ kind: 'card', speaker: speakerByRegion.get(region), text: `[链接卡片] ${title}`, top: region.top })
    } else {
      messages.push({ kind: 'text', speaker: speakerByRegion.get(region), text, top: region.top })
    }
  }
  return messages.sort((first, second) => first.top - second.top)
}

/** 拼接多页消息成 Markdown 文稿；跨页重叠带里的重复消息按窗口去重。 */
export function assembleTranscript(pages: ChatMessage[][], sourceLabel: string): string {
  const lines: string[] = [
    '# 微信聊天文稿',
    '',
    `> 来源：${sourceLabel}`,
    '> 由本地版面分析 + OCR 生成；[图片]、[链接卡片] 为占位符，表情包与头像内文字已剔除。',
    ''
  ]
  const recent: string[] = []
  for (const page of pages) {
    for (const message of page) {
      const rendered = renderMessage(message)
      if (message.kind !== 'media' && message.text.length >= 4 && recent.includes(rendered)) continue
      lines.push(rendered)
      recent.push(rendered)
      if (recent.length > 6) recent.shift()
    }
  }
  return `${lines.join('\n').trimEnd()}\n`
}

function renderMessage(message: ChatMessage): string {
  if (message.kind === 'meta') return `\n—— ${message.text} ——`
  const speaker = message.speaker ?? '对方'
  return `${speaker}：${message.text}`
}
