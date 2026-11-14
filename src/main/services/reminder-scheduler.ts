import { app, BrowserWindow, Notification, shell } from 'electron'
import { shouldTriggerReminder } from '../../shared/reminder-rules'
import type { StickyNote } from '../../shared/electron-api'
import { HolidayService } from './holiday-service'
import { writeLog } from './logger'
import { NoteService } from './note-service'

/** 在主进程按整分钟检查便签提醒并执行提醒动作。 */
export class ReminderScheduler {
  private alignTimer?: NodeJS.Timeout
  private minuteTimer?: NodeJS.Timeout
  private pendingCheck?: Promise<void>

  /** 创建提醒调度器。 */
  constructor(
    private readonly notes: NoteService,
    private readonly holidays: HolidayService,
    private readonly getWindow: () => BrowserWindow | null
  ) {}

  /** 启动整分钟调度。 */
  start(): void {
    this.stop()
    const delay = 60_000 - (Date.now() % 60_000)
    this.alignTimer = setTimeout(() => {
      void this.checkNow()
      this.minuteTimer = setInterval(() => void this.checkNow(), 60_000)
    }, delay)
    void this.checkNow()
  }

  /** 停止全部提醒定时器。 */
  stop(): void {
    if (this.alignTimer) clearTimeout(this.alignTimer)
    if (this.minuteTimer) clearInterval(this.minuteTimer)
    this.alignTimer = undefined
    this.minuteTimer = undefined
  }

  /** 立即检查当前分钟应触发的提醒。 */
  async checkNow(): Promise<void> {
    // 启动检查遇到慢速节假日请求时可能跨过整分钟，合并重叠的检查，
    // 避免同一条提醒重复弹窗、抢焦点和置顶。
    if (this.pendingCheck) return this.pendingCheck
    this.pendingCheck = this.checkCurrentMinute()
    try {
      await this.pendingCheck
    } finally {
      this.pendingCheck = undefined
    }
  }

  private async checkCurrentMinute(): Promise<void> {
    let startedMinute: number
    do {
      startedMinute = Math.floor(Date.now() / 60_000)
      await this.checkReminders()
      // 慢请求跨分钟时补查此刻到期的便签，不能因合并检查漏掉新一分钟。
    } while (startedMinute !== Math.floor(Date.now() / 60_000))
  }

  private async checkReminders(): Promise<void> {
    const now = new Date()
    const dueNotes = this.notes.list().filter((note) => note.reminder && shouldTriggerReminder(note.reminder, now, true))
    // 同一分钟的普通提醒立即展示，不被工作日查询拖住。工作日结果每轮只查一次。
    for (const note of dueNotes.filter((item) => item.reminder!.type !== 'workday')) {
      await this.triggerIfCurrent(note.id, now, false)
    }
    const workdayNotes = dueNotes.filter((note) => note.reminder!.type === 'workday')
    if (workdayNotes.length > 0 && await this.holidays.isWorkday(now)) {
      for (const note of workdayNotes) await this.triggerIfCurrent(note.id, now, true)
    }
    if (now.getDate() >= 25) {
      const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1)
      void this.holidays.getMonth(nextMonth.getFullYear(), nextMonth.getMonth() + 1)
    }
  }

  /** 异步查询或其他提醒落盘期间，用户可能已关闭、修改或删除该提醒。 */
  private async triggerIfCurrent(id: string, now: Date, workday: boolean): Promise<void> {
    const note = this.notes.list().find((item) => item.id === id)
    if (note?.reminder && shouldTriggerReminder(note.reminder, now, workday)) await this.trigger(note, now)
  }

  /** 先记录触发状态，再执行声音、前台、置顶、系统通知和应用内弹窗。 */
  private async trigger(note: StickyNote, now: Date): Promise<void> {
    const updated = await this.notes.markReminderTriggered(note.id, now.toISOString())
    if (!updated) return
    const window = this.getWindow()
    await writeLog('提醒服务', `触发便签提醒：${note.id}`)
    shell.beep()
    if (window && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
      app.focus({ steal: true })
      window.setAlwaysOnTop(true)
      setTimeout(() => {
        if (!window.isDestroyed()) window.setAlwaysOnTop(false)
      }, 10_000)
      window.webContents.send('notes:reminder', updated)
    }
    const notification = new Notification({
      title: '便签提醒',
      body: note.content.length > 100 ? `${note.content.slice(0, 100)}...` : note.content || '图片便签到时间了'
    })
    notification.on('click', () => {
      if (window && !window.isDestroyed()) {
        window.show()
        window.focus()
      }
    })
    notification.show()
  }
}
