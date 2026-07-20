<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { Ban, Crop, FolderOpen, Play, RefreshCw, RotateCcw, Video } from '@lucide/vue'
import { NButton, NIcon, NInputNumber, NProgress, NSwitch, NTag, useMessage } from 'naive-ui'
import type { FfmpegStatus, MediaJobEvent, NormalizedCropRect, VideoMetadata } from '@shared/media-api'
import ToolPage from '../components/ToolPage.vue'
import VideoPreview from '../components/VideoPreview.vue'

const message = useMessage()
const video = ref<VideoMetadata | null>(null)
const ffmpeg = ref<FfmpegStatus>({ available: false, message: '正在检测 FFmpeg…' })
const outputRoot = ref('')
const fps = ref(12)
const startSeconds = ref(0)
const endSeconds = ref(5)
const maxFrames = ref(300)
const cropEnabled = ref(false)
const crop = ref<NormalizedCropRect>({ x: 0, y: 0, width: 1, height: 1 })
const jobId = ref('')
const progress = ref(0)
const jobState = ref<'idle' | 'running' | 'completed' | 'failed' | 'cancelled'>('idle')
const outputPath = ref('')
const logs = ref<string[]>([])
let unsubscribeJob: (() => void) | undefined

const running = computed(() => jobState.value === 'running')
const estimatedFrames = computed(() => {
  const duration = Math.max(0, Math.min(endSeconds.value, video.value?.duration ?? endSeconds.value) - startSeconds.value)
  return Math.min(maxFrames.value, Math.max(0, Math.floor(duration * fps.value)))
})

/** 检测应用内置或系统 FFmpeg。 */
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

/** 设置新视频并按元数据初始化参数。 */
function applyVideo(selected: VideoMetadata): void {
  video.value = selected
  fps.value = selected.fps > 0 ? Math.min(30, selected.fps) : 12
  startSeconds.value = 0
  endSeconds.value = Number(selected.duration.toFixed(3))
  crop.value = { x: 0, y: 0, width: 1, height: 1 }
  progress.value = 0
  jobState.value = 'idle'
  logs.value = [`已加载视频：${selected.name}`]
}

/** 选择抽帧输出根目录。 */
async function chooseOutputRoot(): Promise<void> {
  outputRoot.value = await window.electronApi.media.selectDirectory() ?? outputRoot.value
}

/** 校验参数并启动 FFmpeg 抽帧。 */
async function startExtract(): Promise<void> {
  if (!video.value || !outputRoot.value || !ffmpeg.value.available) return
  if (endSeconds.value <= startSeconds.value) {
    message.warning('结束时间必须晚于开始时间')
    return
  }
  try {
    progress.value = 0
    logs.value = []
    jobState.value = 'running'
    const result = await window.electronApi.media.startFrameExtract({
      inputPath: video.value.path,
      outputRoot: outputRoot.value,
      fps: fps.value,
      startSeconds: startSeconds.value,
      endSeconds: Math.min(endSeconds.value, video.value.duration),
      maxFrames: maxFrames.value,
      crop: cropEnabled.value ? crop.value : undefined
    })
    jobId.value = result.jobId
    outputPath.value = result.outputPath
  } catch (error) {
    jobState.value = 'failed'
    message.error(formatError(error))
  }
}

/** 取消当前抽帧子进程。 */
function cancelJob(): void {
  if (jobId.value) void window.electronApi.media.cancelJob(jobId.value)
}

/** 重置裁剪区域为完整画面。 */
function resetCrop(): void {
  crop.value = { x: 0, y: 0, width: 1, height: 1 }
}

/** 打开最近一次抽帧输出目录。 */
function openOutput(): void {
  if (outputPath.value) void window.electronApi.files.openInExplorer(outputPath.value)
}

/** 处理当前抽帧任务的进度、日志和终态。 */
function handleJobEvent(event: MediaJobEvent): void {
  if (event.jobId !== jobId.value) return
  if (event.type === 'progress') progress.value = Math.max(progress.value, event.progress)
  if (event.type === 'log') logs.value = [...logs.value.slice(-199), event.message]
  if (event.type === 'completed') {
    progress.value = 1
    jobState.value = 'completed'
    message.success('序列帧提取完成')
  } else if (event.type === 'failed') {
    jobState.value = 'failed'
    logs.value = [...logs.value.slice(-199), event.message]
    message.error('抽帧失败，请查看日志')
  } else if (event.type === 'cancelled') {
    jobState.value = 'cancelled'
    message.info('抽帧任务已取消')
  }
}

/** 页面挂载时检测 FFmpeg 并订阅任务事件。 */
onMounted(() => {
  void refreshFfmpeg()
  unsubscribeJob = window.electronApi.media.onJobEvent(handleJobEvent)
})

/** 页面销毁时释放 IPC 监听。 */
onUnmounted(() => unsubscribeJob?.())

/** 格式化秒数为适合阅读的文本。 */
function formatSeconds(value: number): string {
  const minutes = Math.floor(value / 60)
  const seconds = (value % 60).toFixed(2).padStart(5, '0')
  return `${minutes}:${seconds}`
}

/** 把未知异常转换成可读文字。 */
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
</script>

