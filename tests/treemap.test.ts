import { describe, expect, it } from 'vitest'
import { calculateTreemapFontSize, layoutTreemap, type TreemapNode } from '../src/shared/treemap'

const nodes: TreemapNode[] = [
  { path: 'A', name: 'A', size: 60, isDirectory: true },
  { path: 'B', name: 'B', size: 30, isDirectory: true },
  { path: 'C', name: 'C', size: 10, isDirectory: false }
]

describe('Treemap 递归二分布局', () => {
  it('每个有效节点都生成一个矩形', () => {
    expect(layoutTreemap(nodes, 1000, 600)).toHaveLength(3)
  })

  it('单节点铺满全部画布', () => {
    expect(layoutTreemap([nodes[0]], 800, 500)[0]).toMatchObject({ x: 0, y: 0, width: 800, height: 500 })
  })

  it('零大小节点不会占据画布', () => {
    expect(layoutTreemap([...nodes, { path: 'D', name: 'D', size: 0, isDirectory: false }], 800, 500)).toHaveLength(3)
  })

  it('大节点字号会放大并受到上限保护', () => {
    expect(calculateTreemapFontSize(500, 300)).toBe(28)
  })

  it('中等节点字号随短边变化', () => {
    expect(calculateTreemapFontSize(120, 50)).toBe(16)
  })

  it('过小节点不绘制文字', () => {
    expect(calculateTreemapFontSize(40, 24)).toBeNull()
  })
})
