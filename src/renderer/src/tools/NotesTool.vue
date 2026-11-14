<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onMounted, ref, type Directive } from 'vue'
import { AlarmClock, CalendarDays, ImagePlus, Plus, Search, Trash2, X } from '@lucide/vue'
import {
  NButton, NEmpty, NIcon, NInput, NModal, NPopconfirm, NSelect, NSwitch, NTooltip, useMessage
} from 'naive-ui'
import type { NoteInput, NoteReminder, ReminderType, StickyNote } from '@shared/electron-api'
import { hasSameReminderSchedule } from '@shared/reminder-rules'
import ToolPage from '../components/ToolPage.vue'
import HolidayCalendar from '../components/HolidayCalendar.vue'
import NoteImageViewer from '../components/NoteImageViewer.vue'
import { createMasonryLayout } from '../utils/masonry-layout'

const message = useMessage()
const notes = ref<StickyNote[]>([])
const loading = ref(true)
const search = ref('')
const scrollHost = ref<HTMLElement>()
const editorVisible = ref(false)
const editingId = ref<string>()
const editorContent = ref('')
const editorImages = ref<string[]>([])
const temporaryImages = ref<string[]>([])
const editorReminderEnabled = ref(false)
const reminderType = ref<ReminderType>('once')
const reminderTime = ref('09:00')
const onceDate = ref(formatDate(new Date()))
const startDate = ref(formatDate(new Date()))
const endDate = ref(formatDate(new Date()))
const calendarVisible = ref(false)
const viewerVisible = ref(false)
const viewerImages = ref<string[]>([])
const viewerIndex = ref(0)
const fileInput = ref<HTMLInputElement>()
const masonry = createMasonryLayout()
let pendingLoad: Promise<void> | undefined

/** 根据卡片真实高度分配网格行，让后续卡片自动填入当前最短列。 */
const vMasonryItem: Directive<HTMLElement> = {
  mounted: (element) => masonry.observe(element),
  beforeUnmount: (element) => masonry.unobserve(element)
}
onBeforeUnmount(() => masonry.disconnect())

const filteredNotes = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  return keyword ? notes.value.filter((note) => note.content.toLowerCase().includes(keyword)) : notes.value
})

const reminderOptions = [
  { label: '单次提醒', value: 'once' },
  { label: '每日提醒', value: 'daily' },
  { label: '工作日提醒', value: 'workday' },
  { label: '日期范围', value: 'dateRange' }
]

/** 首次进入页面时读取便签。 */
onMounted(loadNotes)

/** 从其他工具切回时刷新提醒状态。 */
onActivated(() => void loadNotes())

/** 从主进程读取全部便签。 */
async function loadNotes(): Promise<void> {
  // KeepAlive 首次进入同时调用 mounted 和 activated，共用同一次读取。
  if (pendingLoad) return pendingLoad
  pendingLoad = fetchNotes()
  try {
    await pendingLoad
  } finally {
    pendingLoad = undefined
  }
}

async function fetchNotes(): Promise<void> {
  loading.value = true
  try {
    notes.value = await window.electronApi.notes.list()
  } catch (error) {
    message.error(`读取便签失败：${formatError(error)}`)
  } finally {
    loading.value = false
  }
}

/** 打开新建便签弹窗。 */
function openCreate(): void {
  editingId.value = undefined
  editorContent.value = ''
  editorImages.value = []
  temporaryImages.value = []
  editorReminderEnabled.value = false
  reminderType.value = 'once'
  reminderTime.value = '09:00'
  onceDate.value = formatDate(new Date())
  startDate.value = onceDate.value
  endDate.value = onceDate.value
  editorVisible.value = true
}

/** 打开现有便签编辑弹窗。 */
function openEdit(note: StickyNote): void {
  editingId.value = note.id
  editorContent.value = note.content
  editorImages.value = [...note.imageNames]
  temporaryImages.value = []
  editorReminderEnabled.value = Boolean(note.reminder?.enabled)
  reminderType.value = note.reminder?.type ?? 'once'
  reminderTime.value = `${String(note.reminder?.hour ?? 9).padStart(2, '0')}:${String(note.reminder?.minute ?? 0).padStart(2, '0')}`
  onceDate.value = note.reminder?.onceDate ?? formatDate(new Date())
  startDate.value = note.reminder?.startDate ?? formatDate(new Date())
  endDate.value = note.reminder?.endDate ?? formatDate(new Date())
  editorVisible.value = true
}

