<script setup lang="ts">
import { ref } from 'vue'
import { Eraser, GitCompareArrows } from '@lucide/vue'
import { NButton, NCheckbox, NIcon, NRadioButton, NRadioGroup } from 'naive-ui'
import MonacoDiffEditor from '../components/MonacoDiffEditor.vue'
import MonacoEditor from '../components/MonacoEditor.vue'
import ToolPage from '../components/ToolPage.vue'

const originalDraft = ref('')
const modifiedDraft = ref('')
const original = ref('')
const modified = ref('')
const differenceCount = ref(0)
const ignoreTrimWhitespace = ref(false)
const viewMode = ref<'side-by-side' | 'inline'>('side-by-side')

/**
 * 把当前输入提交给差异编辑器。
 */
function compare(): void {
  original.value = originalDraft.value
  modified.value = modifiedDraft.value
}

/**
 * 清空输入、结果和差异计数。
 */
function clear(): void {
  originalDraft.value = ''
  modifiedDraft.value = ''
  original.value = ''
  modified.value = ''
  differenceCount.value = 0
}
</script>

<template>
  <ToolPage title="文本对比">
    <template #actions>
      <NButton type="primary" @click="compare">
        <template #icon><NIcon :component="GitCompareArrows" /></template>
        对比
      </NButton>
      <NButton type="error" secondary :disabled="!originalDraft && !modifiedDraft" @click="clear">
        <template #icon><NIcon :component="Eraser" /></template>
        清空
      </NButton>
      <NCheckbox v-model:checked="ignoreTrimWhitespace">忽略首尾空白</NCheckbox>
      <NRadioGroup v-model:value="viewMode" size="small">
        <NRadioButton value="side-by-side">左右</NRadioButton>
        <NRadioButton value="inline">单栏</NRadioButton>
      </NRadioGroup>
    </template>
    <template #status><span class="status-text">{{ differenceCount }} 处差异</span></template>

    <div class="diff-layout">
      <div class="diff-inputs">
        <div class="editor-panel">
          <div class="editor-label">原始文本</div>
          <MonacoEditor v-model="originalDraft" aria-label="原始文本编辑器" />
        </div>
        <div class="editor-panel">
          <div class="editor-label">新文本</div>
          <MonacoEditor v-model="modifiedDraft" aria-label="新文本编辑器" />
        </div>
      </div>
      <MonacoDiffEditor
        :original="original"
        :modified="modified"
        :ignore-trim-whitespace="ignoreTrimWhitespace"
        :render-side-by-side="viewMode === 'side-by-side'"
        @difference-count="differenceCount = $event"
      />
    </div>
  </ToolPage>
</template>

<style scoped>
.diff-layout {
  display: grid;
  grid-template-rows: 172px minmax(0, 1fr);
  height: 100%;
  min-height: 0;
  gap: 10px;
}

.diff-inputs {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  min-height: 0;
  gap: 10px;
}
</style>
