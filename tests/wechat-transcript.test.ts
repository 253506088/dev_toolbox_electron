import { describe, expect, it } from 'vitest'
import {
  assembleTranscript,
  buildPageMessages,
  estimateBackgroundColor,
  segmentChatPage,
  type ChatMessage,
  type OcrWord
} from '../src/shared/wechat-transcript'

const WIDTH = 400
const HEIGHT = 300

/** 造一页纯背景画布。 */
function createPage(): Uint8Array {
  const rgb = new Uint8Array(WIDTH * HEIGHT * 3)
  fillRect(rgb, 0, 0, WIDTH, HEIGHT, [237, 237, 237])
  return rgb
}

function fillRect(rgb: Uint8Array, left: number, top: number, right: number, bottom: number, color: [number, number, number]): void {
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * WIDTH + x) * 3
      rgb[offset] = color[0]
      rgb[offset + 1] = color[1]
      rgb[offset + 2] = color[2]
    }
  }
}

function word(x: number, y: number, text: string, width = 24, height = 24): OcrWord {
  return { x, y, width, height, text }
}

describe('微信聊天版面分割', () => {
  it('估计背景色接近真实底色', () => {
    const background = estimateBackgroundColor(createPage(), WIDTH, HEIGHT)
    expect(Math.abs(background.r - 237)).toBeLessThanOrEqual(8)
    expect(Math.abs(background.g - 237)).toBeLessThanOrEqual(8)
  })

  it('识别白色气泡、绿色气泡和媒体块，忽略头像', () => {
    const rgb = createPage()
    fillRect(rgb, 60, 30, 300, 90, [255, 255, 255])
    fillRect(rgb, 90, 50, 200, 66, [30, 30, 30]) // 气泡内文字墨迹
    fillRect(rgb, 200, 120, 380, 170, [149, 236, 105])
    fillRect(rgb, 10, 30, 50, 70, [80, 80, 80]) // 头像 40×40
    fillRect(rgb, 60, 190, 180, 280, [50, 80, 200]) // 图片消息

    const regions = segmentChatPage(rgb, WIDTH, HEIGHT)
    const kinds = regions.map((region) => region.kind)
    expect(kinds).toContain('bubble')
    expect(kinds).toContain('own-bubble')
    expect(kinds).toContain('media')
    expect(regions).toHaveLength(3)
    const bubble = regions.find((region) => region.kind === 'bubble')
    expect(bubble).toMatchObject({ left: 60, top: 30, right: 300, bottom: 90 })
  })

  it('内部含大面积缩略图的白色区域识别为链接卡片', () => {
    const rgb = createPage()
    fillRect(rgb, 60, 30, 300, 140, [255, 255, 255])
    fillRect(rgb, 70, 60, 290, 130, [50, 80, 200]) // 卡片缩略图
    const regions = segmentChatPage(rgb, WIDTH, HEIGHT)
    expect(regions.map((region) => region.kind)).toContain('card')
  })

  it('尺寸或数据不合法时返回空', () => {
    expect(segmentChatPage(new Uint8Array(10), 4, 4)).toEqual([])
  })
})

describe('OCR 词框归属与文稿组装', () => {
  it('只保留文本气泡内的词，气泡外识别昵称与时间戳', () => {
    const rgb = createPage()
    fillRect(rgb, 60, 30, 300, 90, [255, 255, 255])
    fillRect(rgb, 200, 120, 380, 170, [149, 236, 105])
    fillRect(rgb, 60, 190, 180, 280, [50, 80, 200])
    const regions = segmentChatPage(rgb, WIDTH, HEIGHT)

    const words: OcrWord[] = [
      word(100, 50, '你'),
      word(126, 50, '好'),
      word(60, 8, '张三', 40, 16), // 气泡上方昵称
      word(170, 210, '10:24', 60, 14), // 居中时间戳
      word(240, 135, '收'),
      word(266, 135, '到'),
      word(100, 220, '表情包文字') // 落在媒体块上，应被剔除
    ]
    const messages = buildPageMessages(regions, words, WIDTH)
    expect(messages).toEqual([
      { kind: 'text', speaker: '张三', text: '你好', top: 30 },
      { kind: 'own-text', speaker: '我', text: '收到', top: 120 },
      { kind: 'media', speaker: undefined, text: '[图片]', top: 190 },
      { kind: 'meta', text: '10:24', top: 210 }
    ])
  })

  it('拼接文稿并去掉跨页重叠带来的重复消息', () => {
    const pageOne: ChatMessage[] = [
      { kind: 'meta', text: '昨天 10:00', top: 0 },
      { kind: 'text', speaker: '张三', text: '明天上午十点开会', top: 40 }
    ]
    const pageTwo: ChatMessage[] = [
      { kind: 'text', speaker: '张三', text: '明天上午十点开会', top: 4 },
      { kind: 'own-text', speaker: '我', text: '收到，准时参加', top: 60 }
    ]
    const transcript = assembleTranscript([pageOne, pageTwo], 'demo.pdf')
    expect(transcript).toContain('—— 昨天 10:00 ——')
    expect(transcript.match(/明天上午十点开会/g)).toHaveLength(1)
    expect(transcript).toContain('我：收到，准时参加')
  })
})
