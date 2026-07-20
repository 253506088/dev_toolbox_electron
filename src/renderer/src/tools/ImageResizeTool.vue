<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ClipboardPaste, Copy, Download, FolderOpen, ImagePlus, Play, Trash2 } from '@lucide/vue'
import { NButton, NButtonGroup, NIcon, NInputNumber, NRadioButton, NRadioGroup, NSpin, useMessage } from 'naive-ui'
import type { BatchTaskSnapshot } from '@shared/batch-task'
import type { ImageMetadata, ImageResizeOptions } from '@shared/media-api'
import ToolPage from '../components/ToolPage.vue'
import MediaDropZone from '../components/MediaDropZone.vue'
import BatchTaskQueue from '../components/BatchTaskQueue.vue'

const message = useMessage()
const mode = ref<'single' | 'batch'>('single')
const images = ref<ImageMetadata[]>([])
const selectedIndex = ref(0)
const width = ref(800)
const height = ref(800)
const percent = ref(100)
const fit = ref<'cover' | 'contain'>('cover')
const preview = ref('')
const processing = ref(false)
const outputDirectory = ref('')
const batch = ref<BatchTaskSnapshot | null>(null)
let unsubscribeBatch: (() => void) | undefined

const selected = computed(() => images.value[selectedIndex.value] ?? null)
const options = computed<ImageResizeOptions>(() => ({ width: width.value, height: height.value, fit: fit.value }))
const canBatch = computed(() => images.value.length > 0 && Boolean(outputDirectory.value) && !batch.value?.items.some((item) => item.status === 'queued' || item.status === 'running'))

/** 通过系统对话框导入图片。 */
async function chooseImages(): Promise<void> {
  try {
    const selectedFiles = await window.electronApi.media.selectImages(mode.value === 'batch')
    applyImages(selectedFiles, mode.value === 'batch')
  } catch (error) {
    message.error(formatError(error))
  }
}

/** 注册拖入图片并加入当前模式。 */
async function addDropped(paths: string[]): Promise<void> {
  try {
    const selectedFiles = await window.electronApi.media.registerImages(paths)
    applyImages(selectedFiles, mode.value === 'batch')
  } catch (error) {
    message.error(formatError(error))
  }
}

/** 合并图片列表，并用首张图片初始化尺寸。 */
function applyImages(selectedFiles: ImageMetadata[], append: boolean): void {
  if (selectedFiles.length === 0) return
  const merged = append ? [...images.value, ...selectedFiles] : selectedFiles
  images.value = merged.filter((item, index, list) => list.findIndex((other) => other.path === item.path) === index)
  selectedIndex.value = append ? Math.max(0, images.value.length - selectedFiles.length) : 0
  resetSizeFromSelected()
}

/** 从剪贴板读取单图，并取得浏览器解码后的尺寸。 */
async function pasteImage(): Promise<void> {
  const dataUrl = await window.electronApi.clipboard.readImage()
  if (!dataUrl) {
    message.warning('剪贴板中没有图片')
    return
  }
  const size = await readImageSize(dataUrl)
  images.value = [{ path: dataUrl, name: '剪贴板图片.png', width: size.width, height: size.height, format: 'png', size: 0, previewUrl: dataUrl }]
  selectedIndex.value = 0
  resetSizeFromSelected()
}

/** 按当前图片原始尺寸重置参数。 */
function resetSizeFromSelected(): void {
  const image = selected.value
  if (!image) return
  width.value = image.width
  height.value = image.height
  percent.value = 100
  preview.value = ''
}

/** 用百分比同时更新目标宽高。 */
function applyPercent(value: number | null): void {
  const image = selected.value
  if (!image || value === null || value <= 0) return
  percent.value = value
  width.value = Math.max(1, Math.round(image.width * value / 100))
  height.value = Math.max(1, Math.round(image.height * value / 100))
}

/** 生成当前单图的缩放裁剪预览。 */
async function processPreview(): Promise<void> {
  if (!selected.value) return
  processing.value = true
  try {
    preview.value = (await window.electronApi.media.previewResize(selected.value.path, options.value)).dataUrl
    message.success('图片处理完成')
  } catch (error) {
    message.error(formatError(error))
  } finally {
    processing.value = false
  }
}

/** 保存当前 PNG 结果。 */
async function savePreview(): Promise<void> {
  if (preview.value && await window.electronApi.media.saveDataUrl(`${fileStem(selected.value?.name ?? '图片')}_缩放.png`, preview.value)) message.success('图片已保存')
}

