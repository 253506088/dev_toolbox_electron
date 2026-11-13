<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ArrowUp, Copy, File, Folder, HardDrive, RefreshCw, Search, SquareArrowOutUpRight } from '@lucide/vue'
import { NButton, NIcon, NInput, NSpin, NTooltip, NVirtualList, useMessage } from 'naive-ui'
import type { DirectoryBatchEvent, DriveInfo, FileEntry, FolderSizeEvent } from '@shared/electron-api'
import type { TreemapNode } from '@shared/treemap'
import { formatExactFileSize, formatFileSize } from '@shared/file-size-display'
import ToolPage from '../components/ToolPage.vue'
import TreemapCanvas from '../components/TreemapCanvas.vue'

const message = useMessage()
const drives = ref<DriveInfo[]>([])
const currentPath = ref('')
const address = ref('')
const entries = ref<FileEntry[]>([])
const loading = ref(true)
const splitPercent = ref(42)
const activeRequestId = ref('')
const splitHost = ref<HTMLElement>()
let stopBatch: (() => void) | undefined
let stopSize: (() => void) | undefined

const breadcrumbs = computed(() => buildBreadcrumbs(currentPath.value))
const treemapNodes = computed<TreemapNode[]>(() => entries.value
  .filter((entry) => Number.isFinite(entry.size) && (entry.size ?? 0) > 0)
  .map((entry) => ({ path: entry.path, name: entry.name, size: entry.size ?? 0, isDirectory: entry.isDirectory, logicalSize: entry.logicalSize ?? undefined })))
const totalSize = computed(() => treemapNodes.value.reduce((sum, node) => sum + node.size, 0))
const pendingEntries = computed(() => entries.value.filter((entry) => entry.sizeState === 'pending').length)
const incompleteEntries = computed(() => entries.value.filter((entry) => entry.sizeState === 'error' || entry.sizeState === 'partial').length)
const sharedBytes = computed(() => entries.value.reduce((sum, entry) => {
  if (entry.size === null || entry.logicalSize === null || entry.logicalSize === undefined) return sum
  if (!Number.isFinite(entry.size) || !Number.isFinite(entry.logicalSize)) return sum
  return sum + Math.max(0, entry.logicalSize - entry.size)
}, 0))
const isCalculating = computed(() => loading.value || pendingEntries.value > 0)
const treemapEmptyText = computed(() => {
  if (isCalculating.value) return '正在统计文件夹大小…'
  if (incompleteEntries.value) return '未能读取可展示的大小，请检查目录权限后刷新'
  if (sharedBytes.value > 0) return '共享内容已在当前目录的其他项目中计入'
  return entries.value.length ? '当前目录的项目大小均为 0 B' : '当前目录为空'
})

/** 页面挂载时订阅目录事件并读取磁盘。 */
onMounted(async () => {
  stopBatch = window.electronApi.files.onDirectoryBatch(handleDirectoryBatch)
  stopSize = window.electronApi.files.onFolderSize(handleFolderSize)
  await loadDrives()
})

/** 页面销毁时取消监听和当前后台任务。 */
onBeforeUnmount(() => {
  stopBatch?.()
  stopSize?.()
  if (activeRequestId.value) void window.electronApi.files.cancel(activeRequestId.value)
})

/** 读取所有可用盘符和容量。 */
async function loadDrives(): Promise<void> {
  const previousRequestId = activeRequestId.value
  activeRequestId.value = ''
  loading.value = true
  currentPath.value = ''
  address.value = ''
  entries.value = []
  try {
    if (previousRequestId) await window.electronApi.files.cancel(previousRequestId)
    const result = await window.electronApi.files.listDrives()
    if (!activeRequestId.value) drives.value = result
  } catch (error) {
    if (!activeRequestId.value) message.error(`读取磁盘失败：${formatError(error)}`)
  } finally {
    if (!activeRequestId.value) loading.value = false
  }
}

/** 进入目录并创建新的导航代次。 */
async function navigate(path: string): Promise<void> {
  const target = path.trim()
  if (!target) return
  const previousRequestId = activeRequestId.value
  const requestId = crypto.randomUUID()
  activeRequestId.value = requestId
  currentPath.value = target
  address.value = target
  entries.value = []
  loading.value = true
  try {
    if (previousRequestId) await window.electronApi.files.cancel(previousRequestId)
    if (activeRequestId.value !== requestId) return
    await window.electronApi.files.listDirectory(target, requestId)
  } catch (error) {
    if (activeRequestId.value !== requestId) return
    loading.value = false
    message.error(`进入目录失败：${formatError(error)}`)
  }
}

