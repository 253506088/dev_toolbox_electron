<script setup lang="ts">
import { computed } from 'vue'
import { Ban, FolderOpen, RotateCcw } from '@lucide/vue'
import { NButton, NEmpty, NIcon, NProgress, NTag, NTooltip } from 'naive-ui'
import type { BatchTaskSnapshot, BatchTaskStatus } from '@shared/batch-task'

const props = defineProps<{
  snapshot: BatchTaskSnapshot | null
}>()

const emit = defineEmits<{
  cancel: []
  retry: [itemId: string]
  openOutput: [path: string]
}>()

const percent = computed(() => {
  if (!props.snapshot || props.snapshot.items.length === 0) return 0
  return Math.round(props.snapshot.items.reduce((sum, item) => sum + item.progress, 0) / props.snapshot.items.length * 100)
})
const active = computed(() => Boolean(props.snapshot?.items.some((item) => item.status === 'queued' || item.status === 'running')))

/** 返回任务状态对应的中文文字。 */
function statusText(status: BatchTaskStatus): string {
  return { queued: '等待', running: '处理中', succeeded: '成功', failed: '失败', cancelled: '已取消' }[status]
}

/** 返回任务状态对应的标签颜色。 */
function statusType(status: BatchTaskStatus): 'default' | 'info' | 'success' | 'error' | 'warning' {
  const types: Record<BatchTaskStatus, 'default' | 'info' | 'success' | 'error' | 'warning'> = {
    queued: 'default', running: 'info', succeeded: 'success', failed: 'error', cancelled: 'warning'
  }
  return types[status]
}

/** 从完整路径中提取文件名。 */
function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}
</script>

<template>
  <section class="batch-queue">
    <header class="batch-header">
      <div>
        <strong>批量任务</strong>
        <span v-if="snapshot">成功 {{ snapshot.summary.succeeded }} · 失败 {{ snapshot.summary.failed }} · 取消 {{ snapshot.summary.cancelled }}</span>
      </div>
      <NButton v-if="active" size="small" type="error" secondary @click="emit('cancel')">
        <template #icon><NIcon :component="Ban" /></template>取消整批
      </NButton>
    </header>
    <NProgress v-if="snapshot" type="line" :percentage="percent" :indicator-placement="'inside'" processing />
    <NEmpty v-if="!snapshot" description="尚未开始批量任务" size="small" />
    <div v-else class="batch-items">
      <article v-for="item in snapshot.items" :key="item.id" class="batch-item">
        <div class="batch-item-main">
          <strong :title="item.inputPath">{{ fileName(item.inputPath) }}</strong>
          <span>{{ item.stage }}</span>
          <small v-if="item.error" :title="item.error">{{ item.error }}</small>
        </div>
        <NProgress type="line" :percentage="Math.round(item.progress * 100)" :show-indicator="false" :status="item.status === 'failed' ? 'error' : item.status === 'succeeded' ? 'success' : 'default'" />
        <NTag size="small" :type="statusType(item.status)">{{ statusText(item.status) }}</NTag>
        <div class="batch-item-actions">
          <NTooltip v-if="item.status === 'failed' || item.status === 'cancelled'">
            <template #trigger><NButton quaternary circle size="small" @click="emit('retry', item.id)"><template #icon><NIcon :component="RotateCcw" /></template></NButton></template>
            重试
          </NTooltip>
          <NTooltip v-if="item.status === 'succeeded'">
            <template #trigger><NButton quaternary circle size="small" @click="emit('openOutput', item.outputPath)"><template #icon><NIcon :component="FolderOpen" /></template></NButton></template>
            打开输出目录
          </NTooltip>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.batch-queue { display: flex; flex-direction: column; min-height: 0; gap: 9px; }
.batch-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.batch-header > div { display: flex; align-items: baseline; gap: 10px; }
.batch-header span { color: var(--text-muted); font-size: var(--ui-font-sm); }
.batch-items { min-height: 0; overflow: auto; border: 1px solid var(--border-color); border-radius: 5px; }
.batch-item { display: grid; grid-template-columns: minmax(150px, 1.3fr) minmax(90px, .8fr) auto 34px; align-items: center; gap: 10px; min-height: 58px; padding: 8px 10px; border-bottom: 1px solid var(--border-color); }
.batch-item:last-child { border-bottom: 0; }
.batch-item-main { display: flex; flex-direction: column; min-width: 0; gap: 2px; }
.batch-item-main strong, .batch-item-main span, .batch-item-main small { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.batch-item-main span { color: var(--text-muted); font-size: var(--ui-font-sm); }
.batch-item-main small { color: var(--error-color); }
.batch-item-actions { width: 34px; }
@media (max-width: 900px) { .batch-item { grid-template-columns: minmax(120px, 1fr) 90px auto; } .batch-item > .n-progress { display: none; } }
</style>
