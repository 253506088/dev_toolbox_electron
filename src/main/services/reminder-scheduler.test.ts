import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StickyNote } from '../../shared/electron-api'
import type { HolidayService } from './holiday-service'
import type { NoteService } from './note-service'

const native = vi.hoisted(() => ({ beep: vi.fn(), notify: vi.fn() }))
vi.mock('electron', () => ({
  app: { focus: vi.fn() },
  BrowserWindow: class {},
  Notification: class {
    constructor(options: unknown) { native.notify(options) }
    on() {}
    show() {}
  },
  shell: { beep: native.beep }
}))
vi.mock('./logger', () => ({ writeLog: vi.fn().mockResolvedValue(undefined) }))

import { ReminderScheduler } from './reminder-scheduler'

function reminder(id: string, minute: number, type: 'daily' | 'workday' = 'daily'): StickyNote {
  return {
    id, content: id, color: '#F7D7D9', imageNames: [],
    createdAt: '2026-11-16T00:00:00Z', updatedAt: '2026-11-16T00:00:00Z',
    reminder: { type, hour: 9, minute, enabled: true }
  }
}

function scheduler(notes: StickyNote[], isWorkday = vi.fn().mockResolvedValue(true)) {
  const markReminderTriggered = vi.fn(async (id: string, triggeredAt: string) => {
    const note = notes.find((item) => item.id === id)!
    note.reminder!.lastTriggered = triggeredAt
    return structuredClone(note)
  })
  const service = {
    list: () => structuredClone(notes),
    markReminderTriggered
  } as unknown as NoteService
  const holidays = { isWorkday, getMonth: vi.fn().mockResolvedValue([]) } as unknown as HolidayService
  return { scheduler: new ReminderScheduler(service, holidays, () => null), markReminderTriggered, isWorkday }
}

describe('提醒调度稳定性', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 10, 16, 9, 0))
    vi.clearAllMocks()
  })
  afterEach(() => vi.useRealTimers())

  it('重叠检查只触发一次提醒，避免重复弹窗和抢焦点', async () => {
    let finishHoliday!: (value: boolean) => void
    const holiday = new Promise<boolean>((resolve) => { finishHoliday = resolve })
    const state = scheduler([reminder('work', 0, 'workday')], vi.fn(() => holiday))

    const first = state.scheduler.checkNow()
    const second = state.scheduler.checkNow()
    expect(state.isWorkday).toHaveBeenCalledOnce()
    finishHoliday(true)
    await Promise.all([first, second])

    expect(state.markReminderTriggered).toHaveBeenCalledOnce()
    expect(native.beep).toHaveBeenCalledOnce()
    expect(native.notify).toHaveBeenCalledOnce()
  })

  it('慢请求跨分钟后补查新一分钟，不漏掉另一条到期便签', async () => {
    let finishHoliday!: (value: boolean) => void
    const holiday = new Promise<boolean>((resolve) => { finishHoliday = resolve })
    const state = scheduler([
      reminder('work', 0, 'workday'),
      reminder('next-minute', 1)
    ], vi.fn(() => holiday))

    const first = state.scheduler.checkNow()
    vi.setSystemTime(new Date(2026, 10, 16, 9, 1))
    const nextMinute = state.scheduler.checkNow()
    finishHoliday(true)
    await Promise.all([first, nextMinute])

    expect(state.markReminderTriggered.mock.calls.map(([id]) => id)).toEqual(['work', 'next-minute'])
    expect(native.notify).toHaveBeenCalledTimes(2)
  })

  it('未到时间的工作日便签不启动网络查询，也不阻塞当前提醒', async () => {
    const state = scheduler([reminder('later', 30, 'workday'), reminder('now', 0)])
    await state.scheduler.checkNow()

    expect(state.isWorkday).not.toHaveBeenCalled()
    expect(state.markReminderTriggered.mock.calls.map(([id]) => id)).toEqual(['now'])
  })

  it('同一分钟的每日提醒先展示，工作日提醒共用查询结果', async () => {
    let finishHoliday!: (value: boolean) => void
    const holiday = new Promise<boolean>((resolve) => { finishHoliday = resolve })
    const state = scheduler([
      reminder('work-first', 0, 'workday'), reminder('daily', 0), reminder('work-second', 0, 'workday')
    ], vi.fn(() => holiday))

    const check = state.scheduler.checkNow()
    expect(state.markReminderTriggered.mock.calls.map(([id]) => id)).toEqual(['daily'])
    finishHoliday(true)
    await check

    expect(state.isWorkday).toHaveBeenCalledOnce()
    expect(state.markReminderTriggered.mock.calls.map(([id]) => id)).toEqual(['daily', 'work-first', 'work-second'])
  })

  it.each(['关闭', '删除', '改时间'])('网络等待期间%s的提醒不会按旧配置触发', async (operation) => {
    let finishHoliday!: (value: boolean) => void
    const holiday = new Promise<boolean>((resolve) => { finishHoliday = resolve })
    const notes = [reminder('work', 0, 'workday')]
    const state = scheduler(notes, vi.fn(() => holiday))

    const check = state.scheduler.checkNow()
    if (operation === '关闭') notes[0].reminder!.enabled = false
    if (operation === '删除') notes.splice(0)
    if (operation === '改时间') notes[0].reminder!.minute = 30
    finishHoliday(true)
    await check

    expect(state.markReminderTriggered).not.toHaveBeenCalled()
    expect(native.notify).not.toHaveBeenCalled()
  })
})
