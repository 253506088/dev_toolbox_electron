import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSettingsStore } from '../src/renderer/src/stores/settings'

const storage = new Map<string, string>()

describe('字号设置仓库', () => {
  beforeEach(() => {
    storage.clear()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value)
    })
    setActivePinia(createPinia())
  })

  afterEach(() => vi.unstubAllGlobals())

  it('创建时读取已保存字号', () => {
    storage.set('dev-toolbox-settings-v1', '{"uiFontSize":18,"editorFontSize":22}')
    const settingsStore = useSettingsStore()
    expect(settingsStore.uiFontSize).toBe(18)
    expect(settingsStore.editorFontSize).toBe(22)
  })

  it('修改字号后立即持久化', () => {
    const settingsStore = useSettingsStore()
    settingsStore.setUiFontSize(17)
    settingsStore.setEditorFontSize(21)
    expect(storage.get('dev-toolbox-settings-v1')).toBe('{"uiFontSize":17,"editorFontSize":21}')
  })

  it('界面字号同步生成主题和布局变量', () => {
    const settingsStore = useSettingsStore()
    settingsStore.setUiFontSize(20)
    expect(settingsStore.naiveThemeOverrides.common?.fontSize).toBe('20px')
    expect(settingsStore.uiCssVariables['--ui-sidebar-width']).toBe('280px')
  })

  it('恢复默认值后覆盖已保存数据', () => {
    const settingsStore = useSettingsStore()
    settingsStore.setUiFontSize(20)
    settingsStore.setEditorFontSize(30)
    settingsStore.resetFontSizes()
    expect(storage.get('dev-toolbox-settings-v1')).toBe('{"uiFontSize":14,"editorFontSize":13}')
  })
})
