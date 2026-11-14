<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ChevronLeft, ChevronRight, Copy, FlipHorizontal2, RotateCw, X, ZoomIn, ZoomOut } from '@lucide/vue'
import { NButton, NIcon, NModal, NTooltip, useMessage } from 'naive-ui'

const props = defineProps<{ show: boolean; images: string[]; initialIndex: number }>()
const emit = defineEmits<{ 'update:show': [value: boolean] }>()
const message = useMessage()
const index = ref(0)
const scale = ref(1)
const rotation = ref(0)
const mirrored = ref(false)
const currentImage = computed(() => props.images[index.value] ?? '')
const imageUrl = computed(() => `note-image://image/${encodeURIComponent(currentImage.value)}`)
const transform = computed(() => `scale(${mirrored.value ? -scale.value : scale.value}, ${scale.value}) rotate(${rotation.value}deg)`)

/** 每次打开查看器时回到指定图片和默认变换。 */
watch(() => props.show, (show) => {
  if (!show) return
  index.value = Math.min(props.initialIndex, Math.max(0, props.images.length - 1))
  resetTransform()
})

/** 恢复图片默认缩放、旋转和镜像。 */
function resetTransform(): void {
  scale.value = 1
  rotation.value = 0
  mirrored.value = false
}

/** 切换上一张或下一张图片。 */
function move(step: number): void {
  if (props.images.length === 0) return
  index.value = (index.value + step + props.images.length) % props.images.length
  resetTransform()
}

/** 按滚轮方向切图，按住 Ctrl 时改为缩放。 */
function handleWheel(event: WheelEvent): void {
  event.preventDefault()
  if (event.ctrlKey) scale.value = Math.min(5, Math.max(0.2, scale.value + (event.deltaY < 0 ? 0.15 : -0.15)))
  else move(event.deltaY > 0 ? 1 : -1)
}

/** 把当前图片写入系统剪贴板。 */
async function copyImage(): Promise<void> {
  const response = await fetch(imageUrl.value)
  const blob = await response.blob()
  const dataUrl = await blobToDataUrl(blob)
  await window.electronApi.clipboard.writeImage(dataUrl)
  message.success('图片已复制')
}

/** 把 Blob 转换为主进程可接收的数据地址。 */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}
</script>

<template>
  <NModal :show="show" class="image-viewer-modal" @update:show="emit('update:show', $event)">
    <div class="image-viewer" tabindex="0" @wheel="handleWheel" @keydown.left="move(-1)" @keydown.right="move(1)" @keydown.esc="emit('update:show', false)">
      <button v-if="images.length > 1" class="viewer-arrow viewer-arrow-left" aria-label="上一张" @click="move(-1)"><ChevronLeft :size="28" /></button>
      <div class="viewer-stage">
        <img :src="imageUrl" :style="{ transform }" alt="便签图片" draggable="false" />
      </div>
      <button v-if="images.length > 1" class="viewer-arrow viewer-arrow-right" aria-label="下一张" @click="move(1)"><ChevronRight :size="28" /></button>
      <div class="viewer-toolbar">
        <span class="viewer-count">{{ index + 1 }} / {{ images.length }}</span>
        <NTooltip><template #trigger><NButton circle quaternary aria-label="缩小" @click="scale = Math.max(0.2, scale - 0.2)"><template #icon><NIcon :component="ZoomOut" /></template></NButton></template>缩小</NTooltip>
        <NTooltip><template #trigger><NButton circle quaternary aria-label="放大" @click="scale = Math.min(5, scale + 0.2)"><template #icon><NIcon :component="ZoomIn" /></template></NButton></template>放大</NTooltip>
        <NTooltip><template #trigger><NButton circle quaternary aria-label="顺时针旋转" @click="rotation += 90"><template #icon><NIcon :component="RotateCw" /></template></NButton></template>顺时针旋转</NTooltip>
        <NTooltip><template #trigger><NButton circle quaternary aria-label="水平镜像" @click="mirrored = !mirrored"><template #icon><NIcon :component="FlipHorizontal2" /></template></NButton></template>水平镜像</NTooltip>
        <NTooltip><template #trigger><NButton circle quaternary aria-label="复制图片" @click="copyImage"><template #icon><NIcon :component="Copy" /></template></NButton></template>复制图片</NTooltip>
        <NTooltip><template #trigger><NButton circle quaternary aria-label="关闭" @click="emit('update:show', false)"><template #icon><NIcon :component="X" /></template></NButton></template>关闭</NTooltip>
      </div>
    </div>
  </NModal>
</template>

<style scoped>
.image-viewer-modal { width: min(92vw, 1100px); }
.image-viewer { position: relative; height: min(86vh, 760px); overflow: hidden; border: 1px solid #55615e; border-radius: 6px; background: #141817; box-shadow: 0 18px 50px rgb(0 0 0 / 42%); outline: none; }
.viewer-stage { display: grid; place-items: center; width: 100%; height: 100%; padding: 24px 70px 88px; overflow: hidden; }
.viewer-stage img { max-width: 86%; max-height: 86%; transition: transform 120ms ease; user-select: none; }
.viewer-arrow { position: absolute; z-index: 2; top: calc(50% - 32px); display: grid; place-items: center; width: 44px; height: 64px; color: #ffffff; border: 1px solid rgb(255 255 255 / 20%); background: rgb(0 0 0 / 68%); cursor: pointer; }
.viewer-arrow:hover { background: rgb(15 118 110 / 90%); }
.viewer-arrow-left { left: 0; }
.viewer-arrow-right { right: 0; }
.viewer-toolbar { position: absolute; z-index: 3; bottom: 16px; left: 50%; display: flex; align-items: center; justify-content: center; width: max-content; max-width: calc(100% - 24px); min-height: 48px; gap: 4px; padding: 5px 8px; color: #ffffff; border: 1px solid #687570; border-radius: 6px; background: #0b0f0e; box-shadow: 0 6px 20px rgb(0 0 0 / 55%); transform: translateX(-50%); }
.viewer-count { min-width: 52px; padding: 0 7px; color: #ffffff; font-weight: 700; text-align: center; white-space: nowrap; }
.viewer-toolbar :deep(.n-button) { width: 34px; height: 34px; color: #ffffff !important; }
.viewer-toolbar :deep(.n-button:hover) { background: #28413d !important; }
.viewer-toolbar :deep(.n-button__icon) { color: #ffffff !important; opacity: 1; }
@media (max-width: 520px) {
  .viewer-stage { padding: 18px 48px 82px; }
  .viewer-toolbar { gap: 1px; padding-inline: 5px; }
  .viewer-count { min-width: 44px; padding-inline: 3px; }
  .viewer-toolbar :deep(.n-button) { width: 32px; height: 32px; }
}
</style>
