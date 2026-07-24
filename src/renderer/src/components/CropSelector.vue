<script setup lang="ts">
import { computed, ref } from 'vue'
import type { WechatCaptureCrop } from '@shared/wechat-capture'

const props = defineProps<{
  crop: WechatCaptureCrop
  imageUrl: string
  alt: string
  disabled?: boolean
  sourceWidth?: number
  sourceHeight?: number
}>()

const emit = defineEmits<{ 'update:crop': [value: WechatCaptureCrop] }>()

type DragKind = 'draw' | 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

interface DragState {
  kind: DragKind
  start: { x: number; y: number }
  initial: WechatCaptureCrop
}

/** 可见区域下限（百分比）；主进程要求左右、上下裁掉之和小于 90。 */
const MIN_SIZE = 12
const MAX_EDGE = 80

const drag = ref<DragState | null>(null)

const aspect = computed(() =>
  props.sourceWidth && props.sourceHeight ? `${props.sourceWidth} / ${props.sourceHeight}` : '16 / 10'
)
const outlineStyle = computed(() => ({
  left: `${props.crop.left}%`,
  top: `${props.crop.top}%`,
  right: `${props.crop.right}%`,
  bottom: `${props.crop.bottom}%`
}))
const pixelLabel = computed(() => {
  if (!props.sourceWidth || !props.sourceHeight) return '聊天记录区域'
  const width = Math.round(props.sourceWidth * (100 - props.crop.left - props.crop.right) / 100)
  const height = Math.round(props.sourceHeight * (100 - props.crop.top - props.crop.bottom) / 100)
  return `${width} × ${height} px`
})

function onPointerDown(event: PointerEvent): void {
  if (props.disabled || event.button !== 0) return
  const handle = (event.target as HTMLElement).closest<HTMLElement>('[data-drag]')
  drag.value = {
    kind: (handle?.dataset.drag as DragKind | undefined) ?? 'draw',
    start: toPercent(event),
    initial: { ...props.crop }
  }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  event.preventDefault()
}

function onPointerMove(event: PointerEvent): void {
  if (!drag.value || props.disabled) return
  applyDrag(toPercent(event))
}

function onPointerUp(event: PointerEvent): void {
  const state = drag.value
  if (!state) return
  drag.value = null
  const point = toPercent(event)
  if (state.kind === 'draw') {
    const width = Math.abs(point.x - state.start.x)
    const height = Math.abs(point.y - state.start.y)
    if (width < 5 || height < 5) emit('update:crop', { ...state.initial })
    else applyDragState(state, point)
  } else {
    applyDragState(state, point)
  }
  const target = event.currentTarget as HTMLElement
  if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
}

function applyDrag(point: { x: number; y: number }): void {
  if (drag.value) applyDragState(drag.value, point)
}

function applyDragState(state: DragState, point: { x: number; y: number }): void {
  const { kind, start, initial } = state
  const dx = point.x - start.x
  const dy = point.y - start.y
  const next = { ...initial }
  if (kind === 'draw') {
    const width = Math.abs(point.x - start.x)
    const height = Math.abs(point.y - start.y)
    if (width < 2 || height < 2) return
    next.left = Math.min(start.x, point.x)
    next.top = Math.min(start.y, point.y)
    next.right = 100 - next.left - width
    next.bottom = 100 - next.top - height
  } else if (kind === 'move') {
    next.left = clamp(initial.left + dx, 0, initial.left + initial.right)
    next.right = initial.left + initial.right - next.left
    next.top = clamp(initial.top + dy, 0, initial.top + initial.bottom)
    next.bottom = initial.top + initial.bottom - next.top
  } else {
    if (kind.includes('w')) next.left = clamp(initial.left + dx, 0, 100 - initial.right - MIN_SIZE)
    if (kind.includes('e')) next.right = clamp(initial.right - dx, 0, 100 - initial.left - MIN_SIZE)
    if (kind.includes('n')) next.top = clamp(initial.top + dy, 0, 100 - initial.bottom - MIN_SIZE)
    if (kind.includes('s')) next.bottom = clamp(initial.bottom - dy, 0, 100 - initial.top - MIN_SIZE)
  }
  emit('update:crop', sanitize(next))
}

