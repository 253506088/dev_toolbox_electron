import { app } from 'electron'
import { join } from 'node:path'
import type { HolidayDay } from '../../shared/electron-api'
import { readJsonFile, writeJsonAtomic } from './file-storage'
import { writeLog } from './logger'

const HOLIDAY_API = 'https://api.apihubs.cn/holiday/get'

/** 读取、缓存节假日工作日数据，并在断网时按周一至周五降级。 */
export class HolidayService {
  private readonly memoryCache = new Map<string, HolidayDay[]>()

  /** 获取指定月份的每日工作日状态。 */
  async getMonth(year: number, month: number): Promise<HolidayDay[]> {
    validateMonth(year, month)
    const cacheKey = `${year}-${String(month).padStart(2, '0')}`
    const memory = this.memoryCache.get(cacheKey)
    if (memory) return structuredClone(memory)
    const cachePath = join(app.getPath('userData'), 'holiday-cache', `${cacheKey}.json`)
    const cached = await readJsonFile<HolidayDay[]>(cachePath, [])
    if (cached.length > 0) {
      this.memoryCache.set(cacheKey, cached)
      return structuredClone(cached)
    }
    try {
      const fetched = await this.fetchMonth(year, month)
      this.memoryCache.set(cacheKey, fetched)
      await writeJsonAtomic(cachePath, fetched)
      return structuredClone(fetched)
    } catch (error) {
      const fallback = buildFallbackMonth(year, month)
      await writeLog('节假日服务', `${cacheKey} 获取失败，已按周一至周五降级`, error)
      return fallback
    }
  }

  /** 判断指定日期是否为工作日。 */
  async isWorkday(date: Date): Promise<boolean> {
    const month = await this.getMonth(date.getFullYear(), date.getMonth() + 1)
    const key = formatDate(date)
    return month.find((day) => day.date === key)?.isWorkday ?? isWeekday(date)
  }

  /** 从旧版沿用的接口下载一个月的工作日数据。 */
  private async fetchMonth(year: number, month: number): Promise<HolidayDay[]> {
    const monthKey = `${year}${String(month).padStart(2, '0')}`
    const response = await fetch(`${HOLIDAY_API}?year=${year}&month=${monthKey}&cn=1`, {
      signal: AbortSignal.timeout(10_000)
    })
    if (!response.ok) throw new Error(`节假日接口返回 HTTP ${response.status}`)
    const body = (await response.json()) as {
      code?: number
      msg?: string
      data?: { list?: Array<{ date?: number; workday?: number }> }
    }
    if (body.code !== 0 || !Array.isArray(body.data?.list)) {
      throw new Error(`节假日接口数据无效：${body.msg ?? '未知错误'}`)
    }
    const workdays = new Map(body.data.list.map((item) => [String(item.date), item.workday === 1]))
    const days = buildFallbackMonth(year, month).map((day) => ({
      ...day,
      isWorkday: workdays.get(day.date.replaceAll('-', '')) ?? day.isWorkday,
      fromFallback: false
    }))
    await writeLog('节假日服务', `${year}年${month}月获取成功，共 ${days.length} 天`)
    return days
  }
}

/** 校验年和月，避免异常参数进入网络和路径。 */
function validateMonth(year: number, month: number): void {
  if (!Number.isInteger(year) || year < 2000 || year > 2200 || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error('年或月参数不合法')
  }
}

/** 生成周一至周五为工作日的完整月份。 */
function buildFallbackMonth(year: number, month: number): HolidayDay[] {
  const result: HolidayDay[] = []
  const totalDays = new Date(year, month, 0).getDate()
  for (let day = 1; day <= totalDays; day += 1) {
    const date = new Date(year, month - 1, day)
    result.push({ date: formatDate(date), isWorkday: isWeekday(date), fromFallback: true })
  }
  return result
}

/** 判断日期是否为周一至周五。 */
function isWeekday(date: Date): boolean {
  return date.getDay() >= 1 && date.getDay() <= 5
}

/** 把本地日期格式化为 yyyy-MM-dd。 */
function formatDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
