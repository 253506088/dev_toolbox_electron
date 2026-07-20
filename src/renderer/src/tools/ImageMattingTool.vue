<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { FolderOpen, ImagePlus, Pipette, Play, RotateCcw, Trash2 } from '@lucide/vue'
import { NButton, NColorPicker, NIcon, NInputNumber, NSlider, NSwitch, useMessage } from 'naive-ui'
import type { BatchTaskSnapshot } from '@shared/batch-task'
import type { ImageMattingOptions, ImageMetadata, RgbColor } from '@shared/media-api'
import ToolPage from '../components/ToolPage.vue'
import MediaDropZone from '../components/MediaDropZone.vue'
import BatchTaskQueue from '../components/BatchTaskQueue.vue'

const message = useMessage()
const images = ref<ImageMetadata[]>([])
const selectedIndex = ref(0)
const thresholdOffset = ref(20)
const feather = ref(12)
const automaticBackground = ref(true)
const backgroundHex = ref('#ffffff')
const detectedBackground = ref<RgbColor | null>(null)
const pickingColor = ref(false)
const preview = ref('')
const previewing = ref(false)
const outputDirectory = ref('')
const batch = ref<BatchTaskSnapshot | null>(null)
let previewTimer: ReturnType<typeof setTimeout> | undefined
let previewVersion = 0
let unsubscribeBatch: (() => void) | undefined

const selected = computed(() => images.value[selectedIndex.value] ?? null)
const options = computed<ImageMattingOptions>(() => ({
  thresholdOffset: thresholdOffset.value,
  feather: feather.value,
  background: automaticBackground.value ? undefined : hexToRgb(backgroundHex.value)
}))
const batchRunning = computed(() => Boolean(batch.value?.items.some((item) => item.status === 'queued' || item.status === 'running')))

/** 参数或预览图变化时防抖刷新实时结果。 */
watch([selected, thresholdOffset, feather, automaticBackground, backgroundHex], () => schedulePreview())

/** 通过系统对话框导入多张图片。 */
async function chooseImages(): Promise<void> {
  try {
    addImages(await window.electronApi.media.selectImages(true))
  } catch (error) {
    message.error(formatError(error))
  }
}

/** 注册拖入图片。 */
async function addDropped(paths: string[]): Promise<void> {
  try {
    addImages(await window.electronApi.media.registerImages(paths))
  } catch (error) {
    message.error(formatError(error))
  }
}

/** 合并图片并选择新加入的第一张。 */
function addImages(items: ImageMetadata[]): void {
  if (items.length === 0) return
  const start = images.value.length
  images.value = [...images.value, ...items].filter((item, index, list) => list.findIndex((other) => other.path === item.path) === index)
  selectedIndex.value = Math.min(start, images.value.length - 1)
  preview.value = ''
}

/** 延迟 180 毫秒执行预览，只保留最后一次参数。 */
function schedulePreview(): void {
  if (previewTimer) clearTimeout(previewTimer)
  previewTimer = setTimeout(() => void refreshPreview(), 180)
}

/** 请求主进程生成同算法的小图预览。 */
async function refreshPreview(): Promise<void> {
  const image = selected.value
  if (!image) return
  const version = ++previewVersion
  previewing.value = true
  try {
    const result = await window.electronApi.media.previewMatting(image.path, options.value)
    if (version !== previewVersion) return
    preview.value = result.dataUrl
    detectedBackground.value = result.background ?? null
  } catch (error) {
    if (version === previewVersion) message.error(`预览失败：${formatError(error)}`)
  } finally {
    if (version === previewVersion) previewing.value = false
  }
}

/** 在原图上点击并把对应像素设置成手动背景色。 */
function pickPixel(event: MouseEvent): void {
  if (!pickingColor.value || !selected.value) return
  const target = event.currentTarget as HTMLImageElement
  const bounds = target.getBoundingClientRect()
  const canvas = document.createElement('canvas')
  canvas.width = target.naturalWidth
  canvas.height = target.naturalHeight
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return
  context.drawImage(target, 0, 0)
  const x = Math.max(0, Math.min(canvas.width - 1, Math.round((event.clientX - bounds.left) / bounds.width * canvas.width)))
  const y = Math.max(0, Math.min(canvas.height - 1, Math.round((event.clientY - bounds.top) / bounds.height * canvas.height)))
  const pixel = context.getImageData(x, y, 1, 1).data
  backgroundHex.value = rgbToHex({ r: pixel[0], g: pixel[1], b: pixel[2] })
  automaticBackground.value = false
  pickingColor.value = false
  message.success(`已取色 ${backgroundHex.value.toUpperCase()}`)
}

