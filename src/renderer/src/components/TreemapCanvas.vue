<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { calculateTreemapFontSize, layoutTreemap, type TreemapNode, type TreemapRect } from '@shared/treemap'
import { formatExactFileSize, formatFileSize, formatSizeShare } from '@shared/file-size-display'
import { DEFAULT_UI_FONT_SIZE } from '../utils/font-settings'
import { useSettingsStore } from '../stores/settings'
import { useThemeStore } from '../stores/theme'

const props = withDefaults(defineProps<{ nodes: TreemapNode[]; emptyText?: string }>(), {
  emptyText: '当前目录没有可展示的文件大小'
})
const emit = defineEmits<{ open: [node: TreemapNode] }>()
const settingsStore = useSettingsStore()
const themeStore = useThemeStore()
const canvas = ref<HTMLCanvasElement>()
const tooltipElement = ref<HTMLDivElement>()
const hovered = ref<TreemapRect>()
const tooltipPosition = ref({ x: 0, y: 0 })
const totalSize = computed(() => props.nodes.reduce((sum, node) => sum + (Number.isFinite(node.size) && node.size > 0 ? node.size : 0), 0))
let rectangles: TreemapRect[] = []
let observer: ResizeObserver | undefined
let frame = 0
let pointer: { clientX: number; clientY: number } | undefined

/** 同一帧合并重绘，重新命中鼠标位置，避免统计更新后显示旧容量。 */
watch(() => props.nodes, scheduleDraw, { deep: true })
watch(() => settingsStore.uiFontSize, scheduleDraw)
watch(() => [themeStore.style, themeStore.colorMode], scheduleDraw)

onMounted(() => {
  if (!canvas.value) return
  observer = new ResizeObserver(scheduleDraw)
  observer.observe(canvas.value)
  window.addEventListener('resize', scheduleDraw)
  scheduleDraw()
})

onBeforeUnmount(() => {
  observer?.disconnect()
  window.removeEventListener('resize', scheduleDraw)
  cancelAnimationFrame(frame)
})

function scheduleDraw(): void {
  cancelAnimationFrame(frame)
  frame = requestAnimationFrame(draw)
}

/** 使用 CSS 像素布局和设备像素比绘制，窄面板不再被固定最小宽度裁掉。 */
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
  rectangles.forEach((rect) => drawRectangle(context, rect))
  refreshHover()
}

/** 大图块同时显示名称、容量和占比；小图块优先显示容量，详细信息保留在悬浮层。 */
function drawRectangle(context: CanvasRenderingContext2D, rect: TreemapRect): void {
  const palette = ['#0f766e', '#2563eb', '#be123c', '#a16207', '#7c3aed', '#0e7490', '#4d7c0f']
  let colorHash = 0
  for (const character of rect.path) colorHash = (colorHash * 31 + character.charCodeAt(0)) >>> 0
  context.fillStyle = palette[colorHash % palette.length]
  context.fillRect(rect.x + 1, rect.y + 1, Math.max(0, rect.width - 2), Math.max(0, rect.height - 2))
  if (rect.width < 44 || rect.height < 24) return

  const fontScale = settingsStore.uiFontSize / DEFAULT_UI_FONT_SIZE
  const showName = rect.width >= 88 && rect.height >= 62 * fontScale
  const showShare = showName && rect.height >= 96 * fontScale
  const nameSize = Math.min(28, Math.round((calculateTreemapFontSize(rect.width, rect.height) ?? 12) * fontScale))
  const sizeFont = Math.min(20, Math.max(11, Math.round(14 * fontScale)), Math.floor(showName ? (rect.height - 12) / 2.5 : rect.height - 8))
  const maxWidth = rect.width - 14
  const sizeLabel = formatFileSize(rect.size)
  context.save()
  context.beginPath()
  context.rect(rect.x + 4, rect.y + 4, Math.max(0, rect.width - 8), Math.max(0, rect.height - 8))
  context.clip()
  context.fillStyle = '#ffffff'
  context.textAlign = 'center'
  context.textBaseline = 'middle'

  let fittedSize = sizeFont
  context.font = `600 ${fittedSize}px "Microsoft YaHei UI"`
  while (fittedSize > 10 && context.measureText(sizeLabel).width > maxWidth) {
    fittedSize -= 1
    context.font = `600 ${fittedSize}px "Microsoft YaHei UI"`
  }
  if (context.measureText(sizeLabel).width > maxWidth) { context.restore(); return }

  const centerX = rect.x + rect.width / 2
  const centerY = rect.y + rect.height / 2
  if (showName) {
    const nameY = centerY - (showShare ? 22 * fontScale : 12 * fontScale)
    context.font = `700 ${nameSize}px "Microsoft YaHei UI"`
    context.fillText(fitText(context, rect.name, maxWidth), centerX, nameY)
  }
  context.font = `600 ${fittedSize}px "Microsoft YaHei UI"`
  context.fillText(sizeLabel, centerX, centerY + (showName && !showShare ? 14 * fontScale : 3 * fontScale))
  if (showShare) {
    context.font = `400 ${Math.min(14, Math.round(12 * fontScale))}px "Microsoft YaHei UI"`
    context.fillStyle = '#e2e8f0'
    context.fillText(formatSizeShare(rect.size, totalSize.value), centerX, centerY + 26 * fontScale)
  }
  context.restore()
}

