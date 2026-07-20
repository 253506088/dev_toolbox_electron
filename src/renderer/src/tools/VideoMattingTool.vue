<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { Ban, Crop, FolderOpen, Pipette, Play, RefreshCw, RotateCcw, Video } from '@lucide/vue'
import { NAlert, NButton, NColorPicker, NIcon, NProgress, NSelect, NSlider, NSwitch, NTag, useMessage } from 'naive-ui'
import type { FfmpegStatus, MediaJobEvent, NormalizedCropRect, RgbColor, VideoMetadata, VideoOutputFormat } from '@shared/media-api'
import ToolPage from '../components/ToolPage.vue'
import VideoPreview from '../components/VideoPreview.vue'

const message = useMessage()
const video = ref<VideoMetadata | null>(null)
const ffmpeg = ref<FfmpegStatus>({ available: false, message: '正在检测 FFmpeg…' })
const backgroundHex = ref('#000000')
const similarity = ref(0.3)
const blend = ref(0.15)
const enableMatting = ref(true)
const denoise = ref(true)
const flipHorizontal = ref(false)
const flipVertical = ref(false)
const cropEnabled = ref(false)
const crop = ref<NormalizedCropRect>({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 })
const outputFormat = ref<VideoOutputFormat>('webm')
const pickingColor = ref(false)
const jobId = ref('')
const progress = ref(0)
const jobState = ref<'idle' | 'running' | 'completed' | 'failed' | 'cancelled'>('idle')
const outputPath = ref('')
const logs = ref<string[]>([])
let unsubscribeJob: (() => void) | undefined

const running = computed(() => jobState.value === 'running')
const formatOptions = [
  { label: 'WebM（VP9 透明）', value: 'webm' },
  { label: 'MOV（ProRes 4444 透明）', value: 'mov' },
  { label: 'MP4（H.264，不透明）', value: 'mp4' }
]

/** 检测 FFmpeg 可用性。 */
async function refreshFfmpeg(): Promise<void> {
  ffmpeg.value = { available: false, message: '正在检测 FFmpeg…' }
  try {
    ffmpeg.value = await window.electronApi.media.ffmpegStatus()
  } catch (error) {
    ffmpeg.value = { available: false, message: formatError(error) }
  }
}

/** 通过系统对话框选择视频。 */
async function chooseVideo(): Promise<void> {
  try {
    const selected = await window.electronApi.media.selectVideo()
    if (selected) applyVideo(selected)
  } catch (error) {
    message.error(formatError(error))
  }
}

/** 注册拖入的视频。 */
async function loadDropped(path: string): Promise<void> {
  try {
    applyVideo(await window.electronApi.media.registerVideo(path))
  } catch (error) {
    message.error(formatError(error))
  }
}

/** 设置新视频并清空旧任务状态。 */
function applyVideo(selected: VideoMetadata): void {
  video.value = selected
  progress.value = 0
  jobState.value = 'idle'
  outputPath.value = ''
  cropEnabled.value = false
  pickingColor.value = false
  logs.value = [`已加载视频：${selected.name}`]
}

/** 开关裁剪，并在首次开启时恢复 10% 到 90% 的默认区域。 */
function setCropEnabled(value: boolean): void {
  cropEnabled.value = value
  if (value) crop.value = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }
}

/** 接收预览画面吸管取得的 RGB 颜色。 */
function setPickedColor(color: RgbColor): void {
  backgroundHex.value = rgbToHex(color)
  pickingColor.value = false
  message.success(`背景色已设为 ${backgroundHex.value.toUpperCase()}`)
}

/** 选择输出文件并启动视频抠图。 */
async function startExport(): Promise<void> {
  if (!video.value || !ffmpeg.value.available) return
  const suggestedName = `${fileStem(video.value.name)}${enableMatting.value ? '_alpha' : '_processed'}.${outputFormat.value}`
  const target = await window.electronApi.media.selectVideoOutput(outputFormat.value, suggestedName)
  if (!target) return
  try {
    progress.value = 0
    logs.value = []
    jobState.value = 'running'
    const result = await window.electronApi.media.startVideoMatting({
      inputPath: video.value.path,
      outputPath: target,
      background: hexToRgb(backgroundHex.value),
      similarity: similarity.value,
      blend: blend.value,
      enableMatting: enableMatting.value,
      denoise: denoise.value,
      flipHorizontal: flipHorizontal.value,
      flipVertical: flipVertical.value,
      crop: cropEnabled.value ? crop.value : undefined,
      outputFormat: outputFormat.value
    })
    jobId.value = result.jobId
    outputPath.value = result.outputPath
  } catch (error) {
    jobState.value = 'failed'
    message.error(formatError(error))
  }
}

