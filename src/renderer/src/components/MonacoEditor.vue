<script setup lang="ts">
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useThemeStore } from '../stores/theme'
import { useSettingsStore } from '../stores/settings'
import { ensureMonacoThemes } from '../utils/monaco-theme'

const props = withDefaults(
  defineProps<{
    modelValue: string
    language?: string
    readOnly?: boolean
    ariaLabel?: string
    wordWrap?: 'off' | 'on'
  }>(),
  {
    language: 'plaintext',
    readOnly: false,
    ariaLabel: '文本编辑器',
    wordWrap: 'off'
  }
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const themeStore = useThemeStore()
const settingsStore = useSettingsStore()
const host = ref<HTMLElement>()
let editor: monaco.editor.IStandaloneCodeEditor | undefined
let model: monaco.editor.ITextModel | undefined
let internalUpdate = false
let configurationListener: monaco.IDisposable | undefined

/**
 * 创建 Monaco 编辑器并监听用户输入。
 */
onMounted(() => {
  ensureMonacoThemes()
  model = monaco.editor.createModel(props.modelValue, props.language)
  editor = monaco.editor.create(host.value!, {
    model,
    readOnly: props.readOnly,
    ariaLabel: props.ariaLabel,
    theme: themeStore.monacoThemeName,
    automaticLayout: true,
    fontFamily: 'Cascadia Mono, Consolas, monospace',
    fontSize: settingsStore.editorFontSize,
    lineHeight: 0,
    mouseWheelZoom: true,
    lineNumbers: 'on',
    minimap: { enabled: false },
    overviewRulerLanes: 0,
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    stickyScroll: { enabled: false },
    wordWrap: props.wordWrap,
    padding: { top: 8, bottom: 8 },
    renderWhitespace: 'selection',
    bracketPairColorization: { enabled: true },
    largeFileOptimizations: true
  })

  model.onDidChangeContent(() => {
    if (internalUpdate) return
    emit('update:modelValue', model?.getValue() ?? '')
  })

  configurationListener = editor.onDidChangeConfiguration((event) => {
    if (!event.hasChanged(monaco.editor.EditorOption.fontSize) || !editor) return
    const next = settingsStore.setEditorFontSize(editor.getOption(monaco.editor.EditorOption.fontSize))
    if (next !== editor.getOption(monaco.editor.EditorOption.fontSize)) editor.updateOptions({ fontSize: next })
  })
})

/**
 * 外部值变化时更新模型，同时保留用户光标和滚动位置。
 */
watch(
  () => props.modelValue,
  (value) => {
    if (!model || model.getValue() === value) return
    internalUpdate = true
    model.setValue(value)
    internalUpdate = false
  }
)

/** 语言属性变化时更新当前模型的语法高亮。 */
watch(
  () => props.language,
  (language) => {
    if (model && model.getLanguageId() !== language) monaco.editor.setModelLanguage(model, language)
  }
)

/** 设置中心或其他编辑器改变字号时同步当前编辑器。 */
watch(
  () => settingsStore.editorFontSize,
  (fontSize) => {
    if (editor && editor.getOption(monaco.editor.EditorOption.fontSize) !== fontSize) editor.updateOptions({ fontSize })
  }
)

/**
 * 切换应用风格或明暗模式时同步 Monaco 配色。
 */
watch(
  () => themeStore.monacoThemeName,
  (themeName) => monaco.editor.setTheme(themeName)
)

/**
 * 组件卸载时释放编辑器模型，避免工具切换后残留资源。
 */
onBeforeUnmount(() => {
  configurationListener?.dispose()
  editor?.dispose()
  model?.dispose()
})

</script>

<template>
  <div ref="host" class="editor-host" />
</template>
