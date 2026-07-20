/** Treemap 输入节点。 */
export interface TreemapNode {
  path: string
  name: string
  size: number
  isDirectory: boolean
}

/** Treemap 绘制矩形。 */
export interface TreemapRect extends TreemapNode {
  x: number
  y: number
  width: number
  height: number
}

/** 根据节点矩形尺寸计算可读字号，空间不足时不绘制文字。 */
export function calculateTreemapFontSize(width: number, height: number): number | null {
  if (width < 48 || height < 28) return null
  return Math.min(28, Math.max(12, Math.round(Math.min(width, height) * 0.32)))
}

/** 使用递归二分法把节点铺满给定矩形。 */
export function layoutTreemap(
  nodes: TreemapNode[],
  width: number,
  height: number
): TreemapRect[] {
  const validNodes = nodes.filter((node) => node.size > 0).sort((a, b) => b.size - a.size)
  return splitNodes(validNodes, 0, 0, Math.max(0, width), Math.max(0, height))
}

/** 递归寻找接近一半大小的切分点并生成矩形。 */
function splitNodes(
  nodes: TreemapNode[],
  x: number,
  y: number,
  width: number,
  height: number
): TreemapRect[] {
  if (nodes.length === 0 || width <= 0 || height <= 0) return []
  if (nodes.length === 1) return [{ ...nodes[0], x, y, width, height }]
  const total = nodes.reduce((sum, node) => sum + node.size, 0)
  let accumulated = 0
  let splitIndex = 1
  for (let index = 0; index < nodes.length - 1; index += 1) {
    accumulated += nodes[index].size
    splitIndex = index + 1
    if (accumulated >= total / 2) break
  }
  const ratio = accumulated / total
  if (width >= height) {
    const firstWidth = width * ratio
    return [
      ...splitNodes(nodes.slice(0, splitIndex), x, y, firstWidth, height),
      ...splitNodes(nodes.slice(splitIndex), x + firstWidth, y, width - firstWidth, height)
    ]
  }
  const firstHeight = height * ratio
  return [
    ...splitNodes(nodes.slice(0, splitIndex), x, y, width, firstHeight),
    ...splitNodes(nodes.slice(splitIndex), x, y + firstHeight, width, height - firstHeight)
  ]
}