/** 选择批量输出目录。 */
async function chooseOutputDirectory(): Promise<void> {
  outputDirectory.value = await window.electronApi.media.selectDirectory() ?? outputDirectory.value
}

/** 使用当前参数快照启动批量抠图。 */
async function startBatch(): Promise<void> {
  if (images.value.length === 0 || !outputDirectory.value || batchRunning.value) return
  try {
    batch.value = await window.electronApi.media.startImageBatch({
      kind: 'image-matting', inputPaths: images.value.map((item) => item.path), outputDirectory: outputDirectory.value, matting: options.value
    })
  } catch (error) {
    message.error(formatError(error))
  }
}

/** 重置抠图参数为原版默认值。 */
function resetOptions(): void {
  thresholdOffset.value = 20
  feather.value = 12
  automaticBackground.value = true
  backgroundHex.value = '#ffffff'
}

/** 清空图片和批量队列显示。 */
function clearAll(): void {
  images.value = []
  preview.value = ''
  batch.value = null
}

/** 打开输出文件所在目录。 */
function openOutput(filePath: string): void {
  void window.electronApi.files.openInExplorer(filePath.replace(/[\\/][^\\/]+$/, ''))
}

/** 取消当前批量抠图任务。 */
function cancelBatch(): void {
  if (batch.value) void window.electronApi.media.cancelBatch(batch.value.batchId)
}

/** 重试一个失败或取消的抠图项。 */
function retryBatchItem(itemId: string): void {
  if (batch.value) void window.electronApi.media.retryBatchItem(batch.value.batchId, itemId)
}

/** 订阅批量任务事件。 */
onMounted(() => {
  unsubscribeBatch = window.electronApi.media.onBatchEvent((event) => {
    if (!batch.value || event.batchId !== batch.value.batchId) return
    const index = batch.value.items.findIndex((item) => item.id === event.item.id)
    if (index >= 0) batch.value.items[index] = event.item
    batch.value.summary = event.summary
  })
})

/** 页面销毁时清理定时器和 IPC 监听。 */
onUnmounted(() => {
  if (previewTimer) clearTimeout(previewTimer)
  unsubscribeBatch?.()
})

/** 把十六进制颜色转成 RGB。 */
function hexToRgb(hex: string): RgbColor {
  const value = hex.replace('#', '').slice(0, 6).padEnd(6, '0')
  return { r: Number.parseInt(value.slice(0, 2), 16), g: Number.parseInt(value.slice(2, 4), 16), b: Number.parseInt(value.slice(4, 6), 16) }
}

