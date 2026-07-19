<script setup lang="ts">
import dayjs from 'dayjs'
import { reactive, ref, watch } from 'vue'
import { Clipboard, RefreshCw } from '@lucide/vue'
import {
  NButton,
  NIcon,
  NInput,
  NInputNumber,
  NRadio,
  NRadioGroup,
  NSelect,
  NTabPane,
  NTabs,
  useMessage
} from 'naive-ui'
import ToolPage from '../components/ToolPage.vue'
import { copyText } from '../utils/clipboard'
import {
  calculateNextRunTimes,
  createCronFields,
  parseCronExpression,
  stringifyCron,
  stringifyCronField,
  type CronField,
  type CronMode
} from '../utils/cron'

const fields = reactive(createCronFields())
const expression = ref(stringifyCron(fields))
const nextRunTimes = ref<string[]>([])
const error = ref('')
const message = useMessage()

/**
 * 字段变化时更新表达式和未来运行时间。
 */
function updateExpression(): void {
  expression.value = stringifyCron(fields)
  updateNextRunTimes()
}

/**
 * 计算并格式化未来五次运行时间。
 */
function updateNextRunTimes(): void {
  const times = calculateNextRunTimes(fields)
  nextRunTimes.value =
    times.length > 0
      ? times.map((time) => dayjs(time).format('YYYY-MM-DD HH:mm:ss'))
      : ['无法在 100000 秒内找到匹配时间']
}

/**
 * 把输入表达式反解析到七个配置页。
 */
function reverseParse(): void {
  try {
    parseCronExpression(expression.value, fields)
    error.value = ''
    updateExpression()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  }
}

/**
 * 修改字段模式。
 */
function setMode(field: CronField, mode: CronMode): void {
  field.mode = mode
}

/**
 * 安全写入数字字段，忽略输入框暂时为空的状态。
 */
function setNumber(
  field: CronField,
  key: 'rangeStart' | 'rangeEnd' | 'start' | 'interval',
  value: number | null
): void {
  if (value !== null) field[key] = value
}

/**
 * 生成指定值下拉列表，周字段补充星期名称。
 */
function getValueOptions(field: CronField): Array<{ label: string; value: number }> {
  const weekNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  return Array.from({ length: field.max - field.min + 1 }, (_, index) => {
    const value = field.min + index
    return { label: field.isWeek ? `${value}（${weekNames[index]}）` : String(value), value }
  })
}

/**
 * 复制当前表达式。
 */
async function copy(): Promise<void> {
  await copyText(expression.value)
  message.success('已复制')
}

watch(fields, updateExpression, { deep: true })
updateNextRunTimes()
</script>

<template>
  <ToolPage title="Cron 表达式">
    <template #actions>
      <NInput v-model:value="expression" style="width: min(480px, 52vw)" />
      <NButton type="primary" @click="reverseParse">
        <template #icon><NIcon :component="RefreshCw" /></template>
        反解析到界面
      </NButton>
      <NButton circle title="复制表达式" @click="copy">
        <template #icon><NIcon :component="Clipboard" /></template>
      </NButton>
    </template>
    <template #status><span v-if="error" class="error-text">{{ error }}</span></template>

    <div class="cron-layout">
      <section class="cron-editor">
        <NTabs type="segment" animated>
          <NTabPane v-for="field in fields" :key="field.name" :name="field.name" :tab="field.name">
            <NRadioGroup :value="field.mode" class="mode-list" @update:value="setMode(field, $event)">
              <div class="mode-row">
                <NRadio value="every">每{{ field.name }}（通配符）</NRadio>
                <code>{{ field.isWeek ? '?' : '*' }}</code>
              </div>
              <div class="mode-row">
                <NRadio value="range">周期范围</NRadio>
                <NInputNumber
                  :value="field.rangeStart"
                  :min="field.min"
                  :max="field.max"
                  size="small"
                  @update:value="setNumber(field, 'rangeStart', $event)"
                />
                <span>到</span>
                <NInputNumber
                  :value="field.rangeEnd"
                  :min="field.min"
                  :max="field.max"
                  size="small"
                  @update:value="setNumber(field, 'rangeEnd', $event)"
                />
              </div>
              <div class="mode-row">
                <NRadio value="interval">从指定值开始按步长执行</NRadio>
                <NInputNumber
                  :value="field.start"
                  :min="field.min"
                  :max="field.max"
                  size="small"
                  @update:value="setNumber(field, 'start', $event)"
                />
                <span>/</span>
                <NInputNumber
                  :value="field.interval"
                  :min="1"
                  :max="field.max"
                  size="small"
                  @update:value="setNumber(field, 'interval', $event)"
                />
              </div>
              <div class="mode-row specific-row">
                <NRadio value="specific">指定值</NRadio>
                <NSelect
                  v-model:value="field.specificValues"
                  multiple
                  filterable
                  :options="getValueOptions(field)"
                  placeholder="选择一个或多个值"
                />
              </div>
            </NRadioGroup>
          </NTabPane>
        </NTabs>
      </section>

      <aside class="cron-summary">
        <div class="field-grid">
          <div v-for="field in fields" :key="field.name" class="field-token">
            <span>{{ field.name }}</span>
            <code>{{ stringifyCronField(field) }}</code>
          </div>
        </div>
        <h2>未来 5 次运行时间</h2>
        <ol>
          <li v-for="time in nextRunTimes" :key="time">{{ time }}</li>
        </ol>
      </aside>
    </div>
  </ToolPage>
</template>

<style scoped>
.cron-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 310px;
  height: 100%;
  min-height: 0;
  gap: 12px;
}

.cron-editor,
.cron-summary {
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--border-color);
  border-radius: 6px;
}

.cron-editor {
  padding: 12px;
}

.mode-list {
  display: grid;
  gap: 8px;
  padding: 14px 4px;
}

.mode-row {
  display: grid;
  grid-template-columns: minmax(230px, 1fr) 110px 24px 110px;
  align-items: center;
  min-height: 48px;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-color);
}

.specific-row {
  grid-template-columns: minmax(230px, 1fr) minmax(240px, 2fr);
}

.cron-summary {
  padding: 12px;
  background: var(--surface-muted);
}

.field-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}

.field-token {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-width: 0;
  padding: 7px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--surface-color);
}

.field-token span {
  color: var(--text-muted);
  font-size: 11px;
}

.field-token code {
  overflow: hidden;
  text-overflow: ellipsis;
}

.cron-summary h2 {
  margin: 20px 0 8px;
  font-size: 14px;
}

.cron-summary ol {
  margin: 0;
  padding-left: 26px;
  font-family: "Cascadia Mono", Consolas, monospace;
  font-size: 12px;
  line-height: 2;
}
</style>