/** 接收属于当前代次的目录批次。 */
function handleDirectoryBatch(event: DirectoryBatchEvent): void {
  if (event.requestId !== activeRequestId.value) return
  if (event.error) message.error(`目录读取失败：${event.error}`)
  entries.value.push(...event.entries)
  if (event.done) loading.value = false
}

/** 接收属于当前代次的文件夹大小并更新对应行。 */
function handleFolderSize(event: FolderSizeEvent): void {
  if (event.requestId !== activeRequestId.value) return
  const entry = entries.value.find((item) => item.path === event.path)
  if (!entry) return
  entry.size = event.size
  entry.logicalSize = event.logicalSize ?? event.size
  entry.skippedEntries = event.skippedEntries
  entry.sizeState = event.error && event.size === null ? 'error' : event.error || event.skippedEntries ? 'partial' : 'ready'
}

/** 点击列表或 Treemap 节点时仅进入文件夹，普通文件不执行。 */
function openEntry(entry: Pick<FileEntry, 'path' | 'isDirectory'>): void {
  if (entry.isDirectory) void navigate(entry.path)
}

/** 返回当前目录的上一级。 */
function goParent(): void {
  if (!currentPath.value) return
  const trimmed = currentPath.value.replace(/[\\/]+$/, '')
  if (/^[a-z]:$/i.test(trimmed)) { void loadDrives(); return }
  const index = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  const parent = index <= 2 ? `${trimmed.slice(0, 2)}\\` : trimmed.slice(0, index)
  void navigate(parent)
}

/** 刷新当前页面或磁盘列表。 */
function refresh(): void {
  if (currentPath.value) void navigate(currentPath.value)
  else void loadDrives()
}

/** 复制当前完整目录地址。 */
async function copyAddress(): Promise<void> {
  await window.electronApi.clipboard.writeText(currentPath.value)
  message.success('完整路径已复制')
}

/** 在 Windows 文件管理器中打开当前目录。 */
async function openInExplorer(): Promise<void> {
  try {
    await window.electronApi.files.openInExplorer(currentPath.value)
  } catch (error) {
    message.error(`打开系统文件管理器失败：${formatError(error)}`)
  }
}

/** 拖动分隔条，限制左右宽度在 10% 到 90%。 */
function startResize(event: PointerEvent): void {
  const host = splitHost.value
  if (!host) return
  const bounds = host.getBoundingClientRect()
  const move = (moveEvent: PointerEvent): void => {
    splitPercent.value = Math.min(90, Math.max(10, ((moveEvent.clientX - bounds.left) / bounds.width) * 100))
  }
  const stop = (): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', stop)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', stop)
}

/** 把 Windows 路径拆成可以逐级点击的面包屑。 */
function buildBreadcrumbs(path: string): Array<{ label: string; path: string }> {
  if (!path) return []
  const normalized = path.replaceAll('/', '\\')
  const drive = normalized.slice(0, 3)
  const parts = normalized.slice(3).split('\\').filter(Boolean)
  const result = [{ label: drive, path: drive }]
  let current = drive.replace(/\\$/, '')
  for (const part of parts) {
    current = `${current}\\${part}`
    result.push({ label: part, path: current })
  }
  return result
}

/** 去重归属为零不等于空目录，详情保留共享和未读取项目的解释。 */
function entrySizeDetails(entry: FileEntry): string {
  if (entry.sizeState === 'pending') return '正在统计文件夹大小'
  if (entry.sizeState === 'error' || entry.size === null) return '无法读取大小，请检查访问权限'
  if (entry.isSymbolicLink) return '符号链接或目录联接：不跟随目标统计，避免重复计算和循环'
  const lines = [`当前视图计入 ${formatFileSize(entry.size)}（${formatExactFileSize(entry.size)}）`]
  if (entry.logicalSize !== undefined && entry.logicalSize !== null && entry.logicalSize > entry.size) {
    lines.push(`路径合计 ${formatFileSize(entry.logicalSize)}，共享硬链接 ${formatFileSize(entry.logicalSize - entry.size)}`)
    if (entry.size === 0) lines.push('共享内容已在其他项计入；进入此目录会按新范围重新统计')
  }
  if (entry.sizeState === 'partial') lines.push(`${entry.skippedEntries ?? '部分'} 个项目未能读取，当前显示已读取部分`)
  return lines.join('\n')
}

/** 计算磁盘已用容量。 */
function usedBytes(drive: DriveInfo): number {
  return Math.max(0, drive.totalBytes - drive.freeBytes)
}

