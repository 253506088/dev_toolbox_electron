<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Copy, FlipHorizontal2, RotateCw, ZoomIn, ZoomOut } from '@lucide/vue'
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
      <button class="viewer-arrow viewer-arrow-left" aria-label="上一张" @click="move(-1)">‹</button>
      <div class="viewer-stage">
        <img :src="imageUrl" :style="{ transform }" alt="便签图片" draggable="false" />
      </div>
      <button class="viewer-arrow viewer-arrow-right" aria-label="下一张" @click="move(1)">›</button>
      <div class="viewer-toolbar">
        <span>{{ index + 1 }} / {{ images.length }}</span>
        <NTooltip><template #trigger><NButton circle quaternary @click="scale = Math.max(0.2, scale - 0.2)"><template #icon><NIcon :component="ZoomOut" /></template></NButton></template>缩小</NTooltip>
        <NTooltip><template #trigger><NButton circle quaternary @click="scale = Math.min(5, scale + 0.2)"><template #icon><NIcon :component="ZoomIn" /></template></NButton></template>放大</NTooltip>
        <NTooltip><template #trigger><NButton circle quaternary @click="rotation += 90"><template #icon><NIcon :component="RotateCw" /></template></NButton></template>旋转</NTooltip>
        <NTooltip><template #trigger><NButton circle quaternary @click="mirrored = !mirrored"><template #icon><NIcon :component="FlipHorizontal2" /></template></NButton></template>镜像</NTooltip>
        <NTooltip><template #trigger><NButton circle quaternary @click="copyImage"><template #icon><NIcon :component="Copy" /></template></NButton></template>复制图片</NTooltip>
        <NButton size="small" @click="emit('update:show', false)">关闭</NButton>
      </div>
    </div>
  </NModal>
</template>

<style scoped>
.image-viewer-modal { width: min(92vw, 1100px); }
.image-viewer { position: relative; height: min(86vh, 760px); overflow: hidden; border: var(--panel-border); border-radius: 6px; background: #171b1a; box-shadow: var(--panel-shadow); outline: none; }
.viewer-stage { display: grid; place-items: center; width: 100%; height: calc(100% - 54px); overflow: hidden; }
.viewer-stage img { max-width: 86%; max-height: 86%; transition: transform 120ms ease; user-select: none; }
.viewer-arrow { position: absolute; z-index: 2; top: calc(50% - 32px); width: 44px; height: 64px; color: white; border: 0; background: rgb(0 0 0 / 48%); font-size: var(--ui-font-icon); cursor: pointer; }
.viewer-arrow-left { left: 0; }
.viewer-arrow-right { right: 0; }
.viewer-toolbar { display: flex; align-items: center; justify-content: center; gap: 7px; height: 54px; color: white; background: #252b29; }
</style>
