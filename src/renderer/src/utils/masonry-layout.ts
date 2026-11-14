interface MasonryItem {
  cell: HTMLElement
  span: number
}

/** 测量卡片内容，批量更新外层网格；不让被观察元素反过来改变自己的尺寸。 */
export function createMasonryLayout(rowHeight = 8, gap = 12): {
  observe: (cell: HTMLElement) => void
  unobserve: (cell: HTMLElement) => void
  disconnect: () => void
} {
  const items = new Map<HTMLElement, MasonryItem>()
  const pending = new Set<HTMLElement>()
  let frame: number | undefined
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const content = entry.target as HTMLElement
      if (items.has(content)) pending.add(content)
    }
    // ResizeObserver 在绘制前通知尺寸变化。在本轮内更新外层行高，避免窗口
    // 缩放或字号变化后先绘制一帧重叠卡片。外层行高不会反过来拉伸内容。
    flush()
  })

  function flush(): void {
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
    // 先完成全部读取，再批量写入，避免每张卡片都触发一次页面重排。
    const measurements = [...pending].map((content) => ({ content, height: content.getBoundingClientRect().height }))
    pending.clear()
    for (const { content, height } of measurements) {
      const item = items.get(content)
      // KeepAlive 暂存时尺寸为零，保留最后的布局，切回时再测量。
      if (!item || !content.isConnected || height <= 0) continue
      const span = Math.max(1, Math.ceil((height + gap) / (rowHeight + gap)))
      if (span !== item.span) {
        item.cell.style.gridRowEnd = `span ${span}`
        item.span = span
      }
      if (item.cell.dataset.masonryReady !== 'true') item.cell.dataset.masonryReady = 'true'
    }
  }

  function schedule(): void {
    if (frame !== undefined) return
    frame = requestAnimationFrame(flush)
  }

  return {
    observe(cell) {
      const content = cell.firstElementChild as HTMLElement | null
      if (!content) return
      items.set(content, { cell, span: 0 })
      observer.observe(content)
      pending.add(content)
      schedule()
    },
    unobserve(cell) {
      const content = cell.firstElementChild as HTMLElement | null
      if (!content) return
      observer.unobserve(content)
      items.delete(content)
      pending.delete(content)
    },
    disconnect() {
      observer.disconnect()
      items.clear()
      pending.clear()
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = undefined
    }
  }
}
