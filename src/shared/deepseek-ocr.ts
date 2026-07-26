import type { OcrWord } from './wechat-transcript'

/** DeepSeek-OCR grounding 模式的默认提示词。 */
export const DEEPSEEK_OCR_PROMPT = '<|grounding|>OCR this image.'

/**
 * 解析 DeepSeek-OCR grounding 输出：
 * `<|ref|>文本<|/ref|><|det|>[[x1, y1, x2, y2], ...]<|/det|>`，
 * 坐标为 0~1000 归一化值，按页面像素尺寸换算成 OcrWord。
 * 一个 ref 带多个框时（折行），文本挂在第一个框上，后续框忽略。
 */
export function parseDeepseekOcrWords(content: string, pageWidth: number, pageHeight: number): OcrWord[] {
  const words: OcrWord[] = []
  if (!content || pageWidth < 1 || pageHeight < 1) return words
  const pattern = /<\|ref\|>([\s\S]*?)<\|\/ref\|>\s*<\|det\|>\s*(\[[\d,\s[\]]*?\])\s*<\|\/det\|>/g
  for (const match of content.matchAll(pattern)) {
    const text = match[1].trim()
    if (!text) continue
    let boxes: unknown
    try {
      boxes = JSON.parse(match[2])
    } catch {
      continue
    }
    if (!Array.isArray(boxes)) continue
    const first = boxes[0]
    if (!Array.isArray(first) || first.length < 4) continue
    const [x1, y1, x2, y2] = first as number[]
    if (![x1, y1, x2, y2].every((value) => Number.isFinite(value)) || x2 <= x1 || y2 <= y1) continue
    words.push({
      x: Math.round((x1 / 1000) * pageWidth),
      y: Math.round((y1 / 1000) * pageHeight),
      width: Math.max(1, Math.round(((x2 - x1) / 1000) * pageWidth)),
      height: Math.max(1, Math.round(((y2 - y1) / 1000) * pageHeight)),
      text
    })
  }
  return words
}

/** 判断返回内容像不像“没开 grounding 的普通转写”，用于给出可操作的报错。 */
export function looksLikePlainTranscription(content: string): boolean {
  return content.trim().length > 40 && !content.includes('<|ref|>')
}