/** 把 RGB 颜色转成十六进制文字。 */
function rgbToHex(color: RgbColor): string {
  return `#${[color.r, color.g, color.b].map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

/** 把未知异常转换成可读文字。 */
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
</script>

<template>
  <ToolPage title="批量抠图">
    <template #actions>
      <NButton @click="chooseImages"><template #icon><NIcon :component="ImagePlus" /></template>添加图片</NButton>
      <NButton :disabled="!selected" :type="pickingColor ? 'primary' : 'default'" @click="pickingColor = !pickingColor"><template #icon><NIcon :component="Pipette" /></template>吸管取色</NButton>
      <NButton secondary @click="resetOptions"><template #icon><NIcon :component="RotateCcw" /></template>重置参数</NButton>
      <NButton secondary @click="clearAll"><template #icon><NIcon :component="Trash2" /></template>清空</NButton>
    </template>
    <div class="matting-layout">
      <section class="matting-workspace">
        <MediaDropZone v-if="!selected" accept="image" multiple @select="chooseImages" @files="addDropped" />
        <div v-else class="matting-preview-grid">
          <div class="matting-preview-panel checkerboard">
            <img :src="selected.previewUrl" alt="原图" :class="{ picking: pickingColor }" @click="pickPixel" />
            <span>原图 · {{ selected.name }}</span>
          </div>
          <div class="matting-preview-panel checkerboard">
            <img v-if="preview" :src="preview" alt="抠图实时预览" />
            <em v-else>正在准备预览</em>
            <span>{{ previewing ? '正在计算…' : '实时结果' }}</span>
          </div>
        </div>
        <div v-if="images.length > 1" class="sample-strip">
          <button v-for="(image, index) in images" :key="image.path" :class="{ active: index === selectedIndex }" :title="image.name" @click="selectedIndex = index">
            <img :src="image.previewUrl" alt="" /><span>{{ image.name }}</span>
          </button>
        </div>
        <BatchTaskQueue class="queue-host" :snapshot="batch" @cancel="cancelBatch" @retry="retryBatchItem" @open-output="openOutput" />
      </section>
      <aside class="matting-controls">
        <h2>抠图参数</h2>
        <div class="switch-row"><span>自动检测背景色</span><NSwitch v-model:value="automaticBackground" /></div>
        <template v-if="!automaticBackground">
          <label>手动背景色</label><NColorPicker v-model:value="backgroundHex" :show-alpha="false" />
        </template>
        <p v-else>检测结果：{{ detectedBackground ? rgbToHex(detectedBackground).toUpperCase() : '等待预览' }}</p>
        <label>阈值偏移：{{ thresholdOffset }}</label>
        <NSlider v-model:value="thresholdOffset" :min="-100" :max="100" :step="1" />
        <NInputNumber v-model:value="thresholdOffset" :min="-200" :max="200" />
        <label>边缘羽化：{{ feather }}</label>
        <NSlider v-model:value="feather" :min="0" :max="80" :step="1" />
        <NInputNumber v-model:value="feather" :min="0" :max="80" />
        <NButton @click="chooseOutputDirectory"><template #icon><NIcon :component="FolderOpen" /></template>{{ outputDirectory || '选择输出目录' }}</NButton>
        <NButton type="primary" :disabled="images.length === 0 || !outputDirectory || batchRunning" @click="startBatch"><template #icon><NIcon :component="Play" /></template>开始批量抠图</NButton>
        <small>当前 {{ images.length }} 张；批量任务使用点击开始时的参数，不覆盖原文件。</small>
      </aside>
    </div>
  </ToolPage>
</template>

<style scoped>
.matting-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(280px, 330px); height: 100%; min-height: 0; gap: 14px; }
.matting-workspace { display: flex; flex-direction: column; min-width: 0; min-height: 0; gap: 10px; }
.matting-preview-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); min-height: 250px; flex: 1; gap: 10px; }
.matting-preview-panel { position: relative; display: grid; place-items: center; min-width: 0; overflow: hidden; border: 1px solid var(--border-color); border-radius: 5px; }
.matting-preview-panel img { display: block; max-width: 100%; max-height: 100%; object-fit: contain; }
.matting-preview-panel img.picking { cursor: crosshair; }
.matting-preview-panel em { color: var(--checker-text); font-style: normal; }
.matting-preview-panel > span { position: absolute; top: 8px; right: 8px; max-width: calc(100% - 16px); overflow: hidden; padding: 4px 7px; color: #fff; border-radius: 3px; background: rgb(0 0 0 / 65%); white-space: nowrap; text-overflow: ellipsis; }
.checkerboard { background-color: var(--checker-light); background-image: linear-gradient(45deg,var(--checker-dark) 25%,transparent 25%),linear-gradient(-45deg,var(--checker-dark) 25%,transparent 25%),linear-gradient(45deg,transparent 75%,var(--checker-dark) 75%),linear-gradient(-45deg,transparent 75%,var(--checker-dark) 75%); background-size: 20px 20px; background-position: 0 0,0 10px,10px -10px,-10px 0; }
.sample-strip { display: flex; flex: 0 0 66px; gap: 7px; overflow-x: auto; }
.sample-strip button { display: grid; grid-template-columns: 48px minmax(70px, 130px); align-items: center; gap: 6px; padding: 4px; color: var(--text-color); border: 1px solid var(--border-color); border-radius: 4px; background: var(--surface-color); cursor: pointer; }
.sample-strip button.active { border-color: var(--accent-color); background: var(--active-background); }
.sample-strip img { width: 48px; height: 48px; object-fit: contain; }
.sample-strip span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.matting-controls { display: flex; flex-direction: column; min-width: 0; gap: 10px; overflow: auto; padding: 14px; border-left: 1px solid var(--border-color); }
.matting-controls h2 { margin: 0; font-size: var(--ui-font-lg); }
.matting-controls label { color: var(--text-muted); font-weight: 700; font-size: var(--ui-font-sm); }
.matting-controls p, .matting-controls small { margin: 0; color: var(--text-muted); overflow-wrap: anywhere; }
.switch-row { display: flex; align-items: center; justify-content: space-between; }
.queue-host { flex: 0 1 230px; }
@media (max-width: 1050px) { .matting-layout { grid-template-columns: 1fr; overflow: auto; } .matting-controls { border-left: 0; border-top: 1px solid var(--border-color); } }
@media (max-width: 720px) { .matting-preview-grid { grid-template-columns: 1fr; } }
</style>