function fitText(context: CanvasRenderingContext2D, text: string, width: number): string {
  if (context.measureText(text).width <= width) return text
  const characters = [...text]
  while (characters.length && context.measureText(`${characters.join('')}…`).width > width) characters.pop()
  return characters.length ? `${characters.join('')}…` : ''
}

function handlePointerMove(event: PointerEvent): void {
  pointer = { clientX: event.clientX, clientY: event.clientY }
  refreshHover()
}

function clearHover(): void {
  pointer = undefined
  hovered.value = undefined
}

function refreshHover(): void {
  const target = canvas.value
  if (!target || !pointer) { hovered.value = undefined; return }
  const bounds = target.getBoundingClientRect()
  const x = pointer.clientX - bounds.left
  const y = pointer.clientY - bounds.top
  hovered.value = hitTest(x, y)
  if (!hovered.value) return
  void nextTick(() => {
    const tooltip = tooltipElement.value
    if (!tooltip || !hovered.value) return
    // 使用实际排版尺寸，鼠标靠近右侧或底部时把详情留在可见面板内。
    tooltipPosition.value = {
      x: Math.max(6, Math.min(x + 12, bounds.width - tooltip.offsetWidth - 6)),
      y: Math.max(6, Math.min(y + 12, bounds.height - tooltip.offsetHeight - 6))
    }
  })
}

function handleClick(event: MouseEvent): void {
  const target = canvas.value
  if (!target) return
  const bounds = target.getBoundingClientRect()
  const rect = hitTest(event.clientX - bounds.left, event.clientY - bounds.top)
  if (rect) emit('open', rect)
}

function hitTest(x: number, y: number): TreemapRect | undefined {
  return rectangles.find((rect) => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height)
}
</script>

<template>
  <div class="treemap-host">
    <canvas
      ref="canvas"
      :style="{ cursor: hovered?.isDirectory ? 'pointer' : 'default' }"
      role="img"
      :aria-label="`大小分布，${nodes.length} 项，共 ${formatFileSize(totalSize)}；详情也可在左侧列表查看`"
      @pointermove="handlePointerMove"
      @pointerleave="clearHover"
      @click="handleClick"
    />
    <div v-if="hovered" ref="tooltipElement" class="treemap-tooltip" :style="{ left: `${tooltipPosition.x}px`, top: `${tooltipPosition.y}px` }">
      <strong>{{ hovered.name }}</strong>
      <span class="tooltip-size">{{ formatFileSize(hovered.size) }} <span>· {{ formatSizeShare(hovered.size, totalSize) }}</span></span>
      <span>{{ formatExactFileSize(hovered.size) }}</span>
      <span v-if="hovered.logicalSize !== undefined && hovered.logicalSize > hovered.size">路径合计 {{ formatFileSize(hovered.logicalSize) }}，共享硬链接 {{ formatFileSize(hovered.logicalSize - hovered.size) }}</span>
      <span class="tooltip-path">{{ hovered.path }}</span>
      <span v-if="hovered.isDirectory" class="tooltip-action">点击进入文件夹</span>
    </div>
    <div v-if="nodes.length === 0" class="treemap-empty">{{ emptyText }}</div>
  </div>
</template>

<style scoped>
.treemap-host { position: relative; width: 100%; height: 100%; min-height: 0; overflow: hidden; background: var(--canvas-background); }
canvas { display: block; width: 100%; height: 100%; }
.treemap-tooltip { position: absolute; z-index: 3; display: flex; flex-direction: column; gap: 4px; width: max-content; max-width: min(320px, calc(100% - 12px)); max-height: calc(100% - 12px); overflow: hidden; padding: 10px 12px; color: #e2e8f0; border: 1px solid rgb(255 255 255 / 18%); border-radius: 6px; background: rgb(15 23 42 / 96%); box-shadow: 0 4px 16px rgb(0 0 0 / 20%); font-size: var(--ui-font-xs); pointer-events: none; overflow-wrap: anywhere; }
.treemap-tooltip strong { color: white; font-size: var(--ui-font-sm); }
.tooltip-size { color: white; font-size: var(--ui-font-lg); font-weight: 700; font-variant-numeric: tabular-nums; }
.tooltip-size > span { color: #cbd5e1; font-size: var(--ui-font-sm); font-weight: 400; }
.tooltip-path { display: -webkit-box; overflow: hidden; -webkit-line-clamp: 2; -webkit-box-orient: vertical; color: #94a3b8; }
.tooltip-action { margin-top: 3px; color: #cbd5e1; }
.treemap-empty { position: absolute; inset: 0; display: grid; place-items: center; padding: 20px; color: var(--text-muted); text-align: center; pointer-events: none; }
</style>
