<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { AlarmClock } from '@lucide/vue'
import { NButton, NIcon, NModal } from 'naive-ui'
import type { StickyNote } from '@shared/electron-api'

const pendingNotes = ref<StickyNote[]>([])
const leavingNote = ref<StickyNote | null>(null)
const note = computed(() => pendingNotes.value[0] ?? leavingNote.value)
let unsubscribe: (() => void) | undefined

/** 在应用根部监听主进程提醒。 */
onMounted(() => {
  unsubscribe = window.electronApi.notes.onReminder((triggeredNote) => {
    const existing = pendingNotes.value.findIndex((item) => item.id === triggeredNote.id)
    if (existing >= 0) pendingNotes.value[existing] = triggeredNote
    else pendingNotes.value.push(triggeredNote)
  })
})

/** 同一分钟到期的便签依次确认，避免新提醒覆盖尚未读完的内容。 */
function dismissReminder(): void {
  // 关闭动画期间保留卡片内容及尺寸，避免先缩成空弹窗再消失。
  leavingNote.value = pendingNotes.value.shift() ?? null
}

/** 组件销毁时取消 IPC 监听。 */
onBeforeUnmount(() => unsubscribe?.())
</script>

<template>
  <NModal :show="pendingNotes.length > 0" preset="card" class="reminder-modal" style="width: min(480px, 92vw)" :mask-closable="false" @update:show="!$event && dismissReminder()" @after-leave="leavingNote = null">
    <div v-if="note" class="reminder-content">
      <NIcon :component="AlarmClock" :size="42" color="#f97316" />
      <h2>便签提醒<span v-if="pendingNotes.length > 1" class="reminder-count">（待确认 {{ pendingNotes.length }} 条）</span></h2>
      <div class="reminder-note" :style="{ background: note.color }">{{ note.content || '图片便签到时间了' }}</div>
      <div v-if="note.imageNames[0]" class="reminder-image">
        <img :src="`note-image://image/${encodeURIComponent(note.imageNames[0])}`" alt="提醒图片" />
      </div>
      <NButton type="primary" @click="dismissReminder">{{ pendingNotes.length > 1 ? '知道了，查看下一条' : '知道了' }}</NButton>
    </div>
  </NModal>
</template>

<style scoped>
.reminder-content { display: flex; flex-direction: column; align-items: center; gap: 12px; }
.reminder-content h2 { margin: 0; font-size: var(--ui-font-xxl); }
.reminder-count { color: var(--text-muted); font-size: var(--ui-font-sm); font-weight: 400; }
.reminder-note { width: 100%; max-height: 220px; overflow: auto; padding: 16px; color: #20302f; border: 1px solid rgb(32 48 47 / 28%); border-radius: 5px; white-space: pre-wrap; overflow-wrap: anywhere; }
.reminder-image { display: grid; place-items: center; width: 100%; height: 220px; }
.reminder-image img { max-width: 100%; max-height: 220px; object-fit: contain; }
</style>
