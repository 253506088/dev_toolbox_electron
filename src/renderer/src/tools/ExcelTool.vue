<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, ref } from 'vue'
import { ArrowDownAZ, ArrowUpAZ, ArrowUpDown, Clipboard, Eraser, Table2 } from '@lucide/vue'
import {
  NButton,
  NCheckbox,
  NDataTable,
  NIcon,
  NTooltip,
  useMessage,
  type DataTableColumns
} from 'naive-ui'
import MonacoEditor from '../components/MonacoEditor.vue'
import ToolPage from '../components/ToolPage.vue'
import { copyText } from '../utils/clipboard'
import {
  parseTableText,
  selectedCellsToTsv,
  sortTableRows,
  type TableSortDirection
} from '../utils/excel-table'

type TableRow = Record<string, string | number>

const input = ref('')
const headers = ref<string[]>([])
const originalRows = ref<string[][]>([])
const ignoreEmptyHeader = ref(true)
const sortColumn = ref<number | null>(null)
const sortDirection = ref<TableSortDirection>('none')
const selectedCells = ref(new Set<string>())
const dragStart = ref<[number, number] | null>(null)
const dragEnd = ref<[number, number] | null>(null)
const dragMoved = ref(false)
const message = useMessage()

const sortedRows = computed(() =>
  sortTableRows(originalRows.value, sortColumn.value, sortDirection.value)
)
const tableRows = computed<TableRow[]>(() =>
  sortedRows.value.map((row, rowIndex) => {
    const record: TableRow = { __rowIndex: rowIndex }
    row.forEach((value, columnIndex) => {
      record[`column-${columnIndex}`] = value
    })
    return record
  })
)
const columns = computed<DataTableColumns<TableRow>>(() =>
  headers.value.map((header, columnIndex) => ({
    key: `column-${columnIndex}`,
    title: () => renderHeader(header, columnIndex),
    width: 180,
    ellipsis: { tooltip: true },
    render: (row) => renderCell(row, columnIndex)
  }))
)

/**
 * 解析输入文本并重置表格交互状态。
 */
function parse(): void {
  const parsed = parseTableText(input.value, ignoreEmptyHeader.value)
  headers.value = parsed.headers
  originalRows.value = parsed.rows
  sortColumn.value = null
  sortDirection.value = 'none'
  selectedCells.value = new Set()
}

/**
 * 清空输入和表格。
 */
function clear(): void {
  input.value = ''
  headers.value = []
  originalRows.value = []
  selectedCells.value = new Set()
  sortColumn.value = null
  sortDirection.value = 'none'
}

/**
 * 渲染带排序和整列复制按钮的表头。
 */
function renderHeader(header: string, columnIndex: number): ReturnType<typeof h> {
  const sortIcon =
    sortColumn.value !== columnIndex || sortDirection.value === 'none'
      ? ArrowUpDown
      : sortDirection.value === 'ascending'
        ? ArrowDownAZ
        : ArrowUpAZ
  return h('div', { class: 'excel-header' }, [
    h('span', { class: 'excel-header-label' }, header || '（空列）'),
    renderIconButton(sortIcon, '排序', () => cycleSort(columnIndex)),
    renderIconButton(Clipboard, '复制整列', () => void copyColumn(columnIndex))
  ])
}

/**
 * 创建只有图标并带悬浮说明的表头按钮。
 */
function renderIconButton(
  icon: typeof Clipboard,
  tooltip: string,
  onClick: () => void
): ReturnType<typeof h> {
  return h(
    NTooltip,
    { placement: 'top' },
    {
      trigger: () =>
        h(
          NButton,
          { quaternary: true, circle: true, size: 'tiny', onClick },
          { icon: () => h(NIcon, { component: icon }) }
        ),
      default: () => tooltip
    }
  )
}

/**
 * 渲染支持单击复制和拖拽框选的单元格。
 */
function renderCell(row: TableRow, columnIndex: number): ReturnType<typeof h> {
  const rowIndex = Number(row.__rowIndex)
  const value = String(row[`column-${columnIndex}`] ?? '')
  return h(
    'div',
    {
      class: ['excel-cell', { selected: isCellSelected(rowIndex, columnIndex) }],
      onMousedown: (event: MouseEvent) => startSelection(event, rowIndex, columnIndex),
      onMouseenter: (event: MouseEvent) => updateSelection(event, rowIndex, columnIndex),
      onClick: () => void copySingleCell(value)
    },
    value
  )
}

/**
 * 依次切换升序、降序和原始顺序。
 */
function cycleSort(columnIndex: number): void {
  if (sortColumn.value !== columnIndex) {
    sortColumn.value = columnIndex
    sortDirection.value = 'ascending'
  } else if (sortDirection.value === 'ascending') {
    sortDirection.value = 'descending'
  } else if (sortDirection.value === 'descending') {
    sortDirection.value = 'none'
  } else {
    sortDirection.value = 'ascending'
  }
  selectedCells.value = new Set()
}

/**
 * 复制当前排序顺序下的一整列。
 */
