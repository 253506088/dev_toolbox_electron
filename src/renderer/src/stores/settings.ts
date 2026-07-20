import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { GlobalThemeOverrides } from 'naive-ui'
import {
  clampFontSize,
  DEFAULT_EDITOR_FONT_SIZE,
  DEFAULT_UI_FONT_SIZE,
  MAX_EDITOR_FONT_SIZE,
  MAX_UI_FONT_SIZE,
  MIN_EDITOR_FONT_SIZE,
  MIN_UI_FONT_SIZE,
  parseFontSettings
} from '../utils/font-settings'

const STORAGE_KEY = 'dev-toolbox-settings-v1'

/** 管理界面字号和文本编辑器字号，并在本地持久化。 */
export const useSettingsStore = defineStore('settings', () => {
  const stored = parseFontSettings(localStorage.getItem(STORAGE_KEY))
  const uiFontSize = ref(stored.uiFontSize)
  const editorFontSize = ref(stored.editorFontSize)

  /** 根据界面字号生成 Naive UI 的公共字体和控件高度。 */
  const naiveThemeOverrides = computed<GlobalThemeOverrides>(() => {
    const scale = uiFontSize.value / DEFAULT_UI_FONT_SIZE
    return {
      common: {
        fontSize: `${uiFontSize.value}px`,
        fontSizeMini: `${Math.max(10, uiFontSize.value - 3)}px`,
        fontSizeTiny: `${Math.max(10, uiFontSize.value - 2)}px`,
        fontSizeSmall: `${Math.max(11, uiFontSize.value - 1)}px`,
        fontSizeMedium: `${uiFontSize.value}px`,
        fontSizeLarge: `${uiFontSize.value + 1}px`,
        fontSizeHuge: `${uiFontSize.value + 2}px`,
        heightMini: `${Math.round(16 * scale)}px`,
        heightTiny: `${Math.round(22 * scale)}px`,
        heightSmall: `${Math.round(28 * scale)}px`,
        heightMedium: `${Math.round(34 * scale)}px`,
        heightLarge: `${Math.round(40 * scale)}px`,
        heightHuge: `${Math.round(46 * scale)}px`
      }
    }
  })

  /** 生成供全局 CSS 使用的字号和布局变量。 */
  const uiCssVariables = computed<Record<string, string>>(() => {
    const scale = uiFontSize.value / DEFAULT_UI_FONT_SIZE
    return {
      '--ui-font-size': `${uiFontSize.value}px`,
      '--ui-font-xs': `${Math.max(10, uiFontSize.value - 3)}px`,
      '--ui-font-sm': `${Math.max(11, uiFontSize.value - 2)}px`,
      '--ui-font-lg': `${uiFontSize.value + 1}px`,
      '--ui-font-xl': `${uiFontSize.value + 3}px`,
      '--ui-font-xxl': `${uiFontSize.value + 6}px`,
      '--ui-font-icon': `${Math.round(34 * scale)}px`,
      '--ui-sidebar-width': `${Math.round(196 * scale)}px`,
      '--ui-sidebar-width-small': `${Math.round(168 * scale)}px`,
      '--ui-shell-gap': `${Math.round(12 * scale)}px`,
      '--ui-shell-padding': `${Math.round(12 * scale)}px`,
      '--ui-brand-height': `${Math.round(58 * scale)}px`,
      '--ui-nav-row-height': `${Math.round(38 * scale)}px`,
      '--ui-header-height': `${Math.round(56 * scale)}px`,
      '--ui-content-padding': `${Math.round(12 * scale)}px`,
      '--ui-panel-gap': `${Math.round(12 * scale)}px`,
      '--ui-label-height': `${Math.round(28 * scale)}px`
    }
  })

  /** 保存当前字号，保证重启后恢复。 */
  function persist(): void {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ uiFontSize: uiFontSize.value, editorFontSize: editorFontSize.value })
    )
  }

  /** 更新界面字号并限制在可用范围内。 */
  function setUiFontSize(value: unknown): number {
    const next = clampFontSize(value, MIN_UI_FONT_SIZE, MAX_UI_FONT_SIZE, DEFAULT_UI_FONT_SIZE)
    if (uiFontSize.value !== next) {
      uiFontSize.value = next
      persist()
    }
    return next
  }

  /** 更新编辑器字号并限制在可用范围内。 */
  function setEditorFontSize(value: unknown): number {
    const next = clampFontSize(value, MIN_EDITOR_FONT_SIZE, MAX_EDITOR_FONT_SIZE, DEFAULT_EDITOR_FONT_SIZE)
    if (editorFontSize.value !== next) {
      editorFontSize.value = next
      persist()
    }
    return next
  }

  /** 恢复两项字号的默认值。 */
  function resetFontSizes(): void {
    uiFontSize.value = DEFAULT_UI_FONT_SIZE
    editorFontSize.value = DEFAULT_EDITOR_FONT_SIZE
    persist()
  }

  return {
    uiFontSize,
    editorFontSize,
    naiveThemeOverrides,
    uiCssVariables,
    setUiFontSize,
    setEditorFontSize,
    resetFontSizes,
    limits: {
      ui: { min: MIN_UI_FONT_SIZE, max: MAX_UI_FONT_SIZE },
      editor: { min: MIN_EDITOR_FONT_SIZE, max: MAX_EDITOR_FONT_SIZE }
    }
  }
})