/** 保存新建或编辑后的便签。 */
async function saveNote(): Promise<void> {
  if (!editorContent.value.trim() && editorImages.value.length === 0) {
    message.warning('便签文字和图片不能同时为空')
    return
  }
  const input: NoteInput = {
    content: editorContent.value,
    imageNames: [...editorImages.value],
    reminder: buildReminder()
  }
  try {
    if (editingId.value) await window.electronApi.notes.update(editingId.value, input)
    else await window.electronApi.notes.create(input)
    temporaryImages.value = []
    editorVisible.value = false
    await loadNotes()
    message.success('便签已保存')
  } catch (error) {
    message.error(`保存便签失败：${formatError(error)}`)
  }
}

/** 根据编辑器字段构建提醒，关闭提醒时返回空值。 */
function buildReminder(): NoteReminder | undefined {
  if (!editorReminderEnabled.value) return undefined
  const [hour, minute] = reminderTime.value.split(':').map(Number)
  const previous = notes.value.find((note) => note.id === editingId.value)?.reminder
  const reminder: NoteReminder = {
    type: reminderType.value,
    hour,
    minute,
    enabled: true
  }
  if (reminderType.value === 'once') reminder.onceDate = onceDate.value
  if (reminderType.value === 'dateRange') {
    reminder.startDate = startDate.value
    reminder.endDate = endDate.value
  }
  if (previous && hasSameReminderSchedule(previous, reminder)) {
    reminder.lastTriggered = previous.lastTriggered
  }
  return reminder
}

/** 取消编辑并清理本次会话新增的临时图片。 */
async function cancelEditor(): Promise<void> {
  editorVisible.value = false
  await Promise.all(temporaryImages.value.map((name) => window.electronApi.notes.deleteTempImage(name)))
  temporaryImages.value = []
}

/** 删除一个便签。 */
async function deleteNote(note: StickyNote): Promise<void> {
  await window.electronApi.notes.delete(note.id)
  notes.value = notes.value.filter((item) => item.id !== note.id)
  message.success('便签已删除')
}

/** 清空全部便签。 */
async function clearNotes(): Promise<void> {
  await window.electronApi.notes.clear()
  notes.value = []
  message.success('全部便签已清空')
}

/** 从隐藏文件框读取图片。 */
async function handleFileSelection(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  await addImageFiles([...input.files ?? []])
  input.value = ''
}

/** 处理编辑区粘贴，遇到图片时保存图片，纯文本交给浏览器默认行为。 */
async function handlePaste(event: ClipboardEvent): Promise<void> {
  const files = [...event.clipboardData?.files ?? []].filter((file) => file.type.startsWith('image/'))
  if (files.length === 0) return
  event.preventDefault()
  await addImageFiles(files)
}

/** 处理拖入编辑区的图片。 */
async function handleDrop(event: DragEvent): Promise<void> {
  event.preventDefault()
  const files = [...event.dataTransfer?.files ?? []].filter((file) => file.type.startsWith('image/'))
  await addImageFiles(files)
}

/** 逐张保存图片并记录为本次会话临时文件。 */
async function addImageFiles(files: File[]): Promise<void> {
  for (const file of files) {
    try {
      const imageName = await window.electronApi.notes.saveImage(await fileToDataUrl(file))
      editorImages.value.push(imageName)
      temporaryImages.value.push(imageName)
    } catch (error) {
      message.error(`添加图片失败：${formatError(error)}`)
    }
  }
}

/** 从编辑器中移除一张图片，新图片会立刻清理临时文件。 */
async function removeEditorImage(imageName: string): Promise<void> {
  editorImages.value = editorImages.value.filter((name) => name !== imageName)
  if (temporaryImages.value.includes(imageName)) {
    await window.electronApi.notes.deleteTempImage(imageName)
    temporaryImages.value = temporaryImages.value.filter((name) => name !== imageName)
  }
}

/** 打开图片查看器。 */
function openViewer(images: string[], index: number): void {
  viewerImages.value = images
  viewerIndex.value = index
  viewerVisible.value = true
}