async function copyColumn(columnIndex: number): Promise<void> {
  const text = sortedRows.value.map((row) => row[columnIndex] ?? '').join('\n')
  await copyText(text)
  message.success(`已复制【${headers.value[columnIndex] || '空列'}】列`)
}

/**
 * 开始新的矩形选择，按住 Ctrl 时保留已有选择。
 */
function startSelection(event: MouseEvent, row: number, column: number): void {
  event.preventDefault()
  if (!event.ctrlKey) selectedCells.value = new Set()
  dragStart.value = [row, column]
  dragEnd.value = [row, column]
  dragMoved.value = false
}

/**
 * 按住鼠标经过单元格时扩展选择矩形。
 */
function updateSelection(event: MouseEvent, row: number, column: number): void {
  if (event.buttons !== 1 || !dragStart.value) return
  dragEnd.value = [row, column]
  dragMoved.value = dragMoved.value || row !== dragStart.value[0] || column !== dragStart.value[1]
}

/**
 * 鼠标松开时把当前矩形提交到已选集合。
 */
function commitSelection(): void {
  if (!dragStart.value || !dragEnd.value) return
  const [startRow, startColumn] = dragStart.value
  const [endRow, endColumn] = dragEnd.value
  const next = new Set(selectedCells.value)
  for (let row = Math.min(startRow, endRow); row <= Math.max(startRow, endRow); row++) {
    for (
      let column = Math.min(startColumn, endColumn);
      column <= Math.max(startColumn, endColumn);
      column++
    ) {
      next.add(`${row}-${column}`)
    }
  }
  selectedCells.value = next
  dragStart.value = null
  dragEnd.value = null
}

/**
 * 判断单元格是否已提交或正在拖拽范围中。
 */
function isCellSelected(row: number, column: number): boolean {
  if (selectedCells.value.has(`${row}-${column}`)) return true
  if (!dragStart.value || !dragEnd.value) return false
  return (
    row >= Math.min(dragStart.value[0], dragEnd.value[0]) &&
    row <= Math.max(dragStart.value[0], dragEnd.value[0]) &&
    column >= Math.min(dragStart.value[1], dragEnd.value[1]) &&
    column <= Math.max(dragStart.value[1], dragEnd.value[1])
  )
}

/**
 * 未发生拖拽时，单击直接复制当前单元格并清掉选择。
 */
async function copySingleCell(value: string): Promise<void> {
  if (dragMoved.value) return
  await copyText(value)
  selectedCells.value = new Set()
  message.success(`已复制：${value}`)
}

/**
 * 按矩形布局复制所选单元格，完成后取消选择。
 */
async function copySelection(): Promise<void> {
  const text = selectedCellsToTsv(sortedRows.value, selectedCells.value)
  await copyText(text)
  message.success(`已复制选中的 ${selectedCells.value.size} 个单元格`)
  selectedCells.value = new Set()
}

/**
 * 为拖拽选择注册窗口级鼠标松开监听。
 */
onMounted(() => window.addEventListener('mouseup', commitSelection))

/**
 * 组件卸载时移除窗口级监听。
 */
onBeforeUnmount(() => window.removeEventListener('mouseup', commitSelection))
</script>

<template>
  <ToolPage title="Excel 表格提取">
    <template #actions>
      <NButton type="primary" @click="parse">
        <template #icon><NIcon :component="Table2" /></template>
        解析生成表格
      </NButton>
      <NCheckbox v-model:checked="ignoreEmptyHeader">过滤无表头的空列</NCheckbox>
      <NButton :disabled="selectedCells.size === 0" @click="copySelection">
        <template #icon><NIcon :component="Clipboard" /></template>
        复制选区
      </NButton>
      <NButton type="error" secondary :disabled="!input && headers.length === 0" @click="clear">
        <template #icon><NIcon :component="Eraser" /></template>
        清空
      </NButton>
    </template>
    <template #status>
      <span class="status-text">{{ originalRows.length }} 行 × {{ headers.length }} 列</span>
    </template>

    <div class="excel-layout">
      <MonacoEditor v-model="input" aria-label="Excel 制表符文本输入编辑器" />
      <NDataTable
        class="excel-table"
        :columns="columns"
        :data="tableRows"
        :row-key="(row: TableRow) => row.__rowIndex"
        :bordered="true"
        :single-line="false"
        :scroll-x="Math.max(headers.length * 180, 700)"
        flex-height
        virtual-scroll
      />
    </div>
  </ToolPage>
</template>

<style scoped>
.excel-layout {
  display: grid;
  grid-template-rows: 180px minmax(0, 1fr);
  height: 100%;
  min-height: 0;
  gap: 10px;
}

.excel-table {
  min-height: 0;
}

:deep(.excel-header) {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 26px 26px;
  align-items: center;
  gap: 2px;
}

:deep(.excel-header-label) {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

:deep(.excel-cell) {
  width: 100%;
  min-height: 26px;
  margin: -8px -12px;
  padding: 8px 12px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  cursor: cell;
  user-select: none;
}

:deep(.excel-cell.selected) {
  color: var(--chip-text);
  background: var(--chip-background);
}
</style>
