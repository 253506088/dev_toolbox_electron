import { describe, expect, it } from 'vitest'
import { findVoiceCandidates, hasNewTranscript, mergeVoiceTextLines, parseVoiceDuration, voiceMenuAction, type VoiceText } from '../src/shared/wechat-voice'

const word = (text: string, x = 100, y = 100, width = 40, height = 20): VoiceText => ({ text, x, y, width, height })
const crop = { x: 0, y: 0, width: 800, height: 600 }

describe('微信语音识别和菜单保护', () => {
  it('识别不同引号与可访问性秒数，只接受微信的1–60秒范围', () => {
    for (const value of ['3"', '3″', '3”', '3〃', "3''", ' 3 ″ ']) expect(parseVoiceDuration(value)).toBe(3)
    expect(parseVoiceDuration('[语音]3秒', true)).toBe(3)
    expect(parseVoiceDuration('语音：60秒，未读', true)).toBe(60)
    for (const value of ['0"', '61"', '300"', '2026-11-13', '3秒', '这是3"的照片', '3:00']) expect(parseVoiceDuration(value)).toBeNull()
  })

  it('菜单只接受完整的转写或已展开标签，拒绝包含关键词的其他操作', () => {
    for (const value of ['语音转文字', '语音 转 文字', '转文本', '转文字', 'Convert to Text']) expect(voiceMenuAction(value)).toBe('transcribe')
    expect(voiceMenuAction('收起文字')).toBe('expanded')
    for (const value of ['删除', '收藏', '引用', '删除语音转文字', '如何语音转文字', '语音转文字失败']) expect(voiceMenuAction(value)).toBeNull()
  })

  it('拼接OCR拆开的时长和中文菜单字词', () => {
    expect(mergeVoiceTextLines([word('3', 100, 100, 15), word('″', 119, 101, 8)])[0].text).toBe('3″')
    const menu = mergeVoiceTextLines([word('语音', 100, 200), word('转', 145, 200, 20), word('文字', 170, 200)])[0]
    expect(voiceMenuAction(menu.text)).toBe('transcribe')
    expect(findVoiceCandidates([], [word('•))', 60, 90, 25, 30), word('3', 100, 100, 15, 25), word('"', 120, 100, 8, 10)], crop)).toHaveLength(1)
  })

  it('合并UIA与OCR同一气泡，保留相同时长的不同气泡', () => {
    const elements = [{ ...word('[语音]3秒', 90, 90, 90, 40), id: 'voice-1' }]
    const words = [word('3″', 100, 100), word('3″', 100, 250), word('3″', 650, 400)]
    const found = findVoiceCandidates(elements, words, crop)
    expect(found).toHaveLength(3)
    expect(found.filter((item) => item.source === 'accessibility')).toHaveLength(1)
    expect(found.every((item) => item.seconds === 3)).toBe(true)
  })

  it('拒绝裁切边缘不完整消息、整列表容器和无效坐标', () => {
    const found = findVoiceCandidates([], [word('3″', -10), word('3″', 780), word('3″', 100, 590), word('3″', NaN), word('3″', 100, 100, 690)], crop)
    expect(found).toEqual([])
  })

  it('高DPI整气泡UIA矩形包含OCR时长时只保留一条', () => {
    const element = { ...word('[语音]3秒', 100, 100, 360, 80), id: 'large-voice' }
    expect(findVoiceCandidates([element], [word('3″', 260, 120, 40, 40)], crop)).toHaveLength(1)
    expect(findVoiceCandidates([], [word('3″', 100), word('3″', 600)], crop)).toHaveLength(2)
  })

  it('支持负坐标副屏，不把绝对坐标误当图片局部坐标', () => {
    expect(findVoiceCandidates([], [word('3″', -1700, 120)], { x: -1920, y: 0, width: 1920, height: 1080 })).toHaveLength(1)
  })

  it('聊天文字仅因展开位移时不能被判为转写成功', () => {
    const before = [word('3″'), word('原来的聊天', 100, 150, 160)]
    const shifted = before.map((item) => ({ ...item, y: item.y + 80 }))
    expect(hasNewTranscript(before, shifted)).toBe(false)
    expect(hasNewTranscript(before, [...shifted, word('新的转写结果', 100, 130, 160)])).toBe(true)
  })

  it('支持重复文本的新增实例，排除进度提示与失败文本', () => {
    const before = [word('你好')]
    expect(hasNewTranscript(before, [word('你好', 100, 130), word('你好', 100, 180)])).toBe(true)
    for (const text of ['正在转文字', '转换中', '转换失败', '请稍后重试', '3″', '语音转文字', '12:30']) {
      expect(hasNewTranscript([], [word(text)])).toBe(false)
    }
    for (const text of ['我正在开会，不能过去', '刚才转换失败了', '我无法打开文件', '我们12:30出发', '123456']) {
      expect(hasNewTranscript([], [word(text)])).toBe(true)
    }
  })
})
