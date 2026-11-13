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

  it('面积只取去重后的大小，路径逻辑总量不会让硬链接占比膨胀', () => {
    const input = nodes.map((node) => ({ ...node, logicalSize: node.size * 200 }))
    const rectangles = layoutTreemap(input, 1000, 600)
    for (const rect of rectangles) {
      expect(rect.width * rect.height / 600_000).toBeCloseTo(rect.size / 100, 8)
    }
    expect(rectangles.reduce((total, rect) => total + rect.width * rect.height, 0)).toBeCloseTo(600_000, 6)
  })

  it('未知或非有限大小不能污染整个画布的几何坐标', () => {
    const input = [
      ...nodes,
      ...[NaN, Infinity, -1].map((size, index) => ({ path: `invalid-${index}`, name: '未知', size, isDirectory: true }))
    ]
    const rectangles = layoutTreemap(input, 1000, 600)
    expect(rectangles).toHaveLength(3)
    expect(rectangles.every((rect) => [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite))).toBe(true)
    expect(layoutTreemap(nodes, Infinity, 600)).toEqual([])
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
