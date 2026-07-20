<script setup lang="ts">
import { ref } from 'vue'
import { Clipboard, Eraser, List, ListMinus, ArrowLeftRight } from '@lucide/vue'
import { NButton, NIcon, useMessage } from 'naive-ui'
import MonacoEditor from '../components/MonacoEditor.vue'
import ToolPage from '../components/ToolPage.vue'
import { copyText } from '../utils/clipboard'
import { useOperationState } from '../utils/tool-state'
import type { TextOperation } from '../utils/text-operations'

const input = ref('')
const output = ref('')
const message = useMessage()
const { busy, error, run } = useOperationState()

/**
 * 格式化或还原 SQL IN 文本。
 */
async function transform(operation: TextOperation): Promise<void> {
  const result = await run(operation, input.value)
  if (result !== undefined) output.value = result
}

/**
 * 交换输入和输出。
 */
function swap(): void {
  ;[input.value, output.value] = [output.value, input.value]
}

/**
 * 复制输出内容。
 */
async function copy(): Promise<void> {
  await copyText(output.value)
  message.success('已复制')
}

/**
 * 清空输入、输出和错误。
 */
function clear(): void {
  input.value = ''
  output.value = ''
  error.value = ''
}
</script>

<template>
  <ToolPage title="SQL IN">
    <template #actions>
      <NButton type="primary" :loading="busy" @click="transform('sql-in-format')">
        <template #icon><NIcon :component="List" /></template>
        格式化
      </NButton>
      <NButton :disabled="busy" @click="transform('sql-in-unformat')">
        <template #icon><NIcon :component="ListMinus" /></template>
        去格式化
      </NButton>
      <NButton :disabled="!input && !output" @click="swap">
        <template #icon><NIcon :component="ArrowLeftRight" /></template>
        交换
      </NButton>
      <NButton :disabled="!output" @click="copy">
        <template #icon><NIcon :component="Clipboard" /></template>
        复制
      </NButton>
      <NButton type="error" secondary :disabled="!input && !output" @click="clear">
        <template #icon><NIcon :component="Eraser" /></template>
        清空
      </NButton>
    </template>
    <template #status><span v-if="error" class="error-text">{{ error }}</span></template>
    <div class="editor-grid">
      <div class="editor-panel">
        <div class="editor-label">输入</div>
        <MonacoEditor v-model="input" language="sql" aria-label="SQL IN 输入编辑器" />
      </div>
      <div class="editor-panel">
        <div class="editor-label">输出</div>
        <MonacoEditor v-model="output" language="sql" read-only aria-label="SQL IN 输出编辑器" />
      </div>
    </div>
  </ToolPage>
</template>