/** 收敛到主进程校验允许的范围：每边不超过 80%，可见区域不小于 MIN_SIZE。 */
function sanitize(value: WechatCaptureCrop): WechatCaptureCrop {
  const left = clamp(value.left, 0, MAX_EDGE)
  const top = clamp(value.top, 0, MAX_EDGE)
  let right = clamp(value.right, 0, MAX_EDGE)
  let bottom = clamp(value.bottom, 0, MAX_EDGE)
  if (100 - left - right < MIN_SIZE) right = Math.max(0, 100 - left - MIN_SIZE)
  if (100 - top - bottom < MIN_SIZE) bottom = Math.max(0, 100 - top - MIN_SIZE)
  return { left: round1(left), top: round1(top), right: round1(right), bottom: round1(bottom) }
}

function toPercent(event: PointerEvent): { x: number; y: number } {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  return {
    x: clamp((event.clientX - rect.left) / rect.width * 100, 0, 100),
    y: clamp((event.clientY - rect.top) / rect.height * 100, 0, 100)
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}
</script>

<template>
  <div
    class="crop-selector"
    :class="{ disabled }"
    :style="{ aspectRatio: aspect }"
    aria-label="拖拽选择聊天记录截图区域"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  >
    <img :src="imageUrl" :alt="alt" draggable="false" />
    <div class="crop-mask crop-mask-top" :style="{ height: `${crop.top}%` }" />
    <div class="crop-mask crop-mask-bottom" :style="{ height: `${crop.bottom}%` }" />
    <div class="crop-mask crop-mask-left" :style="{ top: `${crop.top}%`, bottom: `${crop.bottom}%`, width: `${crop.left}%` }" />
    <div class="crop-mask crop-mask-right" :style="{ top: `${crop.top}%`, bottom: `${crop.bottom}%`, width: `${crop.right}%` }" />
    <div class="crop-outline" :style="outlineStyle" data-drag="move">
      <span class="crop-label">{{ pixelLabel }}</span>
      <i class="edge edge-n" data-drag="n" />
      <i class="edge edge-s" data-drag="s" />
      <i class="edge edge-w" data-drag="w" />
      <i class="edge edge-e" data-drag="e" />
      <i class="handle handle-nw" data-drag="nw" />
      <i class="handle handle-ne" data-drag="ne" />
      <i class="handle handle-sw" data-drag="sw" />
      <i class="handle handle-se" data-drag="se" />
    </div>
  </div>
</template>

<style scoped>
.crop-selector { position: relative; overflow: hidden; border: 1px solid var(--border-color); border-radius: 5px; background: #17191c; cursor: crosshair; touch-action: none; user-select: none; }
.crop-selector.disabled { cursor: not-allowed; }
.crop-selector.disabled .crop-outline, .crop-selector.disabled .handle, .crop-selector.disabled .edge { cursor: not-allowed; }
.crop-selector img { display: block; width: 100%; height: 100%; object-fit: fill; pointer-events: none; user-select: none; }
.crop-mask { position: absolute; z-index: 1; background: rgb(8 10 12 / 62%); pointer-events: none; }
.crop-mask-top { inset: 0 0 auto; }
.crop-mask-bottom { inset: auto 0 0; }
.crop-mask-left { left: 0; }
.crop-mask-right { right: 0; }
.crop-outline { position: absolute; z-index: 2; border: 2px solid #18a058; box-shadow: inset 0 0 0 1px rgb(255 255 255 / 50%); cursor: move; }
.crop-label { position: absolute; top: 6px; left: 7px; padding: 3px 6px; border-radius: 3px; color: #fff; background: #168653; font-size: var(--ui-font-xs); pointer-events: none; }
.edge { position: absolute; z-index: 3; }
.edge-n { top: -5px; left: 10px; right: 10px; height: 10px; cursor: ns-resize; }
.edge-s { bottom: -5px; left: 10px; right: 10px; height: 10px; cursor: ns-resize; }
.edge-w { top: 10px; bottom: 10px; left: -5px; width: 10px; cursor: ew-resize; }
.edge-e { top: 10px; bottom: 10px; right: -5px; width: 10px; cursor: ew-resize; }
.handle { position: absolute; z-index: 4; width: 13px; height: 13px; }
.handle::after { content: ''; position: absolute; inset: 2px; border: 1px solid #fff; background: #18a058; }
.handle-nw { top: -7px; left: -7px; cursor: nwse-resize; }
.handle-ne { top: -7px; right: -7px; cursor: nesw-resize; }
.handle-sw { bottom: -7px; left: -7px; cursor: nesw-resize; }
.handle-se { right: -7px; bottom: -7px; cursor: nwse-resize; }
</style>
