<script setup lang="ts">
import { ref } from 'vue'
import { AlignLeft, Clipboard, Eraser, Minimize2 } from '@lucide/vue'
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
 * 执行 SQL 格式化或压缩。
 */
async function transform(operation: TextOperation): Promise<void> {
  const result = await run(operation, text.value)
  if (result !== undefined) text.value = result
}

/**
 * 复制当前 SQL。
 */
async function copy(): Promise<void> {
  await copyText(text.value)
  message.success('已复制')
}

/**
 * 清空 SQL 和错误提示。
 */
function clear(): void {
  text.value = ''
  error.value = ''
}
</script>

<template>
  <ToolPage title="SQL 格式化">
    <template #actions>
      <NButton type="primary" :loading="busy" @click="transform('sql-format')">
        <template #icon><NIcon :component="AlignLeft" /></template>
        格式化
      </NButton>
      <NButton :disabled="busy" @click="transform('sql-compress')">
        <template #icon><NIcon :component="Minimize2" /></template>
        压缩
      </NButton>
      <NButton :disabled="!text" @click="copy">
        <template #icon><NIcon :component="Clipboard" /></template>
        复制
      </NButton>
      <NButton type="error" secondary :disabled="!text" @click="clear">
        <template #icon><NIcon :component="Eraser" /></template>
        清空
      </NButton>
    </template>
    <template #status><span v-if="error" class="error-text">{{ error }}</span></template>
    <NSpin :show="busy" class="editor-spin">
      <MonacoEditor v-model="text" language="sql" aria-label="SQL 编辑器" />
    </NSpin>
  </ToolPage>
</template>
