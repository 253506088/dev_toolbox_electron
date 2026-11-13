/** Voice recognition uses exact labels; a suspected duration alone never authorizes a left click. */
export interface VoiceRect { x: number; y: number; width: number; height: number }
export interface VoiceText extends VoiceRect { text: string; id?: string }
export interface VoiceCandidate extends VoiceText { seconds: number; source: 'accessibility' | 'ocr' }

export const VOICE_TRANSCRIBE_LABELS = ['语音转文字', '转文字', '转文本', '语音转文本', 'Convert to Text', 'Transcribe'] as const
export const VOICE_COLLAPSE_LABELS = ['收起文字', '收起文本', '隐藏文字', 'Hide Text', 'Collapse Text'] as const

export function normalizeVoiceLabel(text: string): string {
  return text.replace(/[\s\u200b-\u200d\ufeff]/g, '').replace(/\(&[A-Z]\)$|（[A-Z]）$/i, '').toLowerCase()
}

export function voiceMenuAction(text: string): 'transcribe' | 'expanded' | null {
  const label = normalizeVoiceLabel(text)
  if (VOICE_TRANSCRIBE_LABELS.some((item) => normalizeVoiceLabel(item) === label)) return 'transcribe'
  if (VOICE_COLLAPSE_LABELS.some((item) => normalizeVoiceLabel(item) === label)) return 'expanded'
  return null
}

export function parseVoiceDuration(text: string, accessibility = false): number | null {
  const cleaned = text.trim().replace(/[\s\u200b]/g, '')
  const match = accessibility
    ? /^(?:\[?语音\]?[:：]?)?([1-9]\d?)(?:秒|["“”″〃′']{1,2})(?:[,，]?未读)?$/.exec(cleaned)
    : /^([1-9]\d?)["“”″〃′']{1,2}$/.exec(cleaned)
  if (!match) return null
  const seconds = Number(match[1])
  return seconds <= 60 ? seconds : null
}

/** OCR may split a Chinese menu label or the duration and quotation mark into several words. */
export function mergeVoiceTextLines(words: VoiceText[]): VoiceText[] {
  const lines: VoiceText[][] = []
  for (const word of [...words].filter(validRect).sort((a, b) => a.y - b.y || a.x - b.x)) {
    const middle = word.y + word.height / 2
    const line = lines.find((items) => Math.abs(items[0].y + items[0].height / 2 - middle) <= Math.max(items[0].height, word.height) * 0.55)
    if (line) line.push(word)
    else lines.push([word])
  }
  return lines.map((items) => {
    items.sort((a, b) => a.x - b.x)
    const x = Math.min(...items.map((item) => item.x))
    const y = Math.min(...items.map((item) => item.y))
    return { x, y, width: Math.max(...items.map((item) => item.x + item.width)) - x,
      height: Math.max(...items.map((item) => item.y + item.height)) - y, text: items.map((item) => item.text).join('') }
  })
}

export function findVoiceCandidates(elements: VoiceText[], words: VoiceText[], crop: VoiceRect): VoiceCandidate[] {
  const result: VoiceCandidate[] = []
  const add = (item: VoiceText, source: VoiceCandidate['source']): void => {
    const seconds = parseVoiceDuration(item.text, source === 'accessibility')
    if (seconds === null || !validRect(item) || !inside(item, crop)) return
    if (item.height > crop.height * 0.3 || item.width > crop.width * 0.8) return
    const overlapping = result.some((other) => {
      const vertical = Math.min(other.y + other.height, item.y + item.height) - Math.max(other.y, item.y)
      const horizontal = Math.min(other.x + other.width, item.x + item.width) - Math.max(other.x, item.x)
      return vertical >= Math.min(other.height, item.height) * 0.4 && horizontal > 0
    })
    if (!overlapping) result.push({ ...item, seconds, source })
  }
  elements.forEach((item) => add(item, 'accessibility'))
  mergeVoiceTextLines(words).forEach((item) => add(item, 'ocr'))
  // A speaker icon can be OCR'd as punctuation on the same line. Pair only the number
  // and its adjacent superscript quotation mark, without absorbing the icon's text.
  for (const number of words.filter((item) => /^[1-9]\d?$/.test(item.text.trim()))) {
    const quote = words.find((item) => /^["“”″〃′']{1,2}$/.test(item.text.trim()) &&
      item.x >= number.x + number.width && item.x - number.x - number.width <= number.height * 0.9 &&
      item.y >= number.y - number.height * 0.3 && item.y <= number.y + number.height * 0.6)
    if (quote) add({ ...number, text: number.text.trim() + quote.text.trim(), width: quote.x + quote.width - number.x }, 'ocr')
  }
  // Some OCR lines contain a sender name beside a voice bubble. Retain standalone duration words too.
  words.forEach((item) => add(item, 'ocr'))
  return result.sort((a, b) => b.y - a.y || b.x - a.x)
}

export function hasNewTranscript(before: VoiceText[], after: VoiceText[]): boolean {
  const known = new Map<string, number>()
  for (const item of mergeVoiceTextLines(before)) {
    const key = normalizeVoiceLabel(item.text)
    known.set(key, (known.get(key) ?? 0) + 1)
  }
  return mergeVoiceTextLines(after).some((item) => {
    const text = item.text.trim()
    const key = normalizeVoiceLabel(text)
    const count = known.get(key) ?? 0
    if (count > 0) { known.set(key, count - 1); return false }
    return parseVoiceDuration(text, true) === null && voiceMenuAction(text) === null &&
      !isVoiceStatusText(text) && !/^[0-9]{1,2}[:：][0-9]{2}(?::[0-9]{2})?$/.test(text) && /[\p{L}\p{N}]/u.test(text)
  })
}

export function isVoiceStatusText(text: string): boolean {
  return /^(?:语音)?(?:正在(?:转文字|转换|识别|转写)|转换中|识别中|转写中|转换失败|转文字失败|识别失败|无法转换|暂时无法转换|请稍后重试|重试)[.。…\s]*$/.test(text.trim())
}

function validRect(item: VoiceRect): boolean {
  return [item.x, item.y, item.width, item.height].every(Number.isFinite) && item.width > 0 && item.height > 0
}

function inside(item: VoiceRect, crop: VoiceRect): boolean {
  return item.x >= crop.x + 2 && item.y >= crop.y + 2 && item.x + item.width <= crop.x + crop.width - 2 && item.y + item.height <= crop.y + crop.height - 2
}