<template>
  <ToolPage title="视频转序列帧">
    <template #actions>
      <NButton :disabled="running" @click="chooseVideo"><template #icon><NIcon :component="Video" /></template>选择视频</NButton>
      <NButton :disabled="running" @click="chooseOutputRoot"><template #icon><NIcon :component="FolderOpen" /></template>输出目录</NButton>
      <NButton quaternary circle aria-label="重新检测 FFmpeg" @click="refreshFfmpeg"><template #icon><NIcon :component="RefreshCw" /></template></NButton>
    </template>
    <template #status><NTag size="small" :type="ffmpeg.available ? 'success' : 'error'">{{ ffmpeg.available ? 'FFmpeg 已就绪' : 'FFmpeg 不可用' }}</NTag></template>
    <div class="video-tool-layout">
      <section class="video-main">
        <VideoPreview :video="video" :crop="cropEnabled ? crop : undefined" @choose="chooseVideo" @dropped="loadDropped" @crop-change="crop = $event" />
        <div v-if="video" class="video-facts">
          <span>{{ video.name }}</span><span>{{ video.width }}×{{ video.height }}</span><span>{{ formatSeconds(video.duration) }}</span><span>{{ video.fps.toFixed(3) }} FPS</span>
        </div>
        <section class="job-status">
          <div><strong>运行状态</strong><span>{{ ffmpeg.message }}</span></div>
          <NProgress type="line" :percentage="Math.round(progress * 100)" :status="jobState === 'failed' ? 'error' : jobState === 'completed' ? 'success' : 'default'" :processing="running" />
          <div class="job-actions">
            <NButton v-if="running" type="error" secondary @click="cancelJob"><template #icon><NIcon :component="Ban" /></template>取消</NButton>
            <NButton v-if="outputPath" @click="openOutput"><template #icon><NIcon :component="FolderOpen" /></template>打开输出目录</NButton>
          </div>
          <pre>{{ logs.length ? logs.join('\n') : '暂无运行日志' }}</pre>
        </section>
      </section>
      <aside class="video-controls">
        <h2>抽帧参数</h2>
        <label>目标帧率（FPS）<NInputNumber v-model:value="fps" :min="0.01" :max="240" :precision="3" :disabled="running" /></label>
        <div class="control-pair">
          <label>开始秒<NInputNumber v-model:value="startSeconds" :min="0" :max="video?.duration ?? 86400" :precision="3" :disabled="running" /></label>
          <label>结束秒<NInputNumber v-model:value="endSeconds" :min="0" :max="video?.duration ?? 86400" :precision="3" :disabled="running" /></label>
        </div>
        <label>最大帧数<NInputNumber v-model:value="maxFrames" :min="1" :max="100000" :disabled="running" /></label>
        <div class="estimate">预计输出 <strong>{{ estimatedFrames }}</strong> 帧</div>
        <div class="switch-row"><span><NIcon :component="Crop" />启用画面裁剪</span><NSwitch v-model:value="cropEnabled" :disabled="!video || running" /></div>
        <template v-if="cropEnabled">
          <div class="crop-values">
            <span>左 {{ Math.round(crop.x * (video?.width ?? 0)) }}</span><span>上 {{ Math.round(crop.y * (video?.height ?? 0)) }}</span>
            <span>宽 {{ Math.round(crop.width * (video?.width ?? 0)) }}</span><span>高 {{ Math.round(crop.height * (video?.height ?? 0)) }}</span>
          </div>
          <NButton size="small" @click="resetCrop"><template #icon><NIcon :component="RotateCcw" /></template>重置裁剪</NButton>
        </template>
        <p>输出位置：{{ outputRoot || '尚未选择' }}</p>
        <NButton type="primary" :disabled="!video || !outputRoot || !ffmpeg.available || running" @click="startExtract"><template #icon><NIcon :component="Play" /></template>开始提取</NButton>
      </aside>
    </div>
  </ToolPage>
</template>

<style scoped>
.video-tool-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(290px, 350px); height: 100%; min-height: 0; gap: 14px; }
.video-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; gap: 9px; }
.video-main > :first-child { flex: 1; min-height: 280px; }
.video-facts { display: flex; flex-wrap: wrap; gap: 8px 18px; color: var(--text-muted); }
.video-facts span:first-child { flex: 1; min-width: 140px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--text-color); font-weight: 700; }
.job-status { display: flex; flex-direction: column; flex: 0 1 230px; min-height: 150px; gap: 7px; }
.job-status > div:first-child { display: flex; justify-content: space-between; gap: 10px; }
.job-status > div:first-child span { max-width: 65%; overflow: hidden; color: var(--text-muted); white-space: nowrap; text-overflow: ellipsis; }
.job-actions { display: flex; gap: 8px; }
.job-status pre { flex: 1; min-height: 72px; margin: 0; overflow: auto; padding: 8px; color: #d4d4d8; border-radius: 4px; background: #18181b; font: var(--ui-font-sm)/1.45 Consolas, monospace; white-space: pre-wrap; }
.video-controls { display: flex; flex-direction: column; gap: 11px; min-width: 0; overflow: auto; padding: 14px; border-left: 1px solid var(--border-color); }
.video-controls h2 { margin: 0; font-size: var(--ui-font-lg); }
.video-controls label { display: flex; flex-direction: column; gap: 5px; color: var(--text-muted); font-size: var(--ui-font-sm); font-weight: 700; }
.video-controls p { margin: 0; color: var(--text-muted); overflow-wrap: anywhere; }
.control-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.estimate { padding: 9px; border: 1px solid var(--border-color); border-radius: 4px; background: var(--surface-muted); }
.switch-row { display: flex; align-items: center; justify-content: space-between; }
.switch-row span { display: flex; align-items: center; gap: 6px; }
.crop-values { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; color: var(--text-muted); }
@media (max-width: 1050px) { .video-tool-layout { grid-template-columns: 1fr; overflow: auto; } .video-controls { border-left: 0; border-top: 1px solid var(--border-color); } .video-main { min-height: 680px; } }
</style>
