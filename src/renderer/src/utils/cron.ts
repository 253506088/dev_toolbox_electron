export type CronMode = 'every' | 'range' | 'interval' | 'specific'

export interface CronField {
  name: string
  min: number
  max: number
  isWeek?: boolean
  optional?: boolean
  mode: CronMode
  rangeStart: number
  rangeEnd: number
  start: number
  interval: number
  specificValues: number[]
}

/**
 * 创建与旧版一致的 Quartz 七字段初始状态。
 */
export function createCronFields(): CronField[] {
  return [
    createField('秒', 0, 59),
    createField('分钟', 0, 59),
    createField('小时', 0, 23),
    createField('日', 1, 31),
    createField('月', 1, 12),
    createField('周', 1, 7, true),
    createField('年', 2024, 2099, false, true)
  ]
}

/**
 * 创建单个 Cron 字段。
 */
function createField(
  name: string,
  min: number,
  max: number,
  isWeek = false,
  optional = false
): CronField {
  return {
    name,
    min,
    max,
    isWeek,
    optional,
    mode: 'every',
    rangeStart: min,
    rangeEnd: Math.min(min + 1, max),
    start: min,
    interval: 1,
    specificValues: []
  }
}

/**
 * 把七个字段拼成 Quartz 风格表达式。
 */
export function stringifyCron(fields: CronField[]): string {
  return fields.map(stringifyCronField).join(' ')
}

/**
 * 把单个字段状态转成表达式片段。
 */
export function stringifyCronField(field: CronField): string {
  if (field.mode === 'every') return field.isWeek ? '?' : '*'
  if (field.mode === 'range') return `${field.rangeStart}-${field.rangeEnd}`
  if (field.mode === 'interval') return `${field.start}/${field.interval}`
  if (field.specificValues.length === 0) return field.isWeek ? '?' : '*'
  return [...field.specificValues].sort((a, b) => a - b).join(',')
}

/**
 * 把表达式反解析回现有字段；少于六段时明确报错。
 */
export function parseCronExpression(expression: string, fields: CronField[]): void {
  const parts = expression.trim().split(/\s+/)
  if (parts.length < 6 || parts.length > 7) {
    throw new Error('Cron 表达式必须包含 6 或 7 个字段。')
  }
  parts.forEach((part, index) => parseCronField(part, fields[index]))
}

/**
 * 解析一个字段的通配、范围、步进或指定值。
 */
function parseCronField(token: string, field: CronField): void {
  if (token === '*' || token === '?') {
    field.mode = 'every'
    field.specificValues = []
    return
  }
  if (token.includes('-') && !token.includes('/')) {
    const [start, end] = token.split('-').map(Number)
    validateValues(field, [start, end])
    field.mode = 'range'
    field.rangeStart = start
    field.rangeEnd = end
    return
  }
  if (token.includes('/')) {
    const [startPart, intervalPart] = token.split('/')
    const start = startPart === '*' ? field.min : Number(startPart)
    const interval = Number(intervalPart)
    validateValues(field, [start])
    if (!Number.isInteger(interval) || interval < 1) throw new Error(`${field.name}步长必须大于 0。`)
    field.mode = 'interval'
    field.start = start
    field.interval = interval
    return
  }

  const values = token.split(',').map(Number)
  validateValues(field, values)
  field.mode = 'specific'
  field.specificValues = [...new Set(values)]
}

/**
 * 检查字段值是否为范围内的整数。
 */
function validateValues(field: CronField, values: number[]): void {
  if (values.some((value) => !Number.isInteger(value) || value < field.min || value > field.max)) {
    throw new Error(`${field.name}字段必须在 ${field.min} 到 ${field.max} 之间。`)
  }
}

/**
 * 从指定时间后一秒开始，计算最多五次运行时间。
 */
export function calculateNextRunTimes(
  fields: CronField[],
  from = new Date(),
  count = 5,
  maxIterations = 100_000
): Date[] {
  const results: Date[] = []
  const current = new Date(from)
  current.setMilliseconds(0)

  for (let iteration = 0; iteration < maxIterations && results.length < count; iteration++) {
    current.setSeconds(current.getSeconds() + 1)
    if (matchesCron(current, fields)) results.push(new Date(current))
  }
  return results
}

/**
 * 判断一个时间是否满足七个字段。
 */
function matchesCron(date: Date, fields: CronField[]): boolean {
  const day = date.getDay() === 0 ? 1 : date.getDay() + 1
  const values = [
    date.getSeconds(),
    date.getMinutes(),
    date.getHours(),
    date.getDate(),
    date.getMonth() + 1,
    day,
    date.getFullYear()
  ]
  return fields.every((field, index) => matchesCronField(field, values[index]))
}

/**
 * 判断数值是否匹配一个字段状态。
 */
function matchesCronField(field: CronField, value: number): boolean {
  if (field.mode === 'every') return true
  if (field.mode === 'range') return value >= field.rangeStart && value <= field.rangeEnd
  if (field.mode === 'interval') {
    return value >= field.start && (value - field.start) % field.interval === 0
  }
  return field.specificValues.includes(value)
}
