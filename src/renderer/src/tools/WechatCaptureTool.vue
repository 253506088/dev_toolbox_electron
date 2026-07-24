<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { Camera, FolderOpen, Maximize2, RefreshCw, Square, WandSparkles } from '@lucide/vue'
import {
  NButton,
  NIcon,
  NInputNumber,
  NModal,
  NProgress,
  NRadioButton,
  NRadioGroup,
  NSelect,
  NSlider,
  NTag,
  useMessage
} from 'naive-ui'
import type { WechatCaptureCrop, WechatCaptureEvent, WechatCaptureMode, WechatWindowSource } from '@shared/wechat-capture'
import CropSelector from '../components/CropSelector.vue'
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
const zoomVisible = ref(false)
const scrollStep = ref(2)
const settleDelayMs = ref(350)
const maxScreens = ref(300)
const frameIntervalMs = ref(100)
const scrollIntervalMs = ref(200)
const maxFrames = ref(5000)
let unsubscribe: (() => void) | undefined

const previewArea = ref<HTMLElement | null>(null)
const previewAreaSize = reactive({ width: 0, height: 0 })
let previewAreaObserver: ResizeObserver | undefined

const selectedWindow = computed(() => windows.value.find((item) => item.id === selectedId.value) ?? null)
const windowOptions = computed(() => windows.value.map((item) => ({ label: item.name, value: item.id })))
const isFinished = computed(() => progress.value?.stage === 'complete' || progress.value?.stage === 'stopped')

/** 按可用区域和窗口宽高比取“contain”最大尺寸，让预览铺满工作区。 */
const previewFitStyle = computed(() => {
  const source = selectedWindow.value
  if (!source || !source.height || previewAreaSize.width < 40 || previewAreaSize.height < 40) return { width: '100%' }
  const aspect = source.width / source.height
  const width = Math.min(previewAreaSize.width, previewAreaSize.height * aspect)
  return { width: `${Math.max(40, Math.floor(width))}px` }
})

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
  applyCrop({ left: 31, top: 9, right: 2, bottom: 25 })
}

/** 预览与放大弹窗共用的选区更新入口，保持与右侧滑块双向同步。 */
function applyCrop(value: WechatCaptureCrop): void {
  Object.assign(crop, value)
}

onMounted(async () => {
  previewAreaObserver = new ResizeObserver((entries) => {
    const rect = entries[0]?.contentRect
    if (!rect) return
    previewAreaSize.width = rect.width
    previewAreaSize.height = rect.height
  })
  watch(
    previewArea,
    (element) => {
      previewAreaObserver?.disconnect()
      if (element) previewAreaObserver?.observe(element)
    },
    { immediate: true }
  )
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

onUnmounted(() => {
  unsubscribe?.()
  previewAreaObserver?.disconnect()
})

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
          <NButton :disabled="!selectedWindow" @click="zoomVisible = true">
            <template #icon><NIcon :component="Maximize2" /></template>
            放大调整
          </NButton>
          <NTag v-if="running" type="warning" :bordered="false">Ctrl+E 停止</NTag>
          <NTag v-else-if="isFinished" type="success" :bordered="false">已保存</NTag>
        </div>

        <div v-if="selectedWindow" ref="previewArea" class="preview-area">
          <CropSelector
            class="window-preview"
            :style="previewFitStyle"
            :crop="crop"
            :image-url="selectedWindow.thumbnailDataUrl"
            :alt="selectedWindow.name"
            :disabled="running"
            :source-width="selectedWindow.width"
            :source-height="selectedWindow.height"
            @update:crop="applyCrop"
          />
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

    <NModal v-model:show="zoomVisible" preset="card" title="放大调整截图区域" class="crop-zoom-modal">
      <p class="zoom-hint">拖动边角或整体拖移调整；在框外拖拽可重新框选。选区与右侧参数实时同步。</p>
      <CropSelector
        v-if="selectedWindow"
        class="zoom-crop"
        :crop="crop"
        :image-url="selectedWindow.thumbnailDataUrl"
        :alt="selectedWindow.name"
        :disabled="running"
        :source-width="selectedWindow.width"
        :source-height="selectedWindow.height"
        @update:crop="applyCrop"
      />
    </NModal>
  </ToolPage>
</template>

<style scoped>
.wechat-capture-layout { display: grid; grid-template-columns: minmax(0, 1fr) 320px; height: 100%; min-height: 0; gap: 16px; }
.capture-workspace { display: flex; flex-direction: column; min-width: 0; min-height: 0; gap: 12px; }
.source-row { display: flex; align-items: center; min-height: 34px; gap: 10px; }
.source-row :deep(.n-select) { min-width: 240px; max-width: 520px; }
.preview-area { display: flex; flex: 1; align-items: center; justify-content: center; min-width: 0; min-height: 0; }
.window-preview { flex: none; }
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
.crop-zoom-modal { width: min(96vw, 1560px); }
.crop-zoom-modal .zoom-hint { margin: 0 0 10px; color: var(--text-muted); font-size: var(--ui-font-sm); }
.crop-zoom-modal .zoom-crop { width: min(100%, 150vh); margin: 0 auto; }
@media (max-width: 1050px) { .wechat-capture-layout { grid-template-columns: 1fr; overflow: auto; } .capture-controls { border-left: 0; border-top: 1px solid var(--border-color); padding: 14px 0; } .preview-area { min-height: 55vh; } }
</style>