/** 把未知异常变成人可读文字。 */
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
</script>

<template>
  <ToolPage title="Windows 文件管理器">
    <template #actions>
      <NTooltip><template #trigger><NButton circle quaternary :disabled="!currentPath" @click="goParent"><template #icon><NIcon :component="ArrowUp" /></template></NButton></template>上一级</NTooltip>
      <NTooltip><template #trigger><NButton circle quaternary @click="refresh"><template #icon><NIcon :component="RefreshCw" /></template></NButton></template>刷新</NTooltip>
      <NInput v-model:value="address" placeholder="输入完整目录路径" class="file-address" @keyup.enter="navigate(address)"><template #prefix><NIcon :component="Search" /></template></NInput>
      <NTooltip><template #trigger><NButton circle quaternary :disabled="!currentPath" @click="copyAddress"><template #icon><NIcon :component="Copy" /></template></NButton></template>复制完整路径</NTooltip>
      <NTooltip><template #trigger><NButton circle quaternary :disabled="!currentPath" @click="openInExplorer"><template #icon><NIcon :component="SquareArrowOutUpRight" /></template></NButton></template>在系统文件管理器中打开</NTooltip>
    </template>
    <template #status><span class="status-text">{{ currentPath ? `${entries.length} 项 · ${isCalculating ? '大小统计中' : incompleteEntries ? '部分内容未能读取' : '大小统计完成'}` : `${drives.length} 个磁盘` }}</span></template>

    <NSpin :show="loading && !currentPath">
      <div v-if="!currentPath" class="drive-grid">
        <button v-for="drive in drives" :key="drive.path" class="drive-item" @click="navigate(drive.path)">
          <NIcon :component="HardDrive" :size="30" />
          <strong>{{ drive.path }}</strong>
          <span>{{ formatFileSize(usedBytes(drive)) }} / {{ formatFileSize(drive.totalBytes) }}</span>
          <div><i :style="{ width: `${Math.min(100, usedBytes(drive) / drive.totalBytes * 100)}%` }" /></div>
        </button>
      </div>
    </NSpin>

    <div v-if="currentPath" class="file-manager-content">
      <div class="breadcrumbs">
        <button v-for="crumb in breadcrumbs" :key="crumb.path" @click="navigate(crumb.path)">{{ crumb.label }}</button>
      </div>
      <div ref="splitHost" class="file-split" :style="{ gridTemplateColumns: `${splitPercent}% 7px minmax(0, 1fr)` }">
        <section class="file-list-panel">
          <div class="file-list-header"><span>名称</span><span title="同一个硬链接文件在当前目录视图中只计入一次">计入大小</span><span>修改时间</span></div>
          <NVirtualList :items="entries" :item-size="38" key-field="path" class="file-virtual-list">
            <template #default="{ item }">
              <button class="file-row" :title="item.path" @dblclick="openEntry(item)">
                <span><NIcon :component="item.isDirectory ? Folder : File" />{{ item.name }}</span>
                <span class="file-size-cell" :title="entrySizeDetails(item)">
                  <span>{{ item.sizeState === 'error' ? '无法读取' : formatFileSize(item.size) }}</span>
                  <small v-if="item.sizeState === 'partial'">部分读取</small>
                  <small v-else-if="item.isSymbolicLink">链接未跟随</small>
                  <small v-else-if="item.size === 0 && item.logicalSize > 0">共享内容已计入</small>
                </span>
                <span>{{ item.modifiedAt ? new Date(item.modifiedAt).toLocaleString() : '-' }}</span>
              </button>
            </template>
          </NVirtualList>
          <div v-if="loading" class="file-loading"><NSpin size="small" /> 正在分批读取...</div>
        </section>
        <div class="split-handle" @pointerdown="startResize" />
        <section class="treemap-panel">
          <header class="size-summary" aria-live="polite">
            <div>
              <span class="size-summary-label">{{ isCalculating || incompleteEntries ? '已统计大小' : '总大小' }} · 硬链接去重</span>
              <strong :title="formatExactFileSize(totalSize)">{{ formatFileSize(totalSize) }}</strong>
              <span class="size-summary-exact">{{ formatExactFileSize(totalSize) }}</span>
            </div>
            <div class="size-scan-state">
              <span v-if="loading">正在读取目录…</span>
              <span v-else-if="pendingEntries">还有 {{ pendingEntries }} 项待统计</span>
              <span v-else>{{ incompleteEntries ? '统计结束，部分内容无法读取' : '统计完成' }}</span>
              <span v-if="incompleteEntries" class="size-partial">{{ incompleteEntries }} 项未完整读取</span>
              <span v-if="sharedBytes > 0">已排除重复 {{ formatFileSize(sharedBytes) }}</span>
            </div>
          </header>
          <div class="treemap-stage"><TreemapCanvas :nodes="treemapNodes" :empty-text="treemapEmptyText" @open="openEntry" /></div>
          <p class="size-explanation">面积按已统计大小占比。硬链接在当前目录中仅计一次，进入子目录会重新统计；此处为文件内容大小，并非磁盘实际占用。</p>
        </section>
      </div>
    </div>
  </ToolPage>
