<script setup lang="ts">
import { ref, watch } from 'vue'
import { AlignLeft, Clipboard, CodeXml, Eraser, Minimize2 } from '@lucide/vue'
import { NButton, NIcon, useMessage } from 'naive-ui'
import MonacoEditor from '../components/MonacoEditor.vue'
import ToolPage from '../components/ToolPage.vue'
import { copyText } from '../utils/clipboard'
import { useOperationState } from '../utils/tool-state'
import type { TextOperation } from '../utils/text-operations'

const text = ref('')
const message = useMessage()
const { busy, error, run } = useOperationState()
let inputVersion = 0
watch(text, () => { inputVersion += 1 }, { flush: 'sync' })

/**
 * 执行 SQL 格式化或压缩。
 */
async function transform(operation: TextOperation): Promise<void> {
  const version = inputVersion
  const isCurrent = (): boolean => version === inputVersion
  const result = await run(operation, text.value, isCurrent)
  if (result !== undefined && isCurrent()) text.value = result
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
      <NButton :disabled="busy" @click="transform('xml-unescape')">
        <template #icon><NIcon :component="CodeXml" /></template>
        XML 解码
      </NButton>
      <NButton :disabled="busy" @click="transform('xml-escape')">
        <template #icon><NIcon :component="CodeXml" /></template>
        XML 编码
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
    <template #status><span class="status-text">{{ busy ? '正在后台格式化，可继续编辑' : '支持 MyBatis #{…}、${…} 和动态 XML' }}</span></template>
    <div class="sql-workspace">
      <div v-if="error" class="sql-error" role="alert">
        <span>{{ error }}</span>
        <NButton size="small" quaternary @click="error = ''">关闭</NButton>
      </div>
      <div class="sql-editor">
        <MonacoEditor v-model="text" language="sql" aria-label="SQL 编辑器" />
      </div>
    </div>
  </ToolPage>
</template>

<style scoped>
.sql-workspace { display: flex; flex-direction: column; height: 100%; min-height: 0; gap: 8px; }
.sql-editor { display: flex; flex: 1; min-height: 0; }
.sql-error { display: flex; flex: 0 0 auto; align-items: flex-start; gap: 10px; max-height: 96px; overflow: auto; padding: 8px 12px; color: var(--error-color); border: 1px solid var(--error-color); border-radius: 4px; font-size: var(--ui-font-sm); }
.sql-error span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.sql-error :deep(.n-button) { flex: none; }
</style>
