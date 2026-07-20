<script setup lang="ts">
import { ref } from 'vue'
import { AlignLeft, Clipboard, Code, Eraser, Languages, Minimize2 } from '@lucide/vue'
import { NButton, NIcon, NSpin, useMessage } from 'naive-ui'
import MonacoEditor from '../components/MonacoEditor.vue'
import ToolPage from '../components/ToolPage.vue'
import { copyText } from '../utils/clipboard'
import { useOperationState } from '../utils/tool-state'
import type { TextOperation } from '../utils/text-operations'

const text = ref('')
const message = useMessage()
const { busy, error, run } = useOperationState()

/**
 * 对当前 JSON 文本执行选定转换。
 */
async function transform(operation: TextOperation): Promise<void> {
  const result = await run(operation, text.value)
  if (result !== undefined) text.value = result
}

/**
 * 复制当前内容。
 */
async function copy(): Promise<void> {
  await copyText(text.value)
  message.success('已复制')
}

/**
 * 清空内容和错误。
 */
function clear(): void {
  text.value = ''
  error.value = ''
}
</script>

<template>
  <ToolPage title="JSON">
    <template #actions>
      <NButton type="primary" :loading="busy" @click="transform('json-format')">
        <template #icon><NIcon :component="AlignLeft" /></template>格式化
      </NButton>
      <NButton :disabled="busy" @click="transform('json-compress')">
        <template #icon><NIcon :component="Minimize2" /></template>压缩
      </NButton>
      <NButton :disabled="busy" @click="transform('json-escape')">
        <template #icon><NIcon :component="Code" /></template>转义
      </NButton>
      <NButton :disabled="busy" @click="transform('json-unescape')">去转义</NButton>
      <NButton :disabled="busy" @click="transform('unicode-encode')">
        <template #icon><NIcon :component="Languages" /></template>Unicode 编码
      </NButton>
      <NButton :disabled="busy" @click="transform('unicode-decode')">Unicode 解码</NButton>
      <NButton :disabled="!text" @click="copy">
        <template #icon><NIcon :component="Clipboard" /></template>复制
      </NButton>
      <NButton type="error" secondary :disabled="!text" @click="clear">
        <template #icon><NIcon :component="Eraser" /></template>清空
      </NButton>
    </template>
    <template #status><span v-if="error" class="error-text">{{ error }}</span></template>
    <NSpin :show="busy" class="editor-spin">
      <MonacoEditor v-model="text" language="json" aria-label="JSON 编辑器" />
    </NSpin>
  </ToolPage>
</template>
