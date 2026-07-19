export interface ParsedTable {
  headers: string[]
  rows: string[][]
}

export type TableSortDirection = 'none' | 'ascending' | 'descending'

/**
 * 把从 Excel 或网页复制的制表符文本解析成规整二维表格。
 */
export function parseTableText(text: string, ignoreEmptyHeader: boolean): ParsedTable {
  const validLines = text.split(/\r?\n/).filter((line) => line.trim())
  if (validLines.length === 0) return { headers: [], rows: [] }

  const headers = validLines[0].split('\t')
  const rows = validLines.slice(1).map((line) => {
    const columns = line.split('\t')
    if (ignoreEmptyHeader) {
      while (columns.length > headers.length && columns[0]?.trim() === '') columns.shift()
    }
    return columns
  })

  const maxColumns = Math.max(headers.length, ...rows.map((row) => row.length))
  padRow(headers, maxColumns)
  rows.forEach((row) => padRow(row, maxColumns))

  if (ignoreEmptyHeader) {
    const removableColumns: number[] = []
    for (let column = 0; column < maxColumns; column++) {
      const hasHeader = Boolean(headers[column]?.trim())
      const hasData = rows.some((row) => Boolean(row[column]?.trim()))
      if (!hasHeader && !hasData) removableColumns.push(column)
    }
    for (const column of removableColumns.reverse()) {
      headers.splice(column, 1)
      rows.forEach((row) => row.splice(column, 1))
    }
  }

  return { headers, rows }
}

/**
 * 用空字符串补齐一行的列数。
 */
function padRow(row: string[], length: number): void {
  while (row.length < length) row.push('')
}

/**
 * 按数字优先、文本兜底的规则返回排序副本。
 */
export function sortTableRows(
  rows: string[][],
  column: number | null,
  direction: TableSortDirection
): string[][] {
  const result = rows.map((row) => [...row])
  if (column === null || direction === 'none') return result

  result.sort((left, right) => {
    const leftValue = left[column] ?? ''
    const rightValue = right[column] ?? ''
    const leftNumber = Number(leftValue.trim())
    const rightNumber = Number(rightValue.trim())
    const bothNumeric = leftValue.trim() !== '' && rightValue.trim() !== '' &&
      Number.isFinite(leftNumber) && Number.isFinite(rightNumber)
    const comparison = bothNumeric
      ? leftNumber - rightNumber
      : leftValue.localeCompare(rightValue)
    return direction === 'ascending' ? comparison : -comparison
  })
  return result
}

/**
 * 按所选矩形范围生成可粘回 Excel 的制表符文本，未选位置留空。
 */
export function selectedCellsToTsv(rows: string[][], selectedCells: Set<string>): string {
  if (selectedCells.size === 0) return ''
  const positions = [...selectedCells].map((key) => key.split('-').map(Number) as [number, number])
  const rowIndexes = positions.map(([row]) => row)
  const columnIndexes = positions.map(([, column]) => column)
  const minRow = Math.min(...rowIndexes)
  const maxRow = Math.max(...rowIndexes)
  const minColumn = Math.min(...columnIndexes)
  const maxColumn = Math.max(...columnIndexes)
  const output: string[] = []

  for (let row = minRow; row <= maxRow; row++) {
    const values: string[] = []
    for (let column = minColumn; column <= maxColumn; column++) {
      values.push(selectedCells.has(`${row}-${column}`) ? (rows[row]?.[column] ?? '') : '')
    }
    output.push(values.join('\t'))
  }
  return output.join('\n')
}
