<script setup lang="ts">
import { computed, ref } from 'vue'
import { FilePlus2 } from '@lucide/vue'
import { NIcon } from 'naive-ui'

const props = withDefaults(defineProps<{
  accept: 'image' | 'video'
  multiple?: boolean
  disabled?: boolean
  compact?: boolean
}>(), { multiple: false, disabled: false, compact: false })

const emit = defineEmits<{
  select: []
  files: [paths: string[]]
}>()

const dragging = ref(false)
const label = computed(() => props.accept === 'image'
  ? props.multiple ? '点击选择或拖入多张图片' : '点击选择或拖入图片'
  : '点击选择或拖入视频')

/** 接收拖入文件，并通过 preload 转换成真实路径。 */
function handleDrop(event: DragEvent): void {
  event.preventDefault()
  dragging.value = false
  if (props.disabled) return
  const files = [...event.dataTransfer?.files ?? []]
  const selected = props.multiple ? files : files.slice(0, 1)
  const paths = selected.map((file) => window.electronApi.media.pathForFile(file)).filter(Boolean)
  if (paths.length > 0) emit('files', paths)
}

/** 处理点击选择命令。 */
function handleSelect(): void {
  if (!props.disabled) emit('select')
}
</script>

<template>
  <button
    type="button"
    class="media-drop-zone"
    :class="{ dragging, compact }"
    :disabled="disabled"
    @click="handleSelect"
    @dragenter.prevent="dragging = true"
    @dragover.prevent
    @dragleave.prevent="dragging = false"
    @drop="handleDrop"
  >
    <NIcon :component="FilePlus2" :size="compact ? 22 : 34" />
    <span>{{ label }}</span>
  </button>
</template>

<style scoped>
.media-drop-zone { display: grid; place-items: center; align-content: center; width: 100%; min-height: 140px; gap: 8px; padding: 16px; color: var(--text-muted); border: 2px dashed var(--border-color); border-radius: 6px; background: var(--surface-muted); cursor: pointer; }
.media-drop-zone:hover, .media-drop-zone.dragging { color: var(--accent-color); border-color: var(--accent-color); background: var(--active-background); }
.media-drop-zone:disabled { cursor: not-allowed; opacity: .55; }
.media-drop-zone.compact { min-height: 72px; padding: 10px; grid-template-columns: auto auto; }
</style>