/** 把当前结果写入系统剪贴板。 */
async function copyPreview(): Promise<void> {
  if (!preview.value) return
  await window.electronApi.clipboard.writeImage(preview.value)
  message.success('图片已复制')
}

/** 选择批量输出目录。 */
async function chooseOutputDirectory(): Promise<void> {
  outputDirectory.value = await window.electronApi.media.selectDirectory() ?? outputDirectory.value
}

/** 按参数快照启动整批缩放任务。 */
async function startBatch(): Promise<void> {
  if (!canBatch.value) return
  try {
    batch.value = await window.electronApi.media.startImageBatch({
      kind: 'image-resize', inputPaths: images.value.map((item) => item.path), outputDirectory: outputDirectory.value, resize: options.value
    })
  } catch (error) {
    message.error(formatError(error))
  }
}

/** 清空当前图片和任务显示。 */
function clearAll(): void {
  images.value = []
  preview.value = ''
  batch.value = null
}

/** 打开任务输出文件所在目录。 */
function openOutput(filePath: string): void {
  void window.electronApi.files.openInExplorer(directoryName(filePath))
}

/** 取消当前批量任务。 */
function cancelBatch(): void {
  if (batch.value) void window.electronApi.media.cancelBatch(batch.value.batchId)
}

/** 重试当前批次中的一个单项。 */
function retryBatchItem(itemId: string): void {
  if (batch.value) void window.electronApi.media.retryBatchItem(batch.value.batchId, itemId)
}

/** 订阅当前批次的单项状态变化。 */
onMounted(() => {
  unsubscribeBatch = window.electronApi.media.onBatchEvent((event) => {
    if (!batch.value || event.batchId !== batch.value.batchId) return
    const index = batch.value.items.findIndex((item) => item.id === event.item.id)
    if (index >= 0) batch.value.items[index] = event.item
    batch.value.summary = event.summary
  })
})

/** 页面销毁时释放 IPC 监听。 */
onUnmounted(() => unsubscribeBatch?.())

/** 解码 data URL 图片尺寸。 */
function readImageSize(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
    image.onerror = () => reject(new Error('无法读取剪贴板图片'))
    image.src = dataUrl
  })
}

/** 提取文件名中不带扩展名的部分。 */
function fileStem(name: string): string {
  return name.replace(/\.[^.]+$/, '')
}

/** 提取 Windows 或 Unix 路径中的目录部分。 */
function directoryName(path: string): string {
  return path.replace(/[\\/][^\\/]+$/, '')
}

/** 把未知异常转换成中文可读信息。 */
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
</script>

<template>
  <ToolPage title="图片缩放裁剪">
    <template #actions>
      <NRadioGroup v-model:value="mode" size="small">
        <NRadioButton value="single">单图</NRadioButton>
        <NRadioButton value="batch">批量</NRadioButton>
      </NRadioGroup>
      <NButton @click="chooseImages"><template #icon><NIcon :component="ImagePlus" /></template>选择图片</NButton>
      <NButton v-if="mode === 'single'" @click="pasteImage"><template #icon><NIcon :component="ClipboardPaste" /></template>粘贴</NButton>
      <NButton secondary @click="clearAll"><template #icon><NIcon :component="Trash2" /></template>清空</NButton>
    </template>
    <div class="image-tool-layout">
      <section class="image-workspace">
        <MediaDropZone v-if="!selected" accept="image" :multiple="mode === 'batch'" @select="chooseImages" @files="addDropped" />
        <div v-else class="image-preview-grid">
          <div class="image-preview-panel checkerboard">
            <img :src="selected.previewUrl" alt="原图" />
            <span>原图 {{ selected.width }}×{{ selected.height }}</span>
          </div>
          <div class="image-preview-panel checkerboard">
            <NSpin :show="processing"><img v-if="preview" :src="preview" alt="缩放结果" /><em v-else>处理结果</em></NSpin>
            <span>目标 {{ width }}×{{ height }}</span>
          </div>
        </div>
        <BatchTaskQueue v-if="mode === 'batch'" class="queue-host" :snapshot="batch" @cancel="cancelBatch" @retry="retryBatchItem" @open-output="openOutput" />
      </section>
      <aside class="image-controls">
        <h2>处理参数</h2>
        <label>缩放比例</label>
        <NInputNumber :value="percent" :min="1" :max="1000" :precision="1" @update:value="applyPercent" /><span class="unit">%</span>
        <div class="dimension-row">
          <label>目标宽度<NInputNumber v-model:value="width" :min="1" :max="20000" /></label>
          <span>×</span>
          <label>目标高度<NInputNumber v-model:value="height" :min="1" :max="20000" /></label>
        </div>
        <label>缩放方式</label>
        <NButtonGroup>
          <NButton :type="fit === 'cover' ? 'primary' : 'default'" @click="fit = 'cover'">填满并居中裁剪</NButton>
          <NButton :type="fit === 'contain' ? 'primary' : 'default'" @click="fit = 'contain'">完整保留</NButton>
        </NButtonGroup>
        <template v-if="mode === 'single'">
          <NButton type="primary" :disabled="!selected" :loading="processing" @click="processPreview"><template #icon><NIcon :component="Play" /></template>执行处理</NButton>
          <div class="control-actions">
            <NButton :disabled="!preview" @click="copyPreview"><template #icon><NIcon :component="Copy" /></template>复制</NButton>
            <NButton :disabled="!preview" @click="savePreview"><template #icon><NIcon :component="Download" /></template>保存 PNG</NButton>
          </div>
        </template>
        <template v-else>
          <NButton :disabled="!selected" :loading="processing" @click="processPreview"><template #icon><NIcon :component="Play" /></template>预览当前参数</NButton>
          <NButton @click="chooseOutputDirectory"><template #icon><NIcon :component="FolderOpen" /></template>{{ outputDirectory || '选择输出目录' }}</NButton>
          <NButton type="primary" :disabled="!canBatch" @click="startBatch"><template #icon><NIcon :component="Play" /></template>开始批量处理</NButton>
          <small>已加入 {{ images.length }} 张图片，不覆盖已有文件。</small>
        </template>
      </aside>
    </div>
  </ToolPage>
