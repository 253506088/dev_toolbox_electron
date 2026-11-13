import { describe, expect, it } from 'vitest'
import { findVoiceBubbleRegions } from '../src/shared/wechat-voice-image'

type Color = [number, number, number]

function canvas(width: number, height: number, background: Color = [249, 249, 249]) {
  const data = new Uint8Array(width * height * 3)
  for (let i = 0; i < width * height; i += 1) data.set(background, i * 3)
  const rectangle = (x: number, y: number, w: number, h: number, color: Color): void => {
    for (let row = y; row < y + h; row += 1) {
      for (let col = x; col < x + w; col += 1) data.set(color, (row * width + col) * 3)
    }
  }
  return { data, rectangle }
}

describe('微信短气泡局部 OCR 定位', () => {
  it('找到独立时长气泡，排除正文长框、头像与整页背景', () => {
    const { data, rectangle } = canvas(741, 198)
    rectangle(130, 22, 186, 72, [238, 238, 240])
    rectangle(130, 103, 580, 72, [238, 238, 240])
    rectangle(30, 22, 72, 72, [80, 80, 80])
    rectangle(160, 47, 20, 24, [25, 25, 25])
    rectangle(200, 48, 12, 22, [25, 25, 25])
    const regions = findVoiceBubbleRegions(data, 741, 198)
    expect(regions).toEqual([{ x: 129, y: 21, width: 188, height: 74 }])
  })

  it('同时保留白色接收气泡和绿色发送气泡，最终语音身份交给 OCR 确认', () => {
    const { data, rectangle } = canvas(800, 700, [237, 237, 237])
    rectangle(80, 30, 180, 60, [255, 255, 255])
    rectangle(480, 180, 250, 60, [149, 236, 105])
    expect(findVoiceBubbleRegions(data, 800, 700)).toEqual([
      { x: 79, y: 29, width: 182, height: 62 },
      { x: 479, y: 179, width: 252, height: 62 }
    ])
  })

  it('高 DPI 采样后的框仍返回原图坐标', () => {
    const { data, rectangle } = canvas(2400, 1800)
    rectangle(400, 240, 600, 180, [238, 238, 240])
    rectangle(480, 290, 50, 70, [25, 25, 25])
    expect(findVoiceBubbleRegions(data, 2400, 1800)).toEqual([{ x: 398, y: 238, width: 604, height: 184 }])
  })

  it('能发现深色模式的平坦短气泡', () => {
    const { data, rectangle } = canvas(800, 600, [25, 25, 25])
    rectangle(80, 90, 190, 64, [56, 56, 56])
    expect(findVoiceBubbleRegions(data, 800, 600)).toEqual([{ x: 79, y: 89, width: 192, height: 66 }])
  })

  it('支持 RGBA，并忽略透明的装饰区域', () => {
    const { data, rectangle } = canvas(500, 300)
    rectangle(60, 40, 160, 60, [238, 238, 240])
    const rgba = new Uint8Array(500 * 300 * 4)
    for (let i = 0; i < 500 * 300; i += 1) {
      rgba.set(data.subarray(i * 3, i * 3 + 3), i * 4)
      rgba[i * 4 + 3] = 255
    }
    expect(findVoiceBubbleRegions(rgba, 500, 300, 4)).toEqual([{ x: 59, y: 39, width: 162, height: 62 }])
    for (let i = 0; i < 500 * 300; i += 1) rgba[i * 4 + 3] = 0
    expect(findVoiceBubbleRegions(rgba, 500, 300, 4)).toEqual([])
  })

  it('纹理占大部分的图片与不合法尺寸不会成为候选', () => {
    const { data, rectangle } = canvas(500, 300)
    rectangle(60, 40, 180, 60, [238, 238, 240])
    rectangle(65, 45, 170, 50, [60, 110, 190])
    expect(findVoiceBubbleRegions(data, 500, 300)).toEqual([])
    expect(findVoiceBubbleRegions(new Uint8Array(5), 20, 20)).toEqual([])
    expect(findVoiceBubbleRegions(new Uint8Array(), 0, 0)).toEqual([])
  })
})
