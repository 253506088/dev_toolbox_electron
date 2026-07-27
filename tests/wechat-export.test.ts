import { describe, expect, it } from 'vitest'
import { planStitchGroups } from '../src/shared/wechat-export'

describe('分屏拼接长图分组', () => {
  it('总高度未超限时全部拼进一张', () => {
    expect(planStitchGroups([500, 500, 500], 2000)).toEqual([[0, 1, 2]])
  })

  it('超限时在整图边界断开并另起一张', () => {
    expect(planStitchGroups([800, 800, 800, 800], 2000)).toEqual([
      [0, 1],
      [2, 3]
    ])
  })

  it('恰好等于上限时不提前断开', () => {
    expect(planStitchGroups([1000, 1000, 1], 2000)).toEqual([[0, 1], [2]])
  })

  it('单张就超限的图独占一组，不从中间截断', () => {
    expect(planStitchGroups([3000, 500, 500], 2000)).toEqual([[0], [1, 2]])
  })

  it('空列表返回空分组', () => {
    expect(planStitchGroups([], 2000)).toEqual([])
  })
})
