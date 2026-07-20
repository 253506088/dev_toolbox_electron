<script setup lang="ts">
import { computed, ref } from 'vue'
import { Pipette, VideoOff } from '@lucide/vue'
import { NIcon } from 'naive-ui'
import type { NormalizedCropRect, RgbColor, VideoMetadata } from '@shared/media-api'
import CropOverlay from './CropOverlay.vue'

const props = withDefaults(defineProps<{
  video: VideoMetadata | null
  crop?: NormalizedCropRect
  pickingColor?: boolean
}>(), { crop: undefined, pickingColor: false })

const emit = defineEmits<{
  choose: []
  dropped: [path: string]
  color: [color: RgbColor]
  cropChange: [rect: NormalizedCropRect]
}>()

const videoElement = ref<HTMLVideoElement>()
const previewFailed = ref(false)
const aspectRatio = computed(() => props.video ? `${props.video.width} / ${props.video.height}` : '16 / 9')

/** 处理视频拖入并转换真实路径。 */
function handleDrop(event: DragEvent): void {
  event.preventDefault()
  const file = event.dataTransfer?.files[0]
  if (file) emit('dropped', window.electronApi.media.pathForFile(file))
}

/** 从当前视频画面点击位置读取 RGB 颜色。 */
function pickColor(event: MouseEvent): void {
  if (!props.pickingColor || !videoElement.value || previewFailed.value) return
  const video = videoElement.value
  if (!video.videoWidth || !video.videoHeight) return
  const bounds = video.getBoundingClientRect()
  const x = Math.max(0, Math.min(video.videoWidth - 1, Math.round((event.clientX - bounds.left) / bounds.width * video.videoWidth)))
  const y = Math.max(0, Math.min(video.videoHeight - 1, Math.round((event.clientY - bounds.top) / bounds.height * video.videoHeight)))
  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return
  context.drawImage(video, 0, 0)
  const pixel = context.getImageData(x, y, 1, 1).data
  emit('color', { r: pixel[0], g: pixel[1], b: pixel[2] })
}
</script>

<template>
  <div class="video-preview" @dragover.prevent @drop="handleDrop">
    <button v-if="!video" class="video-empty" type="button" @click="emit('choose')">
      <NIcon :component="VideoOff" :size="42" />
      <span>点击选择或拖入视频</span>
    </button>
    <div v-else class="video-frame" :class="{ picking: pickingColor }" :style="{ aspectRatio, '--video-aspect': video.width / video.height }" @click="pickColor">
      <video ref="videoElement" :src="video.previewUrl" controls preload="metadata" @error="previewFailed = true" @loadedmetadata="previewFailed = false" />
      <CropOverlay v-if="crop && !previewFailed" :rect="crop" @change="emit('cropChange', $event)" />
      <div v-if="pickingColor && !previewFailed" class="pick-hint"><NIcon :component="Pipette" />点击画面取背景色</div>
      <div v-if="previewFailed" class="preview-fallback">
        <NIcon :component="VideoOff" :size="36" />
        <strong>当前编码无法预览</strong>
        <span>FFmpeg 仍可正常处理和导出</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.video-preview { container-type: size; display: grid; place-items: center; width: 100%; height: 100%; min-height: 260px; overflow: hidden; border: 1px solid var(--border-color); border-radius: 5px; background: #151719; }
.video-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; width: 100%; height: 100%; gap: 10px; color: #d1d5db; border: 0; background: transparent; cursor: pointer; }
.video-frame { position: relative; width: min(100cqw, calc(100cqh * var(--video-aspect))); max-width: 100%; max-height: 100%; overflow: hidden; background: #000; }
.video-frame video { display: block; width: 100%; height: 100%; object-fit: contain; }
.video-frame.picking { cursor: crosshair; }
.pick-hint { position: absolute; z-index: 6; top: 10px; left: 10px; display: flex; align-items: center; gap: 6px; padding: 6px 9px; color: #fff; border-radius: 4px; background: rgb(15 118 110 / 90%); pointer-events: none; }
.preview-fallback { position: absolute; inset: 0; z-index: 8; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: #e5e7eb; background: #27272a; }
.preview-fallback span { color: #a1a1aa; }
</style>
