<script setup lang="ts">
import type { NormalizedCropRect } from '@shared/media-api'

const props = defineProps<{ rect: NormalizedCropRect }>()
const emit = defineEmits<{ change: [rect: NormalizedCropRect] }>()

type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
const handles: Handle[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

/** 按拖动类型更新归一化裁剪框。 */
function startDrag(event: PointerEvent, handle: Handle): void {
  event.preventDefault()
  event.stopPropagation()
  const host = (event.currentTarget as HTMLElement).parentElement
  if (!host) return
  const bounds = host.getBoundingClientRect()
  const startX = event.clientX
  const startY = event.clientY
  const initial = { ...props.rect }

  /** 处理指针移动，并保证裁剪框不小于 3%。 */
  function move(pointer: PointerEvent): void {
    const dx = (pointer.clientX - startX) / bounds.width
    const dy = (pointer.clientY - startY) / bounds.height
    let left = initial.x
    let top = initial.y
    let right = initial.x + initial.width
    let bottom = initial.y + initial.height
    if (handle === 'move') {
      left = Math.min(1 - initial.width, Math.max(0, initial.x + dx))
      top = Math.min(1 - initial.height, Math.max(0, initial.y + dy))
      right = left + initial.width
      bottom = top + initial.height
    } else {
      if (handle.includes('w')) left = Math.min(right - 0.03, Math.max(0, initial.x + dx))
      if (handle.includes('e')) right = Math.max(left + 0.03, Math.min(1, initial.x + initial.width + dx))
      if (handle.includes('n')) top = Math.min(bottom - 0.03, Math.max(0, initial.y + dy))
      if (handle.includes('s')) bottom = Math.max(top + 0.03, Math.min(1, initial.y + initial.height + dy))
    }
    emit('change', { x: left, y: top, width: right - left, height: bottom - top })
  }

  /** 结束本次拖动并释放全局监听。 */
  function end(): void {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', end)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', end)
}
</script>

<template>
  <div class="crop-shade crop-top" :style="{ height: `${rect.y * 100}%` }" />
  <div class="crop-shade crop-left" :style="{ top: `${rect.y * 100}%`, width: `${rect.x * 100}%`, height: `${rect.height * 100}%` }" />
  <div class="crop-shade crop-right" :style="{ top: `${rect.y * 100}%`, left: `${(rect.x + rect.width) * 100}%`, height: `${rect.height * 100}%` }" />
  <div class="crop-shade crop-bottom" :style="{ top: `${(rect.y + rect.height) * 100}%` }" />
  <div class="crop-box" :style="{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }" @pointerdown="startDrag($event, 'move')">
    <span v-for="handle in handles" :key="handle" class="crop-handle" :class="`handle-${handle}`" @pointerdown="startDrag($event, handle)" />
  </div>
</template>

<style scoped>
.crop-shade { position: absolute; z-index: 3; background: rgb(0 0 0 / 48%); pointer-events: none; }
.crop-top { inset: 0 0 auto; }
.crop-bottom { inset-inline: 0; bottom: 0; }
.crop-left { left: 0; }
.crop-right { right: 0; }
.crop-box { position: absolute; z-index: 4; border: 2px solid #fb923c; cursor: move; touch-action: none; }
.crop-box::before, .crop-box::after { content: ''; position: absolute; inset: 33.333% 0 auto; border-top: 1px dashed rgb(255 255 255 / 70%); }
.crop-box::after { inset: 66.666% 0 auto; }
.crop-handle { position: absolute; width: 12px; height: 12px; border: 2px solid #7c2d12; background: #fb923c; }
.handle-n { left: 50%; top: -7px; transform: translateX(-50%); cursor: ns-resize; }
.handle-s { left: 50%; bottom: -7px; transform: translateX(-50%); cursor: ns-resize; }
.handle-e { right: -7px; top: 50%; transform: translateY(-50%); cursor: ew-resize; }
.handle-w { left: -7px; top: 50%; transform: translateY(-50%); cursor: ew-resize; }
.handle-ne { right: -7px; top: -7px; cursor: nesw-resize; }
.handle-nw { left: -7px; top: -7px; cursor: nwse-resize; }
.handle-se { right: -7px; bottom: -7px; cursor: nwse-resize; }
.handle-sw { left: -7px; bottom: -7px; cursor: nesw-resize; }
</style>
