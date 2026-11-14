import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMasonryLayout } from '../src/renderer/src/utils/masonry-layout'

describe('便签瀑布流稳定布局', () => {
  let notifyResize: (entries: { target: HTMLElement }[]) => void
  let frames: Map<number, FrameRequestCallback>
  let nextFrame: number
  const readsAndWrites: string[] = []
  const disconnect = vi.fn()
  const unobserve = vi.fn()

  function cell(name: string, height: number) {
    const state = { height }
    const content = {
      isConnected: true,
      getBoundingClientRect: () => {
        readsAndWrites.push(`read:${name}`)
        return { height: state.height }
      }
    } as HTMLElement
    const element = {
      firstElementChild: content,
      dataset: {},
      style: new Proxy({ gridRowEnd: '' }, {
        set(target, property, value) {
          readsAndWrites.push(`write:${name}`)
          Reflect.set(target, property, value)
          return true
        }
      })
    } as unknown as HTMLElement
    return { element, content, state }
  }

  function flushFrame(): void {
    const callbacks = [...frames.values()]
    frames.clear()
    callbacks.forEach((callback) => callback(0))
  }

  beforeEach(() => {
    frames = new Map()
    nextFrame = 0
    readsAndWrites.length = 0
    vi.clearAllMocks()
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: typeof notifyResize) { notifyResize = callback }
      observe = vi.fn()
      unobserve = unobserve
      disconnect = disconnect
    })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = ++nextFrame
      frames.set(id, callback)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  })

  afterEach(() => vi.unstubAllGlobals())

  it('首屏批量测量后再显示卡片，所有读取都在写入网格之前完成', () => {
    const layout = createMasonryLayout()
    const first = cell('first', 153)
    const second = cell('second', 294)
    layout.observe(first.element)
    layout.observe(second.element)
    expect(frames.size).toBe(1)
    expect(first.element.dataset.masonryReady).toBeUndefined()

    flushFrame()

    expect(readsAndWrites).toEqual(['read:first', 'read:second', 'write:first', 'write:second'])
    expect(first.element.style.gridRowEnd).toBe('span 9')
    expect(second.element.style.gridRowEnd).toBe('span 16')
    expect(first.element.dataset.masonryReady).toBe('true')
  })

  it('重复尺寸通知不会再次修改布局，隐藏页面的零高度不会压扁卡片', () => {
    const layout = createMasonryLayout()
    const item = cell('note', 153)
    layout.observe(item.element)
    flushFrame()
    readsAndWrites.length = 0
    notifyResize([{ target: item.content }])
    flushFrame()
    expect(readsAndWrites).toEqual(['read:note'])

    item.state.height = 0
    notifyResize([{ target: item.content }])
    flushFrame()
    expect(item.element.style.gridRowEnd).toBe('span 9')

    item.state.height = 210
    notifyResize([{ target: item.content }])
    flushFrame()
    expect(item.element.style.gridRowEnd).toBe('span 12')
  })

  it('尺寸变化在当前绘制前批量写入，不留下下一帧才修正的重叠布局', () => {
    const layout = createMasonryLayout()
    const first = cell('first', 148)
    const second = cell('second', 208)
    layout.observe(first.element)
    layout.observe(second.element)
    flushFrame()
    readsAndWrites.length = 0

    first.state.height = 268.5
    second.state.height = 168.25
    notifyResize([{ target: first.content }, { target: second.content }])

    expect(readsAndWrites).toEqual(['read:first', 'read:second', 'write:first', 'write:second'])
    expect(first.element.style.gridRowEnd).toBe('span 15')
    expect(second.element.style.gridRowEnd).toBe('span 10')
    expect(frames.size).toBe(0)
  })

  it('首个尺寸通知可以完成首次布局，并取消多余的下一帧测量', () => {
    const layout = createMasonryLayout()
    const item = cell('first', 153)
    layout.observe(item.element)

    notifyResize([{ target: item.content }])

    expect(item.element.dataset.masonryReady).toBe('true')
    expect(item.element.style.gridRowEnd).toBe('span 9')
    expect(frames.size).toBe(0)
  })

  it('删除卡片和卸载页面会取消观察及待执行布局', () => {
    const layout = createMasonryLayout()
    const item = cell('removed', 140)
    layout.observe(item.element)
    layout.unobserve(item.element)
    expect(unobserve).toHaveBeenCalledWith(item.content)
    flushFrame()
    expect(readsAndWrites).toEqual([])

    layout.observe(item.element)
    layout.disconnect()
    expect(frames.size).toBe(0)
    expect(disconnect).toHaveBeenCalledOnce()
  })
})
