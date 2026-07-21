<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { Camera, FolderOpen, RefreshCw, Square, WandSparkles } from '@lucide/vue'
import {
  NButton,
  NIcon,
  NInputNumber,
  NProgress,
  NRadioButton,
  NRadioGroup,
  NSelect,
  NSlider,
  NTag,
  useMessage
} from 'naive-ui'
import type { WechatCaptureCrop, WechatCaptureEvent, WechatCaptureMode, WechatWindowSource } from '@shared/wechat-capture'
import ToolPage from '../components/ToolPage.vue'

const message = useMessage()
const windows = ref<WechatWindowSource[]>([])
const selectedId = ref<string | null>(null)
const outputDirectory = ref('')
const loadingWindows = ref(false)
const running = ref(false)
const progress = ref<WechatCaptureEvent | null>(null)
const captureMode = ref<WechatCaptureMode>('continuous')
const crop = reactive<WechatCaptureCrop>({ left: 31, top: 9, right: 2, bottom: 25 })
const scrollStep = ref(2)
const settleDelayMs = ref(350)
const maxScreens = ref(300)
const frameIntervalMs = ref(100)
const scrollIntervalMs = ref(300)
const maxFrames = ref(5000)
let unsubscribe: (() => void) | undefined
let selectionDrag: { x: number; y: number; initial: WechatCaptureCrop } | null = null

const selectedWindow = computed(() => windows.value.find((item) => item.id === selectedId.value) ?? null)
const windowOptions = computed(() => windows.value.map((item) => ({ label: item.name, value: item.id })))
const cropStyle = computed(() => ({
  left: `${crop.left}%`,
  top: `${crop.top}%`,
  right: `${crop.right}%`,
  bottom: `${crop.bottom}%`
}))
const previewAspect = computed(() => selectedWindow.value
  ? `${selectedWindow.value.width} / ${selectedWindow.value.height}`
  : '16 / 10')
const isFinished = computed(() => progress.value?.stage === 'complete' || progress.value?.stage === 'stopped')

/** 刷新桌面窗口并优先选中第一个微信窗口。 */
async function refreshWindows(): Promise<void> {
  loadingWindows.value = true
  try {
    windows.value = await window.electronApi.wechatCapture.listWindows()
    if (!windows.value.some((item) => item.id === selectedId.value)) selectedId.value = windows.value[0]?.id ?? null
    if (windows.value.length === 0) message.warning('没有找到可抓取的桌面窗口')
  } catch (error) {
    message.error(formatError(error))
  } finally {
    loadingWindows.value = false
  }
}

/** 切换输出根目录。每次抓取仍会在其中新建带时间的子目录。 */
async function chooseOutputDirectory(): Promise<void> {
  const path = await window.electronApi.wechatCapture.selectOutputDirectory()
  if (path) outputDirectory.value = path
}

/** 用当前窗口、截图区域和滚动参数启动任务。 */
async function startCapture(): Promise<void> {
  if (!selectedWindow.value || running.value) return
  running.value = true
  progress.value = { runId: '', stage: 'positioning', message: '正在启动...', screenCount: 0 }
  try {
    const common = {
      sourceId: selectedWindow.value.id,
      sourceName: selectedWindow.value.name,
      outputDirectory: outputDirectory.value,
      crop: { ...crop }
    }
    const result = captureMode.value === 'continuous'
      ? await window.electronApi.wechatCapture.startContinuous({
          ...common,
          frameIntervalMs: frameIntervalMs.value,
          scrollIntervalMs: scrollIntervalMs.value,
          maxFrames: maxFrames.value
        })
      : await window.electronApi.wechatCapture.start({
          ...common,
          scrollStep: scrollStep.value,
          settleDelayMs: settleDelayMs.value,
          maxScreens: maxScreens.value
        })
    if (progress.value) {
      progress.value.runId = result.runId
      progress.value.outputDirectory = result.outputDirectory
    }
  } catch (error) {
    running.value = false
    message.error(formatError(error))
  }
}

/** 停止自动滚动，主进程仍会把已有分屏生成长图和 Markdown。 */
async function stopCapture(): Promise<void> {
  await window.electronApi.wechatCapture.stop()
  if (progress.value) progress.value.message = '正在停止并保存...'
}

