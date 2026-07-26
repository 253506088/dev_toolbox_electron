import { describe, expect, it } from 'vitest'
import { looksLikePlainTranscription, parseDeepseekOcrWords } from '../src/shared/deepseek-ocr'

describe('DeepSeek-OCR grounding 输出解析', () => {
  it('解析 ref/det 对并换算到页面像素坐标', () => {
    const content =
      '<|ref|>明天上午十点开会<|/ref|><|det|>[[100, 50, 500, 90]]<|/det|>\n' +
      '<|ref|>收到，准时参加<|/ref|><|det|>[[400, 200, 800, 240]]<|/det|>'
    const words = parseDeepseekOcrWords(content, 2000, 1000)
    expect(words).toEqual([
      { x: 200, y: 50, width: 800, height: 40, text: '明天上午十点开会' },
      { x: 800, y: 200, width: 800, height: 40, text: '收到，准时参加' }
    ])
  })

  it('一个 ref 多个框时只取第一个框', () => {
    const content = '<|ref|>跨行文本<|/ref|><|det|>[[0, 0, 100, 40], [0, 50, 100, 90]]<|/det|>'
    const words = parseDeepseekOcrWords(content, 1000, 1000)
    expect(words).toHaveLength(1)
    expect(words[0]).toMatchObject({ x: 0, y: 0, text: '跨行文本' })
  })

  it('忽略坐标非法或空文本的片段', () => {
    const content =
      '<|ref|><|/ref|><|det|>[[0, 0, 100, 40]]<|/det|>' +
      '<|ref|>倒置框<|/ref|><|det|>[[500, 400, 100, 40]]<|/det|>' +
      '<|ref|>正常<|/ref|><|det|>[[10, 10, 200, 50]]<|/det|>'
    const words = parseDeepseekOcrWords(content, 1000, 1000)
    expect(words).toHaveLength(1)
    expect(words[0].text).toBe('正常')
  })

  it('空内容或非法尺寸返回空数组', () => {
    expect(parseDeepseekOcrWords('', 1000, 1000)).toEqual([])
    expect(parseDeepseekOcrWords('<|ref|>x<|/ref|><|det|>[[0,0,10,10]]<|/det|>', 0, 100)).toEqual([])
  })

  it('识别不带坐标的纯文本回复，提示配置问题', () => {
    expect(looksLikePlainTranscription('这是一段很长很长的纯文本转写结果，没有任何坐标信息，说明模型没有开启 grounding 模式输出。')).toBe(true)
    expect(looksLikePlainTranscription('<|ref|>a<|/ref|><|det|>[[0,0,1,1]]<|/det|>')).toBe(false)
    expect(looksLikePlainTranscription('  ')).toBe(false)
  })
})
