const FILE_SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const

/** 统一列表、图块和总量的容量单位，未知值不参与大小展示。 */
export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '计算中…'
  if (!Number.isFinite(bytes) || bytes < 0) return '未知'
  if (bytes < 1024) return `${Math.floor(bytes)} B`
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < FILE_SIZE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  // 四舍五入后跨单位时继续提升，避免把 1024 KB 与 1 MB 显示成不同量级。
  if (Number(value.toFixed(value >= 10 ? 1 : 2)) >= 1024 && unit < FILE_SIZE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${FILE_SIZE_UNITS[unit]}`
}

export function formatExactFileSize(bytes: number): string {
  return Number.isFinite(bytes) && bytes >= 0 ? `${Math.floor(bytes).toLocaleString('zh-CN')} 字节` : '未知大小'
}

/** 百分比以当前可见的已统计总量为分母；很小的有效项目不显示为 0%。 */
export function formatSizeShare(bytes: number, total: number): string {
  if (!Number.isFinite(bytes) || !Number.isFinite(total) || bytes <= 0 || total <= 0) return '0%'
  const percent = Math.min(100, bytes / total * 100)
  return percent < 0.1 ? '<0.1%' : `${percent.toFixed(1).replace(/\.0$/, '')}%`
}