/** 处理 Home、End、PageUp 和 PageDown 滚动。 */
function handleListKey(event: KeyboardEvent): void {
  const host = scrollHost.value
  if (!host || !['Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) return
  event.preventDefault()
  if (event.key === 'Home') host.scrollTo({ top: 0, behavior: 'smooth' })
  if (event.key === 'End') host.scrollTo({ top: host.scrollHeight, behavior: 'smooth' })
  if (event.key === 'PageUp') host.scrollBy({ top: -host.clientHeight, behavior: 'smooth' })
  if (event.key === 'PageDown') host.scrollBy({ top: host.clientHeight, behavior: 'smooth' })
}

/** 把文件读取为 data URL。 */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

/** 格式化本地日期为输入框需要的 yyyy-MM-dd。 */
function formatDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** 生成便签卡片上简短明确的提醒说明。 */
function formatReminder(reminder: NoteReminder): string {
  const time = `${String(reminder.hour).padStart(2, '0')}:${String(reminder.minute).padStart(2, '0')}`
  if (reminder.type === 'daily') return `每日 ${time}`
  if (reminder.type === 'workday') return `工作日 ${time}`
  if (reminder.type === 'dateRange') return `日期范围 ${time}`
  return `${reminder.onceDate ?? '单次'} ${time}`
}

/** 把未知异常转换成中文提示中的明文。 */
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
</script>

<template>
  <ToolPage title="便签与提醒">
    <template #actions>
      <NInput v-model:value="search" clearable placeholder="搜索便签" class="notes-search">
        <template #prefix><NIcon :component="Search" /></template>
      </NInput>
      <NTooltip><template #trigger><NButton circle quaternary @click="calendarVisible = true"><template #icon><NIcon :component="CalendarDays" /></template></NButton></template>节假日日历</NTooltip>
      <NPopconfirm @positive-click="clearNotes"><template #trigger><NButton secondary type="error"><template #icon><NIcon :component="Trash2" /></template>清空全部</NButton></template>确定删除全部便签和图片吗？</NPopconfirm>
      <NButton type="primary" @click="openCreate"><template #icon><NIcon :component="Plus" /></template>新建便签</NButton>
    </template>
    <template #status><span class="status-text">{{ filteredNotes.length }} 条</span></template>

    <div ref="scrollHost" class="notes-scroll" tabindex="0" :aria-busy="loading" @keydown="handleListKey">
      <div v-if="loading && notes.length === 0" class="notes-loading" role="status">正在读取便签…</div>
      <NEmpty v-else-if="filteredNotes.length === 0" description="暂无便签" class="notes-empty" />
      <div v-else class="notes-columns">
        <div v-for="note in filteredNotes" :key="note.id" v-masonry-item class="note-cell">
          <article class="note-card" :style="{ background: note.color }" @dblclick="openEdit(note)">
            <div class="note-card-actions">
              <NButton size="tiny" quaternary @dblclick.stop @click.stop="openEdit(note)">编辑</NButton>
              <NPopconfirm @positive-click="deleteNote(note)"><template #trigger><NButton size="tiny" quaternary type="error" @dblclick.stop @click.stop><template #icon><NIcon :component="X" /></template></NButton></template>确定删除这条便签吗？</NPopconfirm>
            </div>
            <p>{{ note.content }}</p>
            <div v-if="note.imageNames.length" class="note-images">
              <img v-for="(image, index) in note.imageNames.slice(0, 4)" :key="image" :src="`note-image://image/${encodeURIComponent(image)}`" alt="便签图片" @dblclick.stop @click.stop="openViewer(note.imageNames, index)" />
            </div>
            <footer>
              <span>{{ new Date(note.updatedAt).toLocaleString() }}</span>
              <span v-if="note.reminder" class="note-reminder"><AlarmClock :size="13" />{{ formatReminder(note.reminder) }}</span>
            </footer>
          </article>
        </div>
      </div>
    </div>
  </ToolPage>

  <NModal :show="editorVisible" preset="card" :title="editingId ? '编辑便签' : '新建便签'" class="note-editor-modal" style="width: min(720px, 94vw)" :mask-closable="false" @update:show="!$event && cancelEditor()">
    <div class="note-editor-drop" @dragover.prevent @drop="handleDrop">
      <textarea v-model="editorContent" rows="8" placeholder="输入便签内容，或粘贴截图..." @paste="handlePaste" />
      <div v-if="editorImages.length" class="editor-image-list">
        <div v-for="(image, index) in editorImages" :key="image">
          <img :src="`note-image://image/${encodeURIComponent(image)}`" alt="待保存图片" @click="openViewer(editorImages, index)" />
          <button aria-label="移除图片" @click="removeEditorImage(image)">×</button>
        </div>
      </div>
      <input ref="fileInput" hidden type="file" multiple accept="image/*" @change="handleFileSelection" />
      <NButton secondary @click="fileInput?.click()"><template #icon><NIcon :component="ImagePlus" /></template>添加图片</NButton>
    </div>
    <div class="reminder-settings">
      <label><NSwitch v-model:value="editorReminderEnabled" /> 启用提醒</label>
      <template v-if="editorReminderEnabled">
        <NSelect v-model:value="reminderType" :options="reminderOptions" class="reminder-type" />
        <label>时间<input v-model="reminderTime" type="time" /></label>
        <label v-if="reminderType === 'once'">日期<input v-model="onceDate" type="date" /></label>
        <template v-if="reminderType === 'dateRange'">
          <label>开始<input v-model="startDate" type="date" /></label>
          <label>结束<input v-model="endDate" type="date" /></label>
        </template>
      </template>
    </div>
    <template #footer><div class="modal-actions"><NButton @click="cancelEditor">取消</NButton><NButton type="primary" @click="saveNote">保存</NButton></div></template>
  </NModal>

  <HolidayCalendar v-model:show="calendarVisible" />
  <NoteImageViewer v-model:show="viewerVisible" :images="viewerImages" :initial-index="viewerIndex" />
</template>

<style scoped>
.notes-search { width: min(280px, 35vw); }
.notes-scroll { height: 100%; overflow: auto; scrollbar-gutter: stable; padding: 2px 3px 12px 2px; outline: none; }
.notes-loading { padding: 24px; color: var(--text-muted); text-align: center; }
.notes-empty { margin-top: 18vh; }
.notes-columns { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(270px, 100%), 1fr)); grid-auto-flow: row dense; grid-auto-rows: 8px; gap: 12px; align-items: start; }
.note-cell { min-width: 0; }
/* 在首轮测量前不绘制挤在单行中的卡片，避免文字叠加造成模糊和闪烁。 */
.note-cell:not([data-masonry-ready]) { visibility: hidden; }
.note-card { position: relative; width: 100%; padding: 14px; color: #20302f; border: 1px solid rgb(32 48 47 / 28%); border-radius: 6px; box-shadow: 0 2px 7px rgb(22 78 72 / 16%); }
.note-card p { min-height: 44px; margin: 22px 0 10px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
.note-card-actions { position: absolute; top: 5px; right: 5px; display: flex; }
.note-card-actions :deep(.n-button) { color: #15312f; }
.note-images { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5px; }
.note-images img { display: block; width: 100%; aspect-ratio: 4 / 3; object-fit: cover; border: 1px solid rgb(0 0 0 / 20%); cursor: zoom-in; }
.note-card footer { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px 10px; margin-top: 12px; padding-top: 9px; color: rgb(0 0 0 / 58%); border-top: 1px solid rgb(32 48 47 / 14%); font-size: var(--ui-font-xs); }
.note-reminder { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.note-editor-drop { display: flex; flex-direction: column; gap: 10px; }
.note-editor-drop textarea { width: 100%; resize: vertical; padding: 10px; color: var(--text-color); border: 1px solid var(--border-color); border-radius: 4px; background: var(--surface-color); font: inherit; }
.editor-image-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(90px, 1fr)); gap: 8px; }
.editor-image-list > div { position: relative; aspect-ratio: 4 / 3; }
.editor-image-list img { width: 100%; height: 100%; object-fit: cover; cursor: zoom-in; }
.editor-image-list button { position: absolute; top: 3px; right: 3px; width: 24px; height: 24px; color: white; border: 0; border-radius: 50%; background: rgb(185 28 28 / 88%); cursor: pointer; }
.reminder-settings { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border-color); }
.reminder-settings label { display: flex; align-items: center; gap: 6px; }
.reminder-type { width: 142px; }
.reminder-settings input { height: 34px; padding: 0 6px; color: var(--text-color); border: 1px solid var(--border-color); border-radius: 4px; background: var(--surface-color); }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
