<script setup lang="ts">
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useThemeStore } from '../stores/theme'

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
const host = ref<HTMLElement>()
let editor: monaco.editor.IStandaloneCodeEditor | undefined
let model: monaco.editor.ITextModel | undefined
let internalUpdate = false

/**
 * 创建 Monaco 编辑器并监听用户输入。
 */
onMounted(() => {
  defineEditorThemes()
  model = monaco.editor.createModel(props.modelValue, props.language)
  editor = monaco.editor.create(host.value!, {
    model,
    readOnly: props.readOnly,
    ariaLabel: props.ariaLabel,
    theme: themeStore.isNeo ? 'dev-neo' : 'dev-standard',
    automaticLayout: true,
    fontFamily: 'Cascadia Mono, Consolas, monospace',
    fontSize: 13,
    lineHeight: 20,
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

/**
 * 切换应用风格时同步 Monaco 配色。
 */
watch(
  () => themeStore.style,
  () => monaco.editor.setTheme(themeStore.isNeo ? 'dev-neo' : 'dev-standard')
)

/**
 * 组件卸载时释放编辑器模型，避免工具切换后残留资源。
 */
onBeforeUnmount(() => {
  editor?.dispose()
  model?.dispose()
})

/**
 * 注册与应用两套风格匹配的 Monaco 浅色主题。
 */
function defineEditorThemes(): void {
  monaco.editor.defineTheme('dev-neo', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#FFFFFF',
      'editorLineNumber.foreground': '#78918E',
      'editorLineNumber.activeForeground': '#0F766E',
      'editor.selectionBackground': '#99F6E455',
      'editorCursor.foreground': '#F97316'
    }
  })
  monaco.editor.defineTheme('dev-standard', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#FFFFFF',
      'editorLineNumber.foreground': '#9CA3AF',
      'editorLineNumber.activeForeground': '#0F766E',
      'editor.selectionBackground': '#BFDBFE88'
    }
  })
}
</script>

<template>
  <div ref="host" class="editor-host" />
</template>
