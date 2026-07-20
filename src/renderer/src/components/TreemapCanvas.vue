<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { calculateTreemapFontSize, layoutTreemap, type TreemapNode, type TreemapRect } from '@shared/treemap'
import { DEFAULT_UI_FONT_SIZE } from '../utils/font-settings'
import { useSettingsStore } from '../stores/settings'
import { useThemeStore } from '../stores/theme'

const props = defineProps<{ nodes: TreemapNode[] }>()
const emit = defineEmits<{ open: [node: TreemapNode] }>()
const settingsStore = useSettingsStore()
const themeStore = useThemeStore()
const canvas = ref<HTMLCanvasElement>()
const tooltip = ref({ show: false, x: 0, y: 0, text: '' })
let rectangles: TreemapRect[] = []
let observer: ResizeObserver | undefined
let frame = 0
let dragging = false
let lastPointer = { x: 0, y: 0 }

/** 节点变化时请求下一帧重绘。 */
watch(() => props.nodes, scheduleDraw, { deep: true })
watch(() => settingsStore.uiFontSize, scheduleDraw)
watch(() => [themeStore.style, themeStore.colorMode], scheduleDraw)

/** 监听画布容器尺寸变化。 */
onMounted(() => {
  if (!canvas.value) return
  observer = new ResizeObserver(scheduleDraw)
  observer.observe(canvas.value)
  scheduleDraw()
})

/** 释放尺寸监听和未执行的绘制帧。 */
onBeforeUnmount(() => {
  observer?.disconnect()
  cancelAnimationFrame(frame)
})

/** 合并同一帧内的多次重绘请求。 */
function scheduleDraw(): void {
  cancelAnimationFrame(frame)
  frame = requestAnimationFrame(draw)
}

/** 按设备像素比清晰绘制当前 Treemap。 */
function draw(): void {
  const target = canvas.value
  if (!target) return
  const bounds = target.getBoundingClientRect()
  const ratio = window.devicePixelRatio || 1
  target.width = Math.max(1, Math.round(bounds.width * ratio))
  target.height = Math.max(1, Math.round(bounds.height * ratio))
  const context = target.getContext('2d')
  if (!context) return
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  context.clearRect(0, 0, bounds.width, bounds.height)
  rectangles = layoutTreemap(props.nodes, bounds.width, bounds.height)
  rectangles.forEach((rect, index) => drawRectangle(context, rect, index))
}

/** 绘制单个节点矩形和能容纳时的截断名称。 */
function drawRectangle(context: CanvasRenderingContext2D, rect: TreemapRect, index: number): void {
  const palette = themeStore.isDark
    ? ['#14b8a6', '#3b82f6', '#f43f5e', '#eab308', '#a78bfa', '#06b6d4', '#84cc16']
    : ['#0f766e', '#2563eb', '#e11d48', '#ca8a04', '#7c3aed', '#0891b2', '#4d7c0f']
  context.fillStyle = palette[index % palette.length]
  context.fillRect(rect.x + 1, rect.y + 1, Math.max(0, rect.width - 2), Math.max(0, rect.height - 2))
  const baseFontSize = calculateTreemapFontSize(rect.width, rect.height)
  if (baseFontSize === null) return
  const fontSize = Math.round(baseFontSize * settingsStore.uiFontSize / DEFAULT_UI_FONT_SIZE)
  context.fillStyle = '#ffffff'
  context.font = `700 ${fontSize}px "Microsoft YaHei UI"`
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  const maxWidth = rect.width - 16
  let label = rect.name
  while (label.length > 1 && context.measureText(`${label}…`).width > maxWidth) label = label.slice(0, -1)
  if (label !== rect.name) label = `${label}…`
  context.fillText(label, rect.x + rect.width / 2, rect.y + rect.height / 2)
}

/** 鼠标移动时显示命中节点的完整名称和大小。 */
function handlePointerMove(event: PointerEvent): void {
  if (dragging && canvas.value) {
    const parent = canvas.value.parentElement
    parent?.scrollBy(lastPointer.x - event.clientX, lastPointer.y - event.clientY)
    lastPointer = { x: event.clientX, y: event.clientY }
  }
  const rect = hitTest(event)
  tooltip.value = rect
    ? { show: true, x: event.offsetX + 12, y: event.offsetY + 12, text: `${rect.name} · ${formatBytes(rect.size)}` }
    : { show: false, x: 0, y: 0, text: '' }
}

/** 中键按下后启动横向和纵向拖动。 */
function handlePointerDown(event: PointerEvent): void {
  if (event.button !== 1) return
  event.preventDefault()
  dragging = true
  lastPointer = { x: event.clientX, y: event.clientY }
  canvas.value?.setPointerCapture(event.pointerId)
}

/** 结束中键拖动。 */
function handlePointerUp(event: PointerEvent): void {
  dragging = false
  canvas.value?.releasePointerCapture(event.pointerId)
}

/** 点击矩形时把对应节点交给父组件。 */
function handleClick(event: MouseEvent): void {
  const rect = hitTest(event)
  if (rect) emit('open', rect)
}

/** 根据画布内坐标查找命中的 Treemap 矩形。 */
function hitTest(event: MouseEvent | PointerEvent): TreemapRect | undefined {
  return rectangles.find((rect) => event.offsetX >= rect.x && event.offsetX <= rect.x + rect.width && event.offsetY >= rect.y && event.offsetY <= rect.y + rect.height)
}

/** 把字节数格式化为便于阅读的单位。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = -1
  do { value /= 1024; unit += 1 } while (value >= 1024 && unit < units.length - 1)
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`
}
</script>

<template>
  <div class="treemap-host">
    <canvas ref="canvas" @pointermove="handlePointerMove" @pointerleave="tooltip.show = false" @pointerdown="handlePointerDown" @pointerup="handlePointerUp" @click="handleClick" />
    <div v-if="tooltip.show" class="treemap-tooltip" :style="{ left: `${tooltip.x}px`, top: `${tooltip.y}px` }">{{ tooltip.text }}</div>
    <div v-if="nodes.length === 0" class="treemap-empty">等待文件夹大小统计或当前目录为空</div>
  </div>
</template>

<style scoped>
.treemap-host { position: relative; width: 100%; height: 100%; min-height: 0; overflow: auto; background: var(--canvas-background); }
canvas { display: block; width: 100%; height: 100%; min-width: 420px; min-height: 320px; cursor: pointer; }
.treemap-tooltip { position: absolute; z-index: 3; max-width: 320px; padding: 6px 8px; color: white; border-radius: 4px; background: rgb(15 23 42 / 92%); font-size: var(--ui-font-sm); pointer-events: none; overflow-wrap: anywhere; }
.treemap-empty { position: absolute; inset: 0; display: grid; place-items: center; color: var(--text-muted); pointer-events: none; }
</style>
