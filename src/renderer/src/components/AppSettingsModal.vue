<script setup lang="ts">
import { NButton, NDivider, NInputNumber, NModal, NRadioButton, NRadioGroup, NSlider } from 'naive-ui'
import { useSettingsStore } from '../stores/settings'
import { useThemeStore, type AppStyle, type ColorMode } from '../stores/theme'

defineProps<{
  show: boolean
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
}>()

const settingsStore = useSettingsStore()
const themeStore = useThemeStore()

/** 更新明暗模式。 */
function updateColorMode(value: string | number | boolean): void {
  themeStore.setColorMode(value as ColorMode)
}

/** 更新 Neo 或 Standard 风格。 */
function updateStyle(value: string | number | boolean): void {
  themeStore.setStyle(value as AppStyle)
}

/** 更新界面字号。 */
function updateUiFontSize(value: number | null): void {
  if (value !== null) settingsStore.setUiFontSize(value)
}

/** 更新文本编辑器字号。 */
function updateEditorFontSize(value: number | null): void {
  if (value !== null) settingsStore.setEditorFontSize(value)
}

/** 关闭设置弹窗。 */
function close(): void {
  emit('update:show', false)
}
</script>

<template>
  <NModal :show="show" preset="card" title="设置" class="settings-modal" @update:show="emit('update:show', $event)">
    <div class="settings-form">
      <section class="settings-item">
        <div class="settings-item-header"><label>明暗模式</label><span>{{ themeStore.isDark ? '暗色' : '亮色' }}</span></div>
        <NRadioGroup :value="themeStore.colorMode" size="small" @update:value="updateColorMode">
          <NRadioButton value="light">亮色</NRadioButton>
          <NRadioButton value="dark">暗色</NRadioButton>
        </NRadioGroup>
      </section>

      <section class="settings-item">
        <div class="settings-item-header"><label>界面风格</label><span>{{ themeStore.isNeo ? 'Neo' : 'Standard' }}</span></div>
        <NRadioGroup :value="themeStore.style" size="small" @update:value="updateStyle">
          <NRadioButton value="neo">Neo</NRadioButton>
          <NRadioButton value="standard">Standard</NRadioButton>
        </NRadioGroup>
      </section>

      <NDivider>字号</NDivider>
      <section class="settings-item">
        <div class="settings-item-header">
          <label>界面字号</label>
          <span>{{ settingsStore.uiFontSize }} px</span>
        </div>
        <div class="settings-item-control">
          <NSlider
            :value="settingsStore.uiFontSize"
            :min="settingsStore.limits.ui.min"
            :max="settingsStore.limits.ui.max"
            :step="1"
            :tooltip="false"
            @update:value="updateUiFontSize"
          />
          <NInputNumber
            :value="settingsStore.uiFontSize"
            :min="settingsStore.limits.ui.min"
            :max="settingsStore.limits.ui.max"
            :step="1"
            size="small"
            :show-button="false"
            @update:value="updateUiFontSize"
          />
        </div>
      </section>

      <section class="settings-item">
        <div class="settings-item-header">
          <label>文本编辑器字号</label>
          <span>{{ settingsStore.editorFontSize }} px</span>
        </div>
        <div class="settings-item-control">
          <NSlider
            :value="settingsStore.editorFontSize"
            :min="settingsStore.limits.editor.min"
            :max="settingsStore.limits.editor.max"
            :step="1"
            :tooltip="false"
            @update:value="updateEditorFontSize"
          />
          <NInputNumber
            :value="settingsStore.editorFontSize"
            :min="settingsStore.limits.editor.min"
            :max="settingsStore.limits.editor.max"
            :step="1"
            size="small"
            :show-button="false"
            @update:value="updateEditorFontSize"
          />
        </div>
      </section>

      <div class="settings-preview" :style="{ fontSize: `${settingsStore.editorFontSize}px` }">SELECT * FROM users;</div>
      <div class="settings-actions">
        <NButton secondary @click="settingsStore.resetFontSizes">恢复默认</NButton>
        <NButton type="primary" @click="close">完成</NButton>
      </div>
    </div>
  </NModal>
</template>
