import { describe, expect, it } from 'vitest'
import {
  calculateNextRunTimes,
  createCronFields,
  parseCronExpression,
  stringifyCron
} from '../src/renderer/src/utils/cron'

describe('Quartz Cron 核心', () => {
  it('默认表达式与旧版一致', () => {
    expect(stringifyCron(createCronFields())).toBe('* * * * * ? *')
  })

  it('反解析六字段表达式并保留默认年份', () => {
    const fields = createCronFields()
    parseCronExpression('0 */5 * * * ?', fields)
    expect(stringifyCron(fields)).toBe('0 0/5 * * * ? *')
  })

  it('拒绝范围外的字段值', () => {
    const fields = createCronFields()
    expect(() => parseCronExpression('70 * * * * ?', fields)).toThrow('秒字段')
  })

  it('计算每十秒执行的未来五次时间', () => {
    const fields = createCronFields()
    parseCronExpression('0/10 * * * * ? *', fields)
    const from = new Date(2026, 6, 18, 12, 0, 3)
    const result = calculateNextRunTimes(fields, from)
    expect(result.map((date) => date.getSeconds())).toEqual([10, 20, 30, 40, 50])
  })
})
