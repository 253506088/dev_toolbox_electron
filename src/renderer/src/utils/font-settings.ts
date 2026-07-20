/** 全局界面字号的默认值和边界。 */
export const DEFAULT_UI_FONT_SIZE = 14
export const MIN_UI_FONT_SIZE = 12
export const MAX_UI_FONT_SIZE = 20

/** 文本编辑器字号的默认值和边界。 */
export const DEFAULT_EDITOR_FONT_SIZE = 13
export const MIN_EDITOR_FONT_SIZE = 10
export const MAX_EDITOR_FONT_SIZE = 32

/** 可持久化的字号设置。 */
export interface FontSettings {
  uiFontSize: number
  editorFontSize: number
}

/** 把输入值限制为指定范围内的整数，异常值回退到默认值。 */
export function clampFontSize(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** 解析本地 JSON 设置，损坏或缺失字段时分别回退。 */
export function parseFontSettings(raw: string | null): FontSettings {
  if (!raw) return getDefaultFontSettings()
  try {
    const parsed = JSON.parse(raw) as { uiFontSize?: unknown; editorFontSize?: unknown }
    return {
      uiFontSize: clampFontSize(parsed.uiFontSize, MIN_UI_FONT_SIZE, MAX_UI_FONT_SIZE, DEFAULT_UI_FONT_SIZE),
      editorFontSize: clampFontSize(
        parsed.editorFontSize,
        MIN_EDITOR_FONT_SIZE,
        MAX_EDITOR_FONT_SIZE,
        DEFAULT_EDITOR_FONT_SIZE
      )
    }
  } catch {
    return getDefaultFontSettings()
  }
}

/** 创建默认字号设置，避免多个调用方共享可变对象。 */
export function getDefaultFontSettings(): FontSettings {
  return { uiFontSize: DEFAULT_UI_FONT_SIZE, editorFontSize: DEFAULT_EDITOR_FONT_SIZE }
}
