import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
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

function scheduler(notes: StickyNote[], isWorkday = vi.fn().mockResolvedValue(true), window: BrowserWindow | null = null) {
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
  return { scheduler: new ReminderScheduler(service, holidays, () => window), markReminderTriggered, isWorkday }
}

function testWindow(initial = { focused: false, visible: true, minimized: false, alwaysOnTop: false }) {
  const state = { ...initial }
  const window = {
    isDestroyed: vi.fn(() => false),
    isFocused: vi.fn(() => state.focused),
    isVisible: vi.fn(() => state.visible),
    isMinimized: vi.fn(() => state.minimized),
    isAlwaysOnTop: vi.fn(() => state.alwaysOnTop),
    restore: vi.fn(() => { state.minimized = false; state.visible = true }),
    show: vi.fn(() => { state.visible = true }),
    focus: vi.fn(() => { state.focused = true }),
    setAlwaysOnTop: vi.fn((value: boolean) => { state.alwaysOnTop = value }),
    webContents: { send: vi.fn() }
  }
  return { window, electronWindow: window as unknown as BrowserWindow, state }
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

  it('启动时已聚焦的窗口不重复显示、聚焦或切换置顶，所有提醒仍入队', async () => {
    const target = testWindow({ focused: true, visible: true, minimized: false, alwaysOnTop: false })
    const state = scheduler([reminder('first', 0), reminder('second', 0)], undefined, target.electronWindow)

    await state.scheduler.checkNow()

    expect(target.window.show).not.toHaveBeenCalled()
    expect(target.window.focus).not.toHaveBeenCalled()
    expect(target.window.setAlwaysOnTop).not.toHaveBeenCalled()
    expect(target.window.webContents.send.mock.calls.map((call) => call[1].id)).toEqual(['first', 'second'])
  })

  it('同批多个提醒只恢复、聚焦和临时置顶一次，并只在十秒后撤销一次', async () => {
    const target = testWindow({ focused: false, visible: false, minimized: true, alwaysOnTop: false })
    // 系统可能拒绝抢焦点，同批提醒也不应重复尝试。
    target.window.focus.mockImplementation(() => {})
    const state = scheduler([reminder('first', 0), reminder('second', 0)], undefined, target.electronWindow)

    await state.scheduler.checkNow()

    expect(target.window.restore).toHaveBeenCalledOnce()
    expect(target.window.focus).toHaveBeenCalledOnce()
    expect(target.window.show).not.toHaveBeenCalled()
    expect(target.window.setAlwaysOnTop.mock.calls).toEqual([[true]])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(target.window.setAlwaysOnTop.mock.calls).toEqual([[true], [false]])
  })

  it('停止调度立即清理本次临时置顶，定时器不会再重复改变窗口', async () => {
    const target = testWindow()
    const state = scheduler([reminder('first', 0)], undefined, target.electronWindow)
    await state.scheduler.checkNow()
    state.scheduler.stop()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(target.window.setAlwaysOnTop.mock.calls).toEqual([[true], [false]])
  })

  it('保留窗口原有的置顶状态', async () => {
    const target = testWindow({ focused: false, visible: true, minimized: false, alwaysOnTop: true })
    const state = scheduler([reminder('first', 0)], undefined, target.electronWindow)
    await state.scheduler.checkNow()
    await vi.advanceTimersByTimeAsync(20_000)
    state.scheduler.stop()
    expect(target.window.setAlwaysOnTop).not.toHaveBeenCalled()
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

  it('跨分钟补查会再次恢复用户在上一分钟提醒后最小化的窗口', async () => {
    let finishHoliday!: (value: boolean) => void
    const holiday = new Promise<boolean>((resolve) => { finishHoliday = resolve })
    const target = testWindow()
    const state = scheduler([
      reminder('daily', 0), reminder('slow-workday', 0, 'workday'), reminder('next-minute', 1)
    ], vi.fn(() => holiday), target.electronWindow)

    const check = state.scheduler.checkNow()
    await vi.waitFor(() => expect(state.isWorkday).toHaveBeenCalledOnce())
    expect(target.window.focus).toHaveBeenCalledOnce()
    target.state.minimized = true
    target.state.visible = false
    target.state.focused = false
    vi.setSystemTime(new Date(2026, 10, 16, 9, 1))
    finishHoliday(true)
    await check

    expect(target.window.restore).toHaveBeenCalledOnce()
    expect(target.window.focus).toHaveBeenCalledTimes(2)
    expect(target.window.webContents.send.mock.calls.map((call) => call[1].id)).toEqual(['daily', 'slow-workday', 'next-minute'])
    state.scheduler.stop()
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
