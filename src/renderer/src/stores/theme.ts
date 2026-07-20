import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { darkTheme, type GlobalTheme, type GlobalThemeOverrides } from 'naive-ui'

export type AppStyle = 'neo' | 'standard'
export type ColorMode = 'light' | 'dark'

const STYLE_STORAGE_KEY = 'dev-toolbox-style'
const COLOR_MODE_STORAGE_KEY = 'dev-toolbox-color-mode'

/**
 * 管理应用的 Neo/Standard 风格与亮色/暗色模式。
 */
export const useThemeStore = defineStore('theme', () => {
  const style = ref<AppStyle>(readStoredStyle())
  const colorMode = ref<ColorMode>(readStoredColorMode())
  const isNeo = computed(() => style.value === 'neo')
  const isDark = computed(() => colorMode.value === 'dark')
  const naiveTheme = computed<GlobalTheme | null>(() => isDark.value ? darkTheme : null)
  const monacoThemeName = computed(() => `dev-${style.value}-${colorMode.value}`)
  const themeOverrides = computed<GlobalThemeOverrides>(() => {
    const base = isNeo.value ? neoThemeOverrides : standardThemeOverrides
    if (!isDark.value) return base
    return {
      ...base,
      common: {
        ...base.common,
        bodyColor: isNeo.value ? '#101817' : '#17191c',
        cardColor: isNeo.value ? '#1a2322' : '#202328',
        modalColor: isNeo.value ? '#1a2322' : '#202328',
        popoverColor: isNeo.value ? '#222e2c' : '#282c31',
        tableColor: isNeo.value ? '#1a2322' : '#202328',
        tableHeaderColor: isNeo.value ? '#222e2c' : '#282c31',
        inputColor: isNeo.value ? '#151e1d' : '#1b1e22',
        borderColor: isNeo.value ? '#5f8f88' : '#444b55',
        dividerColor: isNeo.value ? '#33413f' : '#343a42'
      }
    }
  })

  /** 设置界面风格并记住用户选择。 */
  function setStyle(value: AppStyle): void {
    style.value = value
    localStorage.setItem(STYLE_STORAGE_KEY, value)
  }

  /** 切换风格并记住用户选择。 */
  function toggleStyle(): void {
    setStyle(isNeo.value ? 'standard' : 'neo')
  }

  /** 设置明暗模式并记住用户选择。 */
  function setColorMode(value: ColorMode): void {
    colorMode.value = value
    localStorage.setItem(COLOR_MODE_STORAGE_KEY, value)
  }

  /** 在亮色和暗色之间切换。 */
  function toggleColorMode(): void {
    setColorMode(isDark.value ? 'light' : 'dark')
  }

  return {
    style,
    colorMode,
    isNeo,
    isDark,
    naiveTheme,
    monacoThemeName,
    themeOverrides,
    setStyle,
    toggleStyle,
    setColorMode,
    toggleColorMode
  }
})

/**
 * 从本地存储读取风格，非法值自动回退到 Neo。
 */
function readStoredStyle(): AppStyle {
  const stored = localStorage.getItem(STYLE_STORAGE_KEY)
  return stored === 'standard' ? 'standard' : 'neo'
}

/** 从本地存储读取明暗模式，非法值自动回退到亮色。 */
function readStoredColorMode(): ColorMode {
  return localStorage.getItem(COLOR_MODE_STORAGE_KEY) === 'dark' ? 'dark' : 'light'
}

const neoThemeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#0d9488',
    primaryColorHover: '#0f766e',
    primaryColorPressed: '#115e59',
    infoColor: '#2563eb',
    warningColor: '#f97316',
    errorColor: '#dc2626',
    borderRadius: '8px',
    fontFamily: '"Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
    fontFamilyMono: '"Cascadia Mono", Consolas, monospace'
  },
  Button: {
    borderRadiusMedium: '8px',
    fontWeight: '700'
  }
}

const standardThemeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#0f766e',
    primaryColorHover: '#0d9488',
    primaryColorPressed: '#115e59',
    infoColor: '#2563eb',
    warningColor: '#ea580c',
    errorColor: '#dc2626',
    borderRadius: '6px',
    fontFamily: '"Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
    fontFamilyMono: '"Cascadia Mono", Consolas, monospace'
  }
}
