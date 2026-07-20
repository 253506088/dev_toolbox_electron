import { describe, expect, it } from 'vitest'
import {
  clampFontSize,
  DEFAULT_EDITOR_FONT_SIZE,
  DEFAULT_UI_FONT_SIZE,
  MAX_EDITOR_FONT_SIZE,
  MAX_UI_FONT_SIZE,
  MIN_EDITOR_FONT_SIZE,
  MIN_UI_FONT_SIZE,
  parseFontSettings
} from '../src/renderer/src/utils/font-settings'

describe('全局字号设置', () => {
  it('没有本地数据时使用默认值', () => {
    expect(parseFontSettings(null)).toEqual({
      uiFontSize: DEFAULT_UI_FONT_SIZE,
      editorFontSize: DEFAULT_EDITOR_FONT_SIZE
    })
  })

  it('读取合法的界面和编辑器字号', () => {
    expect(parseFontSettings('{"uiFontSize":18,"editorFontSize":20}')).toEqual({
      uiFontSize: 18,
      editorFontSize: 20
    })
  })

  it('损坏的 JSON 回退到默认值', () => {
    expect(parseFontSettings('{bad json')).toEqual({
      uiFontSize: DEFAULT_UI_FONT_SIZE,
      editorFontSize: DEFAULT_EDITOR_FONT_SIZE
    })
  })

  it('缺失字段分别回退', () => {
    expect(parseFontSettings('{"uiFontSize":16}')).toEqual({
      uiFontSize: 16,
      editorFontSize: DEFAULT_EDITOR_FONT_SIZE
    })
  })

  it('过大的字号限制为上限', () => {
    expect(clampFontSize(100, MIN_UI_FONT_SIZE, MAX_UI_FONT_SIZE, DEFAULT_UI_FONT_SIZE)).toBe(MAX_UI_FONT_SIZE)
    expect(clampFontSize(100, MIN_EDITOR_FONT_SIZE, MAX_EDITOR_FONT_SIZE, DEFAULT_EDITOR_FONT_SIZE)).toBe(MAX_EDITOR_FONT_SIZE)
  })

  it('过小的字号限制为下限', () => {
    expect(clampFontSize(1, MIN_UI_FONT_SIZE, MAX_UI_FONT_SIZE, DEFAULT_UI_FONT_SIZE)).toBe(MIN_UI_FONT_SIZE)
    expect(clampFontSize(1, MIN_EDITOR_FONT_SIZE, MAX_EDITOR_FONT_SIZE, DEFAULT_EDITOR_FONT_SIZE)).toBe(MIN_EDITOR_FONT_SIZE)
  })

  it('小数四舍五入为整数', () => {
    expect(clampFontSize(17.6, MIN_EDITOR_FONT_SIZE, MAX_EDITOR_FONT_SIZE, DEFAULT_EDITOR_FONT_SIZE)).toBe(18)
  })

  it('非数字值回退到默认值', () => {
    expect(clampFontSize('abc', MIN_EDITOR_FONT_SIZE, MAX_EDITOR_FONT_SIZE, DEFAULT_EDITOR_FONT_SIZE)).toBe(DEFAULT_EDITOR_FONT_SIZE)
    expect(clampFontSize('18', MIN_EDITOR_FONT_SIZE, MAX_EDITOR_FONT_SIZE, DEFAULT_EDITOR_FONT_SIZE)).toBe(DEFAULT_EDITOR_FONT_SIZE)
    expect(clampFontSize(null, MIN_EDITOR_FONT_SIZE, MAX_EDITOR_FONT_SIZE, DEFAULT_EDITOR_FONT_SIZE)).toBe(DEFAULT_EDITOR_FONT_SIZE)
  })
})
