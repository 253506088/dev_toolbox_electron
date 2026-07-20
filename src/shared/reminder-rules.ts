import type { NoteReminder } from './electron-api'

/** 判断两个时间是否处于同一个本地自然日。 */
export function isSameLocalDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  )
}

/** 判断指定日期是否位于包含首尾的日期范围内。 */
export function isDateInRange(date: Date, start?: string, end?: string): boolean {
  if (!start || !end) return false
  const current = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const startTime = new Date(`${start}T00:00:00`).getTime()
  const endTime = new Date(`${end}T23:59:59`).getTime()
  return current >= startTime && current <= endTime
}

/** 判断提醒在当前分钟是否应该触发。 */
export function shouldTriggerReminder(
  reminder: NoteReminder,
  now: Date,
  isWorkday: boolean
): boolean {
  if (!reminder.enabled || reminder.hour !== now.getHours() || reminder.minute !== now.getMinutes()) {
    return false
  }
  if (reminder.lastTriggered && isSameLocalDay(new Date(reminder.lastTriggered), now)) return false
  if (reminder.type === 'once') {
    return Boolean(reminder.onceDate) && isSameLocalDay(new Date(`${reminder.onceDate}T00:00:00`), now)
  }
  if (reminder.type === 'dateRange') {
    return isDateInRange(now, reminder.startDate, reminder.endDate)
  }
  return isWorkday
}