/** 取消当前 FFmpeg 导出。 */
function cancelJob(): void {
  if (jobId.value) void window.electronApi.media.cancelJob(jobId.value)
}

/** 打开导出文件所在目录。 */
function openOutput(): void {
  if (outputPath.value) void window.electronApi.files.openInExplorer(outputPath.value.replace(/[\\/][^\\/]+$/, ''))
}

/** 重置全部视频处理参数。 */
function resetOptions(): void {
  backgroundHex.value = '#000000'
  similarity.value = 0.3
  blend.value = 0.15
  enableMatting.value = true
  denoise.value = true
  flipHorizontal.value = false
  flipVertical.value = false
  cropEnabled.value = false
  outputFormat.value = 'webm'
}

/** 处理当前导出任务的进度、日志和终态。 */
function handleJobEvent(event: MediaJobEvent): void {
  if (event.jobId !== jobId.value) return
  if (event.type === 'progress') progress.value = Math.max(progress.value, event.progress)
  if (event.type === 'log') logs.value = [...logs.value.slice(-199), event.message]
  if (event.type === 'completed') {
    progress.value = 1
    jobState.value = 'completed'
    message.success('视频导出完成')
  } else if (event.type === 'failed') {
    jobState.value = 'failed'
    logs.value = [...logs.value.slice(-199), event.message]
    message.error('视频导出失败，请查看日志')
  } else if (event.type === 'cancelled') {
    jobState.value = 'cancelled'
    message.info('导出任务已取消')
  }
}

/** 页面挂载时检测 FFmpeg 并订阅任务事件。 */
onMounted(() => {
  void refreshFfmpeg()
  unsubscribeJob = window.electronApi.media.onJobEvent(handleJobEvent)
})

/** 页面销毁时释放 IPC 监听。 */
onUnmounted(() => unsubscribeJob?.())

/** 把十六进制颜色转换成 RGB。 */
function hexToRgb(hex: string): RgbColor {
  const value = hex.replace('#', '').slice(0, 6).padEnd(6, '0')
  return { r: Number.parseInt(value.slice(0, 2), 16), g: Number.parseInt(value.slice(2, 4), 16), b: Number.parseInt(value.slice(4, 6), 16) }
}

