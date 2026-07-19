<script setup lang="ts">
import { ref } from 'vue'
import { ArrowDownUp, Braces, Clipboard, CodeXml, Eraser } from '@lucide/vue'
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

/** 执行 XML 与 JSON 互转。 */
async function transform(operation: TextOperation): Promise<void> {
  const result = await run(operation, input.value)
  if (result !== undefined) output.value = result
}

/** 交换输入和输出。 */
function swap(): void {
  ;[input.value, output.value] = [output.value, input.value]
}

/** 复制输出内容。 */
async function copy(): Promise<void> {
  await copyText(output.value)
  message.success('已复制')
}

/** 清空全部内容。 */
function clear(): void {
  input.value = ''
  output.value = ''
  error.value = ''
}
</script>

<template>
  <ToolPage title="XML / JSON">
    <template #actions>
      <NButton type="primary" :loading="busy" @click="transform('xml-to-json')">
        <template #icon><NIcon :component="Braces" /></template>XML 转 JSON
      </NButton>
      <NButton :disabled="busy" @click="transform('json-to-xml')">
        <template #icon><NIcon :component="CodeXml" /></template>JSON 转 XML
      </NButton>
      <NButton :disabled="!input && !output" @click="swap">
        <template #icon><NIcon :component="ArrowDownUp" /></template>交换
      </NButton>
      <NButton :disabled="!output" @click="copy">
        <template #icon><NIcon :component="Clipboard" /></template>复制
      </NButton>
      <NButton type="error" secondary :disabled="!input && !output" @click="clear">
        <template #icon><NIcon :component="Eraser" /></template>清空
      </NButton>
    </template>
    <template #status><span v-if="error" class="error-text">{{ error }}</span></template>
    <div class="editor-grid">
      <div class="editor-panel">
        <div class="editor-label">输入</div>
        <MonacoEditor v-model="input" language="xml" aria-label="XML 或 JSON 输入编辑器" />
      </div>
      <div class="editor-panel">
        <div class="editor-label">输出</div>
        <MonacoEditor v-model="output" aria-label="XML 或 JSON 输出编辑器" />
      </div>
    </div>
  </ToolPage>
</template>
