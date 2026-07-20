<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { AlarmClock } from '@lucide/vue'
import { NButton, NIcon, NModal } from 'naive-ui'
import type { StickyNote } from '@shared/electron-api'

const note = ref<StickyNote | null>(null)
let unsubscribe: (() => void) | undefined

/** 在应用根部监听主进程提醒。 */
onMounted(() => {
  unsubscribe = window.electronApi.notes.onReminder((triggeredNote) => {
    note.value = triggeredNote
  })
})

/** 组件销毁时取消 IPC 监听。 */
onBeforeUnmount(() => unsubscribe?.())
</script>

<template>
  <NModal :show="Boolean(note)" preset="card" class="reminder-modal" @update:show="!$event && (note = null)">
    <div v-if="note" class="reminder-content">
      <NIcon :component="AlarmClock" :size="42" color="#f97316" />
      <h2>便签提醒</h2>
      <div class="reminder-note" :style="{ background: note.color }">{{ note.content || '图片便签到时间了' }}</div>
      <img v-if="note.imageNames[0]" :src="`note-image://image/${encodeURIComponent(note.imageNames[0])}`" alt="提醒图片" />
      <NButton type="primary" @click="note = null">知道了</NButton>
    </div>
  </NModal>
</template>

<style scoped>
.reminder-modal { width: min(480px, 92vw); }
.reminder-content { display: flex; flex-direction: column; align-items: center; gap: 12px; }
.reminder-content h2 { margin: 0; font-size: var(--ui-font-xxl); }
.reminder-note { width: 100%; max-height: 220px; overflow: auto; padding: 16px; border: 1px solid var(--border-color); border-radius: 5px; white-space: pre-wrap; }
.reminder-content img { max-width: 100%; max-height: 220px; object-fit: contain; }
</style>