</template>

<style scoped>
.file-address { min-width: 260px; max-width: 680px; }
.drive-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; padding: 4px; }
.drive-item { display: grid; grid-template-columns: 40px 1fr; gap: 5px 10px; align-items: center; padding: 14px; color: var(--text-color); border: var(--panel-border); border-radius: 6px; background: var(--surface-color); box-shadow: var(--panel-shadow); text-align: left; cursor: pointer; }
.drive-item strong { font-size: var(--ui-font-xl); }
.drive-item span, .drive-item > div { grid-column: 2; }
.drive-item span { color: var(--text-muted); font-size: var(--ui-font-sm); }
.drive-item > div { height: 6px; overflow: hidden; border-radius: 3px; background: var(--row-divider); }
.drive-item i { display: block; height: 100%; background: var(--success-color); }
.file-manager-content { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.breadcrumbs { display: flex; gap: 3px; min-height: 34px; overflow-x: auto; }
.breadcrumbs button { flex: 0 0 auto; height: 28px; padding: 0 8px; color: var(--text-color); border: 1px solid var(--border-color); border-radius: 4px; background: var(--surface-muted); cursor: pointer; }
.file-split { display: grid; flex: 1; min-height: 0; overflow: hidden; }
.file-list-panel, .treemap-panel { position: relative; min-width: 0; min-height: 0; overflow: hidden; border: 1px solid var(--border-color); }
.treemap-panel { display: flex; flex-direction: column; }
.treemap-stage { flex: 1; min-height: 0; }
.size-summary { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; padding: 12px 14px; border-bottom: 1px solid var(--border-color); background: var(--surface-color); }
.size-summary > div { display: flex; flex-direction: column; min-width: 0; gap: 3px; }
.size-summary-label, .size-summary-exact, .size-scan-state, .size-explanation { color: var(--text-muted); font-size: var(--ui-font-xs); }
.size-summary strong { color: var(--text-color); font-size: var(--ui-font-xxl); line-height: 1.3; font-variant-numeric: tabular-nums; }
.size-summary-exact { font-variant-numeric: tabular-nums; }
.size-scan-state { line-height: 1.5; }
.size-partial { color: var(--warning-color, #b45309); }
.size-explanation { flex: 0 0 auto; margin: 0; padding: 8px 12px; border-top: 1px solid var(--border-color); background: var(--surface-muted); line-height: 1.65; }
.file-list-header, .file-row { display: grid; grid-template-columns: minmax(140px, 1fr) 100px 154px; align-items: center; width: 100%; }
.file-list-header { height: 34px; padding: 0 8px; color: var(--text-muted); background: var(--surface-muted); font-size: var(--ui-font-xs); font-weight: 700; }
.file-virtual-list { height: calc(100% - 34px); }
.file-row { height: 38px; padding: 0 8px; color: var(--text-color); border: 0; border-bottom: 1px solid var(--row-divider); background: var(--surface-color); text-align: left; cursor: default; }
.file-row:hover { background: var(--active-background); }
.file-row > span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.file-row > span:first-child { display: flex; align-items: center; gap: 6px; }
.file-size-cell { display: flex; flex-direction: column; gap: 1px; font-variant-numeric: tabular-nums; }
.file-size-cell small { overflow: hidden; color: var(--text-muted); font-size: 10px; white-space: nowrap; text-overflow: ellipsis; }
.file-loading { position: absolute; right: 10px; bottom: 10px; display: flex; align-items: center; gap: 7px; padding: 6px 9px; border: 1px solid var(--border-color); border-radius: 4px; background: var(--surface-color); font-size: var(--ui-font-sm); }
.split-handle { cursor: col-resize; background: var(--app-background); }
.split-handle:hover { background: var(--accent-color); }
@media (max-width: 1100px) { .file-list-header, .file-row { grid-template-columns: minmax(140px, 1fr) 90px; } .file-list-header span:last-child, .file-row span:last-child { display: none; } }
</style>
