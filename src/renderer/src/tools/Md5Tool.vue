<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { Clipboard } from '@lucide/vue'
import { NButton, NIcon, NInput, useMessage } from 'naive-ui'
import ToolPage from '../components/ToolPage.vue'
import { copyText } from '../utils/clipboard'

const input = ref('')
const output = ref('')
const error = ref('')
const message = useMessage()
let calculateTimer: ReturnType<typeof setTimeout> | undefined
let calculationVersion = 0

/**
 * 输入变化后稍作等待再计算，避免快速打字时频繁调用主进程。
 */
function scheduleCalculation(value: string): void {
  input.value = value
  if (calculateTimer) clearTimeout(calculateTimer)
  if (!value) {
    output.value = ''
    error.value = ''
    return
  }
  calculateTimer = setTimeout(() => void calculate(value), 120)
}

/**
 * 通过安全 IPC 计算 MD5，并丢弃过期结果。
 */
async function calculate(value: string): Promise<void> {
  const version = ++calculationVersion
  error.value = ''
  try {
    const result = await window.electronApi.calculateMd5(value)
    if (version === calculationVersion) output.value = result
  } catch (reason) {
    console.error('MD5 计算失败', reason)
    error.value = `MD5 计算失败：${reason instanceof Error ? reason.message : String(reason)}`
  }
}

/**
 * 复制 MD5 结果。
 */
async function copy(): Promise<void> {
  await copyText(output.value)
  message.success('已复制')
}

/**
 * 组件卸载时取消尚未开始的计算。
 */
onBeforeUnmount(() => {
  if (calculateTimer) clearTimeout(calculateTimer)
})
</script>

<template>
  <ToolPage title="MD5">
    <template #actions>
      <span class="status-text">32 位小写</span>
    </template>
    <template #status><span v-if="error" class="error-text">{{ error }}</span></template>
    <div class="md5-form">
      <label class="field-label">输入文本（实时计算）</label>
      <NInput
        :value="input"
        type="textarea"
        :autosize="{ minRows: 6, maxRows: 14 }"
        placeholder="输入任意文本"
        @update:value="scheduleCalculation"
      />
      <label class="field-label">MD5 结果</label>
      <div class="result-row">
        <NInput :value="output" readonly />
        <NButton circle :disabled="!output" title="复制" @click="copy">
          <template #icon><NIcon :component="Clipboard" /></template>
        </NButton>
      </div>
    </div>
  </ToolPage>
</template>

<style scoped>
.md5-form {
  width: min(820px, 100%);
  padding: 18px;
}

.field-label {
  display: block;
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 700;
}

.field-label:not(:first-child) {
  margin-top: 24px;
}

.result-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 36px;
  gap: 8px;
}
</style>
