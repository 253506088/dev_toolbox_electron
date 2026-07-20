import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useThemeStore } from '../src/renderer/src/stores/theme'

const storage = new Map<string, string>()

describe('应用主题仓库', () => {
  beforeEach(() => {
    storage.clear()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value)
    })
    setActivePinia(createPinia())
  })

  afterEach(() => vi.unstubAllGlobals())

  it('没有保存数据时保持 Neo 亮色', () => {
    const theme = useThemeStore()
    expect(theme.style).toBe('neo')
    expect(theme.colorMode).toBe('light')
    expect(theme.naiveTheme).toBeNull()
    expect(theme.monacoThemeName).toBe('dev-neo-light')
  })

  it('读取已保存的 Standard 暗色组合', () => {
    storage.set('dev-toolbox-style', 'standard')
    storage.set('dev-toolbox-color-mode', 'dark')
    const theme = useThemeStore()
    expect(theme.isNeo).toBe(false)
    expect(theme.isDark).toBe(true)
    expect(theme.naiveTheme).not.toBeNull()
    expect(theme.monacoThemeName).toBe('dev-standard-dark')
  })

  it('非法保存值分别回退到 Neo 和亮色', () => {
    storage.set('dev-toolbox-style', 'broken')
    storage.set('dev-toolbox-color-mode', 'system')
    const theme = useThemeStore()
    expect(theme.style).toBe('neo')
    expect(theme.colorMode).toBe('light')
  })

  it('切换明暗模式不改变界面风格', () => {
    const theme = useThemeStore()
    theme.toggleColorMode()
    expect(theme.style).toBe('neo')
    expect(theme.colorMode).toBe('dark')
    expect(storage.get('dev-toolbox-color-mode')).toBe('dark')
    expect(theme.monacoThemeName).toBe('dev-neo-dark')
  })

  it('切换界面风格不改变明暗模式', () => {
    const theme = useThemeStore()
    theme.setColorMode('dark')
    theme.toggleStyle()
    expect(theme.style).toBe('standard')
    expect(theme.colorMode).toBe('dark')
    expect(storage.get('dev-toolbox-style')).toBe('standard')
    expect(theme.monacoThemeName).toBe('dev-standard-dark')
  })

  it('设置方法生成剩余的 Standard 亮色组合', () => {
    const theme = useThemeStore()
    theme.setStyle('standard')
    theme.setColorMode('light')
    expect(theme.monacoThemeName).toBe('dev-standard-light')
    expect(theme.themeOverrides.common?.primaryColor).toBe('#0f766e')
  })
})