/** 把 RGB 颜色转换成十六进制文字。 */
function rgbToHex(color: RgbColor): string {
  return `#${[color.r, color.g, color.b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}

/** 提取不带扩展名的文件名。 */
function fileStem(name: string): string {
  return name.replace(/\.[^.]+$/, '')
}

/** 把未知异常转换成可读文字。 */
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
</script>

<template>
  <ToolPage title="视频抠图">
    <template #actions>
      <NButton :disabled="running" @click="chooseVideo"><template #icon><NIcon :component="Video" /></template>选择视频</NButton>
      <NButton :type="pickingColor ? 'primary' : 'default'" :disabled="!video || !enableMatting" @click="pickingColor = !pickingColor"><template #icon><NIcon :component="Pipette" /></template>画面取色</NButton>
      <NButton secondary :disabled="running" @click="resetOptions"><template #icon><NIcon :component="RotateCcw" /></template>重置参数</NButton>
      <NButton quaternary circle aria-label="重新检测 FFmpeg" @click="refreshFfmpeg"><template #icon><NIcon :component="RefreshCw" /></template></NButton>
    </template>
    <template #status><NTag size="small" :type="ffmpeg.available ? 'success' : 'error'">{{ ffmpeg.available ? 'FFmpeg 已就绪' : 'FFmpeg 不可用' }}</NTag></template>
    <div class="video-matting-layout">
      <section class="video-matting-main">
        <VideoPreview :video="video" :crop="cropEnabled ? crop : undefined" :picking-color="pickingColor" @choose="chooseVideo" @dropped="loadDropped" @color="setPickedColor" @crop-change="crop = $event" />
        <div v-if="video" class="video-facts"><strong>{{ video.name }}</strong><span>{{ video.width }}×{{ video.height }}</span><span>{{ video.duration.toFixed(2) }} 秒</span></div>
        <section class="job-status">
          <div><strong>导出状态</strong><span>{{ ffmpeg.message }}</span></div>
          <NProgress type="line" :percentage="Math.round(progress * 100)" :status="jobState === 'failed' ? 'error' : jobState === 'completed' ? 'success' : 'default'" :processing="running" />
          <div class="job-actions">
            <NButton v-if="running" type="error" secondary @click="cancelJob"><template #icon><NIcon :component="Ban" /></template>取消</NButton>
            <NButton v-if="outputPath" @click="openOutput"><template #icon><NIcon :component="FolderOpen" /></template>打开输出目录</NButton>
          </div>
          <pre>{{ logs.length ? logs.join('\n') : '暂无运行日志' }}</pre>
        </section>
      </section>
      <aside class="video-matting-controls">
        <h2>抠图与导出</h2>
        <div class="switch-row"><span>启用颜色键抠图</span><NSwitch v-model:value="enableMatting" :disabled="running" /></div>
        <label>背景颜色<NColorPicker v-model:value="backgroundHex" :show-alpha="false" :disabled="!enableMatting || running" /></label>
        <label>相似度 {{ similarity.toFixed(2) }}<NSlider v-model:value="similarity" :min="0.01" :max="1" :step="0.01" :disabled="!enableMatting || running" /></label>
        <label>边缘混合 {{ blend.toFixed(2) }}<NSlider v-model:value="blend" :min="0" :max="1" :step="0.01" :disabled="!enableMatting || running" /></label>
        <div class="switch-grid">
          <label><span>降噪</span><NSwitch v-model:value="denoise" :disabled="running" /></label>
          <label><span>水平翻转</span><NSwitch v-model:value="flipHorizontal" :disabled="running" /></label>
          <label><span>垂直翻转</span><NSwitch v-model:value="flipVertical" :disabled="running" /></label>
          <label><span><NIcon :component="Crop" />裁剪</span><NSwitch :value="cropEnabled" :disabled="!video || running" @update:value="setCropEnabled" /></label>
        </div>
        <div v-if="cropEnabled" class="crop-values"><span>左 {{ Math.round(crop.x * (video?.width ?? 0)) }}</span><span>上 {{ Math.round(crop.y * (video?.height ?? 0)) }}</span><span>宽 {{ Math.round(crop.width * (video?.width ?? 0)) }}</span><span>高 {{ Math.round(crop.height * (video?.height ?? 0)) }}</span></div>
        <label>输出格式<NSelect v-model:value="outputFormat" :options="formatOptions" :disabled="running" /></label>
        <NAlert v-if="outputFormat === 'mp4'" type="warning" :show-icon="false">MP4 不支持透明通道，透明背景会变为不透明。需要透明结果请选 WebM 或 MOV。</NAlert>
        <NButton type="primary" :disabled="!video || !ffmpeg.available || running" @click="startExport"><template #icon><NIcon :component="Play" /></template>选择位置并导出</NButton>
      </aside>
    </div>
  </ToolPage>
</template>

<style scoped>
.video-matting-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 360px); height: 100%; min-height: 0; gap: 14px; }
.video-matting-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; gap: 9px; }
.video-matting-main > :first-child { flex: 1; min-height: 280px; }
.video-facts { display: flex; gap: 16px; color: var(--text-muted); }
.video-facts strong { flex: 1; min-width: 0; overflow: hidden; color: var(--text-color); white-space: nowrap; text-overflow: ellipsis; }
.job-status { display: flex; flex-direction: column; flex: 0 1 220px; min-height: 150px; gap: 7px; }
.job-status > div:first-child { display: flex; justify-content: space-between; gap: 10px; }
.job-status > div:first-child span { max-width: 65%; overflow: hidden; color: var(--text-muted); white-space: nowrap; text-overflow: ellipsis; }
.job-actions { display: flex; gap: 8px; }
.job-status pre { flex: 1; min-height: 72px; margin: 0; overflow: auto; padding: 8px; color: #d4d4d8; border-radius: 4px; background: #18181b; font: var(--ui-font-sm)/1.45 Consolas, monospace; white-space: pre-wrap; }
.video-matting-controls { display: flex; flex-direction: column; min-width: 0; gap: 10px; overflow: auto; padding: 14px; border-left: 1px solid var(--border-color); }
.video-matting-controls h2 { margin: 0; font-size: var(--ui-font-lg); }
.video-matting-controls > label { display: flex; flex-direction: column; gap: 5px; color: var(--text-muted); font-size: var(--ui-font-sm); font-weight: 700; }
.switch-row, .switch-grid label { display: flex; align-items: center; justify-content: space-between; }
.switch-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 16px; padding: 10px; border: 1px solid var(--border-color); border-radius: 4px; }
.switch-grid label > span { display: flex; align-items: center; gap: 5px; }
.crop-values { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; color: var(--text-muted); }
@media (max-width: 1050px) { .video-matting-layout { grid-template-columns: 1fr; overflow: auto; } .video-matting-controls { border-left: 0; border-top: 1px solid var(--border-color); } .video-matting-main { min-height: 680px; } }
</style>
