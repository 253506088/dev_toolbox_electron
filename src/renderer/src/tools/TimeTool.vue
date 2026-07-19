<script setup lang="ts">
import customParseFormat from 'dayjs/plugin/customParseFormat'
import dayjs from 'dayjs'
import { onBeforeUnmount, ref } from 'vue'
import { Clock3 } from '@lucide/vue'
import { NButton, NDatePicker, NIcon, NInput, NSwitch } from 'naive-ui'
import ToolPage from '../components/ToolPage.vue'

dayjs.extend(customParseFormat)

const DATE_FORMAT = 'YYYY-MM-DD HH:mm:ss'
const dateText = ref('')
const secondsText = ref('')
const millisText = ref('')
const pickerValue = ref<number | null>(null)
const autoUpdate = ref(false)
let timer: ReturnType<typeof setInterval> | undefined

/**
 * 用同一时间同步日期、秒和毫秒三个输入框。
 */
function updateAll(milliseconds: number): void {
  const date = dayjs(milliseconds)
  dateText.value = date.format(DATE_FORMAT)
  secondsText.value = Math.floor(milliseconds / 1000).toString()
  millisText.value = Math.trunc(milliseconds).toString()
  pickerValue.value = milliseconds
}

/**
 * 更新为当前系统时间。
 */
function updateNow(): void {
  updateAll(Date.now())
}

/**
 * 日期文本有效时更新两个时间戳。
 */
function onDateChanged(value: string): void {
  dateText.value = value
  const parsed = dayjs(value, DATE_FORMAT, true)
  if (!parsed.isValid()) return
  const milliseconds = parsed.valueOf()
  secondsText.value = Math.floor(milliseconds / 1000).toString()
  millisText.value = milliseconds.toString()
  pickerValue.value = milliseconds
}

/**
 * 秒时间戳有效时更新日期和毫秒。
 */
function onSecondsChanged(value: string): void {
  secondsText.value = value.replace(/\D/g, '')
  if (!secondsText.value) return
  updateFromTimestamp(Number(secondsText.value) * 1000, 'seconds')
}

/**
 * 毫秒时间戳有效时更新日期和秒。
 */
function onMillisChanged(value: string): void {
  millisText.value = value.replace(/\D/g, '')
  if (!millisText.value) return
  updateFromTimestamp(Number(millisText.value), 'millis')
}

/**
 * 从时间戳更新其余字段，同时避免覆盖正在输入的字段。
 */
function updateFromTimestamp(milliseconds: number, source: 'seconds' | 'millis'): void {
  if (!Number.isFinite(milliseconds)) return
  const date = dayjs(milliseconds)
  if (!date.isValid()) return
  dateText.value = date.format(DATE_FORMAT)
  pickerValue.value = milliseconds
  if (source === 'seconds') millisText.value = Math.trunc(milliseconds).toString()
  if (source === 'millis') secondsText.value = Math.floor(milliseconds / 1000).toString()
}

/**
 * 日期时间选择器变化后同步全部字段。
 */
function onPickerChanged(value: number | null): void {
  if (value !== null) updateAll(value)
}

/**
 * 开关每秒自动更新。
 */
function toggleAutoUpdate(enabled: boolean): void {
  autoUpdate.value = enabled
  if (timer) clearInterval(timer)
  timer = undefined
  if (enabled) {
    updateNow()
    timer = setInterval(updateNow, 1000)
  }
}

updateNow()

/**
 * 组件卸载时停止计时器。
 */
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <ToolPage title="时间转换">
    <template #actions>
      <NButton type="primary" @click="updateNow">
        <template #icon><NIcon :component="Clock3" /></template>
        当前时间
      </NButton>
      <span class="auto-switch"><NSwitch :value="autoUpdate" @update:value="toggleAutoUpdate" />实时更新</span>
    </template>

    <div class="time-form">
      <label class="field-label">日期时间</label>
      <div class="date-row">
        <NInput :value="dateText" placeholder="YYYY-MM-DD HH:mm:ss" @update:value="onDateChanged" />
        <NDatePicker
          :value="pickerValue"
          type="datetime"
          clearable
          @update:value="onPickerChanged"
        />
      </div>

      <label class="field-label">时间戳（秒）</label>
      <NInput :value="secondsText" placeholder="10 位时间戳" @update:value="onSecondsChanged" />

      <label class="field-label">时间戳（毫秒）</label>
      <NInput :value="millisText" placeholder="13 位时间戳" @update:value="onMillisChanged" />
    </div>
  </ToolPage>
</template>

<style scoped>
.time-form {
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

.date-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 220px;
  gap: 10px;
}

.auto-switch {
  display: flex;
  align-items: center;
  gap: 7px;
  white-space: nowrap;
}
</style>