</template>

<style scoped>
.image-tool-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(280px, 340px); height: 100%; min-height: 0; gap: 14px; }
.image-workspace { display: flex; flex-direction: column; min-width: 0; min-height: 0; gap: 12px; }
.image-preview-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); min-height: 260px; flex: 1; gap: 12px; }
.image-preview-panel { position: relative; display: grid; place-items: center; min-width: 0; min-height: 220px; overflow: hidden; border: 1px solid var(--border-color); border-radius: 5px; }
.image-preview-panel img { display: block; max-width: 100%; max-height: 100%; object-fit: contain; }
.image-preview-panel em { color: var(--checker-text); font-style: normal; }
.image-preview-panel > span { position: absolute; top: 8px; right: 8px; padding: 4px 7px; color: white; border-radius: 3px; background: rgb(0 0 0 / 65%); font-size: var(--ui-font-sm); }
.image-preview-panel :deep(.n-spin-container), .image-preview-panel :deep(.n-spin-content) { width: 100%; height: 100%; display: grid; place-items: center; }
.checkerboard { background-color: var(--checker-light); background-image: linear-gradient(45deg,var(--checker-dark) 25%,transparent 25%),linear-gradient(-45deg,var(--checker-dark) 25%,transparent 25%),linear-gradient(45deg,transparent 75%,var(--checker-dark) 75%),linear-gradient(-45deg,transparent 75%,var(--checker-dark) 75%); background-size: 20px 20px; background-position: 0 0,0 10px,10px -10px,-10px 0; }
.image-controls { display: flex; flex-direction: column; min-width: 0; gap: 11px; overflow: auto; padding: 14px; border-left: 1px solid var(--border-color); }
.image-controls h2 { margin: 0 0 4px; font-size: var(--ui-font-lg); }
.image-controls label { color: var(--text-muted); font-size: var(--ui-font-sm); font-weight: 700; }
.unit { margin-top: -42px; margin-left: auto; margin-right: 12px; z-index: 1; pointer-events: none; }
.dimension-row { display: grid; grid-template-columns: 1fr auto 1fr; align-items: end; gap: 8px; }
.dimension-row label { display: flex; flex-direction: column; gap: 5px; }
.control-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.image-controls small { color: var(--text-muted); overflow-wrap: anywhere; }
.queue-host { flex: 0 1 260px; }
@media (max-width: 1050px) { .image-tool-layout { grid-template-columns: 1fr; overflow: auto; } .image-controls { border-left: 0; border-top: 1px solid var(--border-color); } .image-preview-grid { min-height: 360px; } }
@media (max-width: 720px) { .image-preview-grid { grid-template-columns: 1fr; } }
</style>
