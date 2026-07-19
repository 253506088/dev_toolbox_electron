import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { GlobalThemeOverrides } from 'naive-ui'

export type AppStyle = 'neo' | 'standard'

const STORAGE_KEY = 'dev-toolbox-style'

/**
 * 管理应用的 Neo 与标准两套界面风格。
 */
export const useThemeStore = defineStore('theme', () => {
  const style = ref<AppStyle>(readStoredStyle())
  const isNeo = computed(() => style.value === 'neo')
  const themeOverrides = computed<GlobalThemeOverrides>(() =>
    isNeo.value ? neoThemeOverrides : standardThemeOverrides
  )

  /** 切换风格并记住用户选择。 */
  function toggleStyle(): void {
    style.value = isNeo.value ? 'standard' : 'neo'
    localStorage.setItem(STORAGE_KEY, style.value)
  }

  return { style, isNeo, themeOverrides, toggleStyle }
})

/**
 * 从本地存储读取风格，非法值自动回退到 Neo。
 */
function readStoredStyle(): AppStyle {
  const stored = localStorage.getItem(STORAGE_KEY)
  return stored === 'standard' ? 'standard' : 'neo'
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
