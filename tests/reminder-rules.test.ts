import { describe, expect, it } from 'vitest'
import { isDateInRange, isSameLocalDay, shouldTriggerReminder } from '../src/shared/reminder-rules'
import type { NoteReminder } from '../src/shared/electron-api'

/** 构造测试用提醒。 */
function reminder(overrides: Partial<NoteReminder> = {}): NoteReminder {
  return { type: 'once', hour: 9, minute: 30, enabled: true, onceDate: '2026-07-19', ...overrides }
}

describe('便签提醒规则', () => {
  it('同一自然日的不同时间视为同一天', () => {
    expect(isSameLocalDay(new Date(2026, 6, 19, 1), new Date(2026, 6, 19, 23))).toBe(true)
  })

  it('日期范围包含开始日和结束日', () => {
    expect(isDateInRange(new Date(2026, 6, 20), '2026-07-20', '2026-07-20')).toBe(true)
  })

  it('单次提醒在目标分钟触发', () => {
    expect(shouldTriggerReminder(reminder(), new Date(2026, 6, 19, 9, 30), false)).toBe(true)
  })

  it('单次提醒在错误分钟不触发', () => {
    expect(shouldTriggerReminder(reminder(), new Date(2026, 6, 19, 9, 31), false)).toBe(false)
  })

  it('当天已触发的提醒不会重复触发', () => {
    expect(shouldTriggerReminder(reminder({ lastTriggered: '2026-07-19T08:00:00' }), new Date(2026, 6, 19, 9, 30), false)).toBe(false)
  })

  it('工作日提醒由节假日结果决定', () => {
    const workday = reminder({ type: 'workday', onceDate: undefined })
    expect(shouldTriggerReminder(workday, new Date(2026, 6, 19, 9, 30), true)).toBe(true)
    expect(shouldTriggerReminder(workday, new Date(2026, 6, 19, 9, 30), false)).toBe(false)
  })
})
