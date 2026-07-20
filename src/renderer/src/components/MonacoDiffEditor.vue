<script setup lang="ts">
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useThemeStore } from '../stores/theme'
import { useSettingsStore } from '../stores/settings'
import { ensureMonacoThemes } from '../utils/monaco-theme'

const props = withDefaults(
  defineProps<{
    original: string
    modified: string
    ignoreTrimWhitespace?: boolean
    renderSideBySide?: boolean
  }>(),
  {
    ignoreTrimWhitespace: false,
    renderSideBySide: true
  }
)

const emit = defineEmits<{
  'difference-count': [count: number]
}>()

const themeStore = useThemeStore()
const settingsStore = useSettingsStore()
const host = ref<HTMLElement>()
let editor: monaco.editor.IStandaloneDiffEditor | undefined
let originalModel: monaco.editor.ITextModel | undefined
let modifiedModel: monaco.editor.ITextModel | undefined
let configurationListeners: monaco.IDisposable[] = []

/**
 * 创建 VS Code 同源的差异编辑器。
 */
onMounted(() => {
  ensureMonacoThemes()
  originalModel = monaco.editor.createModel(props.original, 'plaintext')
  modifiedModel = monaco.editor.createModel(props.modified, 'plaintext')
  editor = monaco.editor.createDiffEditor(host.value!, {
    readOnly: true,
    originalEditable: false,
    automaticLayout: true,
    theme: themeStore.monacoThemeName,
    fontSize: settingsStore.editorFontSize,
    lineHeight: 0,
    mouseWheelZoom: true,
    renderSideBySide: props.renderSideBySide,
    ignoreTrimWhitespace: props.ignoreTrimWhitespace,
    renderIndicators: true,
    renderOverviewRuler: true,
    diffWordWrap: 'off',
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    hideUnchangedRegions: { enabled: true }
  })
  editor.setModel({ original: originalModel, modified: modifiedModel })
  editor.onDidUpdateDiff(reportDifferenceCount)
  configurationListeners = [editor.getOriginalEditor(), editor.getModifiedEditor()].map((codeEditor) =>
    codeEditor.onDidChangeConfiguration((event) => {
      if (!event.hasChanged(monaco.editor.EditorOption.fontSize) || !editor) return
      const current = codeEditor.getOption(monaco.editor.EditorOption.fontSize)
      const next = settingsStore.setEditorFontSize(current)
      if (next !== current) editor.updateOptions({ fontSize: next })
    })
  )
})

/**
 * 报告差异块数量，供工具栏展示。
 */
function reportDifferenceCount(): void {
  emit('difference-count', editor?.getLineChanges()?.length ?? 0)
}

watch(
  () => props.original,
  (value) => {
    if (originalModel?.getValue() !== value) originalModel?.setValue(value)
  }
)

watch(
  () => props.modified,
  (value) => {
    if (modifiedModel?.getValue() !== value) modifiedModel?.setValue(value)
  }
)

watch(
  () => [props.ignoreTrimWhitespace, props.renderSideBySide] as const,
  ([ignoreTrimWhitespace, renderSideBySide]) => {
    editor?.updateOptions({ ignoreTrimWhitespace, renderSideBySide })
  }
)

/** 设置中心或其他编辑器改变字号时同步差异编辑器。 */
watch(
  () => settingsStore.editorFontSize,
  (fontSize) => {
    if (editor) editor.updateOptions({ fontSize })
  }
)

watch(
  () => themeStore.monacoThemeName,
  (themeName) => monaco.editor.setTheme(themeName)
)

/**
 * 释放差异编辑器及其两个模型。
 */
onBeforeUnmount(() => {
  configurationListeners.forEach((listener) => listener.dispose())
  editor?.dispose()
  originalModel?.dispose()
  modifiedModel?.dispose()
})
</script>

<template>
  <div ref="host" class="editor-host" />
</template>