function openOutput(): void {
  const path = progress.value?.outputDirectory || outputDirectory.value
  if (path) void window.electronApi.wechatCapture.openOutput(path)
}

function resetCrop(): void {
  Object.assign(crop, { left: 31, top: 9, right: 2, bottom: 25 })
}

/** 在窗口预览上直接拖出新的聊天记录区域。 */
function startSelection(event: PointerEvent): void {
  if (running.value || event.button !== 0) return
  const point = previewPoint(event)
  selectionDrag = { ...point, initial: { ...crop } }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

function updateSelection(event: PointerEvent): void {
  if (!selectionDrag || running.value) return
  const point = previewPoint(event)
  const left = Math.min(selectionDrag.x, point.x)
  const top = Math.min(selectionDrag.y, point.y)
  const width = Math.abs(point.x - selectionDrag.x)
  const height = Math.abs(point.y - selectionDrag.y)
  if (width < 2 || height < 2) return
  Object.assign(crop, {
    left: roundPercent(left),
    top: roundPercent(top),
    right: roundPercent(100 - left - width),
    bottom: roundPercent(100 - top - height)
  })
}

function finishSelection(event: PointerEvent): void {
  if (!selectionDrag) return
  const initial = selectionDrag.initial
  const point = previewPoint(event)
  const width = Math.abs(point.x - selectionDrag.x)
  const height = Math.abs(point.y - selectionDrag.y)
  if (width < 5 || height < 5) Object.assign(crop, initial)
  else updateSelection(event)
  selectionDrag = null
  const target = event.currentTarget as HTMLElement
  if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
}

function previewPoint(event: PointerEvent): { x: number; y: number } {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  return {
    x: Math.min(100, Math.max(0, (event.clientX - rect.left) / rect.width * 100)),
    y: Math.min(100, Math.max(0, (event.clientY - rect.top) / rect.height * 100))
  }
}

function roundPercent(value: number): number {
  return Math.round(value * 10) / 10
}

onMounted(async () => {
  unsubscribe = window.electronApi.wechatCapture.onEvent((event) => {
    progress.value = event
    running.value = !['complete', 'stopped', 'error'].includes(event.stage)
    if (event.stage === 'complete') message.success('微信聊天记录截图已完成')
    if (event.stage === 'stopped') message.info('截图已停止，已有内容已保存')
    if (event.stage === 'error') message.error(event.message)
  })
  outputDirectory.value = await window.electronApi.wechatCapture.defaultOutputDirectory()
  await refreshWindows()
})

onUnmounted(() => unsubscribe?.())

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
</script>

<template>
  <ToolPage title="微信聊天长截图">
    <template #actions>
      <NRadioGroup v-model:value="captureMode" size="small" :disabled="running">
        <NRadioButton value="paged">逐屏截图</NRadioButton>
        <NRadioButton value="continuous">连续长截图</NRadioButton>
      </NRadioGroup>
      <NButton :loading="loadingWindows" :disabled="running" @click="refreshWindows">
        <template #icon><NIcon :component="RefreshCw" /></template>
        刷新窗口
      </NButton>
      <NButton v-if="!running" type="primary" :disabled="!selectedWindow" @click="startCapture">
        <template #icon><NIcon :component="Camera" /></template>
        开始截图
      </NButton>
      <NButton v-else type="error" @click="stopCapture">
        <template #icon><NIcon :component="Square" /></template>
        停止
      </NButton>
    </template>

    <div class="wechat-capture-layout">
      <section class="capture-workspace">
        <div class="source-row">
          <NSelect
            v-model:value="selectedId"
            :options="windowOptions"
            :disabled="running"
            placeholder="选择微信窗口"
          />
          <NTag v-if="running" type="warning" :bordered="false">Ctrl+E 停止</NTag>
          <NTag v-else-if="isFinished" type="success" :bordered="false">已保存</NTag>
        </div>

        <div
          v-if="selectedWindow"
          class="window-preview"
          :class="{ disabled: running }"
          :style="{ aspectRatio: previewAspect }"
          aria-label="拖拽选择聊天记录截图区域"
          @pointerdown="startSelection"
          @pointermove="updateSelection"
          @pointerup="finishSelection"
          @pointercancel="finishSelection"
        >
          <img :src="selectedWindow.thumbnailDataUrl" :alt="selectedWindow.name" draggable="false" />
          <div class="crop-mask crop-mask-top" :style="{ height: `${crop.top}%` }" />
          <div class="crop-mask crop-mask-bottom" :style="{ height: `${crop.bottom}%` }" />
          <div class="crop-mask crop-mask-left" :style="{ top: `${crop.top}%`, bottom: `${crop.bottom}%`, width: `${crop.left}%` }" />
          <div class="crop-mask crop-mask-right" :style="{ top: `${crop.top}%`, bottom: `${crop.bottom}%`, width: `${crop.right}%` }" />
          <div class="crop-outline" :style="cropStyle">
            <span>聊天记录区域</span>
            <i class="handle handle-nw" /><i class="handle handle-ne" />
            <i class="handle handle-sw" /><i class="handle handle-se" />
          </div>
        </div>
        <div v-else class="empty-preview">请打开微信聊天窗口后刷新</div>

        <section class="capture-status" :class="{ visible: progress }" aria-live="polite">
          <div>
            <strong>{{ progress?.message || '等待开始' }}</strong>
            <span v-if="captureMode === 'continuous'">{{ (progress?.capturedHeight ?? 0).toLocaleString('zh-CN') }} px</span>
            <span v-else>{{ progress?.screenCount ?? 0 }} 屏</span>
          </div>
          <NProgress
            v-if="running"
            type="line"
            processing
            :percentage="100"
            :show-indicator="false"
            :height="4"
          />
          <img v-if="progress?.previewDataUrl" :src="progress.previewDataUrl" alt="最新截图" />
        </section>
      </section>

      <aside class="capture-controls">
        <div class="control-heading">
          <h2>截图区域</h2>
          <NButton quaternary circle :disabled="running" title="恢复推荐区域" @click="resetCrop">
            <template #icon><NIcon :component="WandSparkles" /></template>
          </NButton>
        </div>
        <label>左侧裁掉 {{ crop.left }}%</label>
        <NSlider v-model:value="crop.left" :min="0" :max="60" :disabled="running" />
        <label>顶部裁掉 {{ crop.top }}%</label>
        <NSlider v-model:value="crop.top" :min="0" :max="40" :disabled="running" />
        <label>右侧裁掉 {{ crop.right }}%</label>
        <NSlider v-model:value="crop.right" :min="0" :max="40" :disabled="running" />
        <label>底部裁掉 {{ crop.bottom }}%</label>
        <NSlider v-model:value="crop.bottom" :min="0" :max="50" :disabled="running" />

        <div class="control-divider" />
        <h2>{{ captureMode === 'continuous' ? '连续采集参数' : '抓取参数' }}</h2>
        <template v-if="captureMode === 'continuous'">
          <div class="number-grid">
            <label>采样间隔<NInputNumber v-model:value="frameIntervalMs" :min="80" :max="1000" :step="20" :disabled="running" /></label>
            <label>滚动间隔<NInputNumber v-model:value="scrollIntervalMs" :min="160" :max="2000" :step="20" :disabled="running" /></label>
          </div>
          <label>最多采样帧数<NInputNumber v-model:value="maxFrames" :min="20" :max="20000" :step="100" :disabled="running" /></label>
        </template>
        <template v-else>
          <div class="number-grid">
            <label>滚动格数<NInputNumber v-model:value="scrollStep" :min="1" :max="3" :disabled="running" /></label>
            <label>等待毫秒<NInputNumber v-model:value="settleDelayMs" :min="200" :max="5000" :step="50" :disabled="running" /></label>
          </div>
          <label>最多分屏数<NInputNumber v-model:value="maxScreens" :min="2" :max="1000" :disabled="running" /></label>
        </template>

        <div class="control-divider" />
        <h2>输出目录</h2>
        <button class="path-button" :disabled="running" :title="outputDirectory" @click="chooseOutputDirectory">
          <FolderOpen :size="17" />
          <span>{{ outputDirectory }}</span>
        </button>
        <NButton :disabled="!(progress?.outputDirectory || outputDirectory)" @click="openOutput">
          <template #icon><NIcon :component="FolderOpen" /></template>
          打开输出目录
        </NButton>
      </aside>
    </div>
  </ToolPage>
</template>

<style scoped>
.wechat-capture-layout { display: grid; grid-template-columns: minmax(0, 1fr) 320px; height: 100%; min-height: 0; gap: 16px; }
.capture-workspace { display: flex; flex-direction: column; min-width: 0; min-height: 0; gap: 12px; }
.source-row { display: flex; align-items: center; min-height: 34px; gap: 10px; }
.source-row :deep(.n-select) { min-width: 240px; max-width: 520px; }
.window-preview { position: relative; width: min(100%, 1100px); max-height: calc(100% - 128px); margin: auto; overflow: hidden; border: 1px solid var(--border-color); border-radius: 5px; background: #17191c; cursor: crosshair; touch-action: none; user-select: none; }
.window-preview.disabled { cursor: not-allowed; }
.window-preview img { display: block; width: 100%; height: 100%; object-fit: fill; pointer-events: none; user-select: none; }
.crop-mask { position: absolute; z-index: 1; background: rgb(8 10 12 / 62%); pointer-events: none; }
.crop-mask-top { inset: 0 0 auto; }
.crop-mask-bottom { inset: auto 0 0; }
.crop-mask-left { left: 0; }
.crop-mask-right { right: 0; }
.crop-outline { position: absolute; z-index: 2; border: 2px solid #18a058; box-shadow: inset 0 0 0 1px rgb(255 255 255 / 50%); pointer-events: none; }
.crop-outline span { position: absolute; top: 6px; left: 7px; padding: 3px 6px; border-radius: 3px; color: #fff; background: #168653; font-size: var(--ui-font-xs); }
.handle { position: absolute; width: 9px; height: 9px; border: 1px solid #fff; background: #18a058; }
.handle-nw { top: -5px; left: -5px; }
.handle-ne { top: -5px; right: -5px; }
.handle-sw { bottom: -5px; left: -5px; }
.handle-se { right: -5px; bottom: -5px; }
.empty-preview { display: grid; flex: 1; place-items: center; min-height: 300px; color: var(--text-muted); border: 1px dashed var(--border-color); border-radius: 5px; }
.capture-status { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; min-height: 54px; gap: 10px; padding-top: 10px; border-top: 1px solid var(--border-color); }
.capture-status > div { display: flex; justify-content: space-between; gap: 16px; }
.capture-status strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.capture-status span { flex: none; color: var(--text-muted); }
.capture-status :deep(.n-progress) { grid-column: 1 / -1; }
.capture-status > img { width: 56px; height: 40px; object-fit: cover; border: 1px solid var(--border-color); border-radius: 3px; }
.capture-controls { display: flex; flex-direction: column; min-width: 0; gap: 9px; overflow: auto; padding: 2px 2px 14px 16px; border-left: 1px solid var(--border-color); }
.capture-controls h2 { margin: 0; font-size: var(--ui-font-lg); }
.capture-controls > label, .number-grid label { display: flex; flex-direction: column; gap: 5px; color: var(--text-muted); font-size: var(--ui-font-sm); font-weight: 700; }
.control-heading { display: flex; align-items: center; justify-content: space-between; }
.control-divider { height: 1px; margin: 5px 0; background: var(--border-color); }
.number-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.path-button { display: flex; align-items: center; width: 100%; min-height: 36px; gap: 8px; padding: 6px 10px; border: 1px solid var(--border-color); border-radius: 4px; color: var(--text-color); background: transparent; cursor: pointer; }
.path-button:hover:not(:disabled) { border-color: var(--accent-color); }
.path-button:disabled { cursor: not-allowed; opacity: .55; }
.path-button span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 1050px) { .wechat-capture-layout { grid-template-columns: 1fr; overflow: auto; } .capture-controls { border-left: 0; border-top: 1px solid var(--border-color); padding: 14px 0; } .window-preview { max-height: none; } }
</style>
