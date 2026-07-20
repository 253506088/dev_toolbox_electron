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
    const now = new Date()
    for (const note of this.notes.list()) {
      if (!note.reminder?.enabled) continue
      const workday = note.reminder.type === 'workday' ? await this.holidays.isWorkday(now) : false
      if (shouldTriggerReminder(note.reminder, now, workday)) await this.trigger(note, now)
    }
    if (now.getDate() >= 25) {
      const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1)
      void this.holidays.getMonth(nextMonth.getFullYear(), nextMonth.getMonth() + 1)
    }
  }

  /** 先记录触发状态，再执行声音、前台、置顶、抖动、系统通知和应用内弹窗。 */
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
      void shakeWindow(window)
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

/** 使用 Electron 窗口坐标实现短促横向抖动。 */
async function shakeWindow(window: BrowserWindow): Promise<void> {
  if (window.isDestroyed() || window.isMaximized() || window.isFullScreen()) return
  const [originalX, originalY] = window.getPosition()
  for (let index = 0; index < 8; index += 1) {
    if (window.isDestroyed()) return
    window.setPosition(originalX + (index % 2 === 0 ? 14 : -14), originalY)
    await wait(45)
  }
  if (!window.isDestroyed()) window.setPosition(originalX, originalY)
}

/** 等待指定毫秒数，让窗口抖动保持可见节奏。 */
function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
