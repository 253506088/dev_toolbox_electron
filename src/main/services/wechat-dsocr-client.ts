import { DEEPSEEK_OCR_PROMPT, looksLikePlainTranscription, parseDeepseekOcrWords } from '../../shared/deepseek-ocr'
import type { WechatDeepseekOcrConfig } from '../../shared/wechat-export'
import type { OcrWord } from '../../shared/wechat-transcript'

const REQUEST_TIMEOUT_MS = 300_000
const MAX_ATTEMPTS = 3

/**
 * DeepSeek-OCR 客户端：走 OpenAI 兼容的 chat/completions 接口（硅基流动、自建 vLLM 等均可），
 * 用 grounding 提示词拿到带坐标的识别结果，转换成与本地 OCR 相同的 OcrWord 结构。
 */
export class DeepseekOcrClient {
  constructor(private readonly config: WechatDeepseekOcrConfig) {}

  async recognize(imageJpeg: Buffer, pageWidth: number, pageHeight: number): Promise<OcrWord[]> {
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`
    let lastError: Error | null = null
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.requestOnce(url, imageJpeg, pageWidth, pageHeight)
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        if (/HTTP 40[13]/.test(lastError.message) || attempt === MAX_ATTEMPTS - 1) throw lastError
        await delay(1500 * (attempt + 1))
      }
    }
    throw lastError ?? new Error('DeepSeek-OCR 请求失败')
  }

  private async requestOnce(url: string, imageJpeg: Buffer, pageWidth: number, pageHeight: number): Promise<OcrWord[]> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.config.model,
        temperature: 0,
        max_tokens: 4096,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageJpeg.toString('base64')}` } },
              { type: 'text', text: DEEPSEEK_OCR_PROMPT }
            ]
          }
        ]
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300)
      throw new Error(`DeepSeek-OCR 请求失败：HTTP ${response.status} ${detail}`.trim())
    }
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> }
    const content = payload.choices?.[0]?.message?.content
    if (typeof content !== 'string') throw new Error('DeepSeek-OCR 返回格式异常：没有文本内容')
    const words = parseDeepseekOcrWords(content, pageWidth, pageHeight)
    if (words.length === 0 && looksLikePlainTranscription(content)) {
      throw new Error('DeepSeek-OCR 返回了不带坐标的纯文本，请确认所选模型支持 grounding 输出（如 deepseek-ai/DeepSeek-OCR）')
    }
    return words
  }
}

/** 启动前校验配置，尽早给出可读的错误。API Key 可为空（本地 Ollama / vLLM 不需要）。 */
export function validateDeepseekConfig(config: WechatDeepseekOcrConfig | undefined): WechatDeepseekOcrConfig {
  if (!config) throw new Error('请填写 DeepSeek-OCR 接口配置')
  if (typeof config.baseUrl !== 'string' || !/^https?:\/\//i.test(config.baseUrl.trim())) throw new Error('DeepSeek-OCR 接口地址必须以 http(s):// 开头')
  if (typeof config.model !== 'string' || !config.model.trim()) throw new Error('请填写 DeepSeek-OCR 模型名称')
  const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : ''
  return { baseUrl: config.baseUrl.trim(), apiKey, model: config.model.trim() }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
