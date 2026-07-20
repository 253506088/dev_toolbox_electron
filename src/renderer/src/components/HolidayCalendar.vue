<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ChevronLeft, ChevronRight } from '@lucide/vue'
import { NButton, NIcon, NModal, NSpin } from 'naive-ui'
import type { HolidayDay } from '@shared/electron-api'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ 'update:show': [value: boolean] }>()
const cursor = ref(new Date(new Date().getFullYear(), new Date().getMonth(), 1))
const days = ref<HolidayDay[]>([])
const loading = ref(false)
const title = computed(() => `${cursor.value.getFullYear()} 年 ${cursor.value.getMonth() + 1} 月`)
const leadingBlanks = computed(() => (new Date(cursor.value.getFullYear(), cursor.value.getMonth(), 1).getDay() + 6) % 7)

/** 打开弹窗或月份变化时读取节假日数据。 */
watch([() => props.show, cursor], async ([show]) => {
  if (!show) return
  loading.value = true
  try {
    days.value = await window.electronApi.holiday.getMonth(cursor.value.getFullYear(), cursor.value.getMonth() + 1)
  } finally {
    loading.value = false
  }
}, { immediate: true })

/** 前后移动一个月。 */
function moveMonth(step: number): void {
  cursor.value = new Date(cursor.value.getFullYear(), cursor.value.getMonth() + step, 1)
}

/** 回到本月。 */
function goToday(): void {
  const now = new Date()
  cursor.value = new Date(now.getFullYear(), now.getMonth(), 1)
}
</script>

<template>
  <NModal :show="show" preset="card" title="节假日日历" class="calendar-modal" @update:show="emit('update:show', $event)">
    <div class="calendar-toolbar">
      <NButton circle quaternary @click="moveMonth(-1)"><template #icon><NIcon :component="ChevronLeft" /></template></NButton>
      <strong>{{ title }}</strong>
      <NButton circle quaternary @click="moveMonth(1)"><template #icon><NIcon :component="ChevronRight" /></template></NButton>
      <NButton size="small" @click="goToday">今天</NButton>
    </div>
    <div class="calendar-week"><span v-for="label in ['一','二','三','四','五','六','日']" :key="label">{{ label }}</span></div>
    <NSpin :show="loading">
      <div class="calendar-grid">
        <span v-for="blank in leadingBlanks" :key="`blank-${blank}`" />
        <div v-for="day in days" :key="day.date" class="calendar-day" :class="{ rest: !day.isWorkday }">
          <span>{{ Number(day.date.slice(-2)) }}</span>
          <b>{{ day.isWorkday ? '班' : '休' }}</b>
        </div>
      </div>
    </NSpin>
    <div v-if="days.some((day) => day.fromFallback)" class="calendar-warning">节假日接口不可用，当前按周一至周五显示。</div>
  </NModal>
</template>

<style scoped>
.calendar-modal { width: min(560px, 92vw); }
.calendar-toolbar { display: flex; align-items: center; justify-content: center; gap: 12px; margin-bottom: 12px; }
.calendar-week, .calendar-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 5px; }
.calendar-week { margin-bottom: 5px; color: var(--text-muted); text-align: center; }
.calendar-day { display: flex; align-items: center; justify-content: space-between; min-height: 52px; padding: 7px; border: 1px solid var(--border-color); border-radius: 4px; }
.calendar-day b { color: var(--success-color); font-size: var(--ui-font-xs); }
.calendar-day.rest { background: color-mix(in srgb, var(--error-color) 14%, var(--surface-color)); }
.calendar-day.rest b { color: var(--error-color); }
.calendar-warning { margin-top: 10px; color: var(--warning-color); font-size: var(--ui-font-sm); }
</style>
