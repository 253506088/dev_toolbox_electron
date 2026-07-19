import { describe, expect, it } from 'vitest'
import {
  parseTableText,
  selectedCellsToTsv,
  sortTableRows
} from '../src/renderer/src/utils/excel-table'

describe('Excel 制表符解析', () => {
  it('保留日期时间内部的空格', () => {
    const result = parseTableText('时间\t名称\n2026-07-18 21:30:00\t任务', true)
    expect(result.rows[0]).toEqual(['2026-07-18 21:30:00', '任务'])
  })

  it('自动纠正数据开头多出的空占位格', () => {
    const result = parseTableText('名称\t数量\n\t苹果\t2', true)
    expect(result.rows[0]).toEqual(['苹果', '2'])
  })

  it('只删除表头和数据都为空的列', () => {
    const result = parseTableText('名称\t\t数量\n苹果\t\t2', true)
    expect(result.headers).toEqual(['名称', '数量'])
    expect(result.rows[0]).toEqual(['苹果', '2'])
  })

  it('数字列按数值而不是字符串排序', () => {
    const rows = [['10'], ['2'], ['1']]
    expect(sortTableRows(rows, 0, 'ascending')).toEqual([['1'], ['2'], ['10']])
    expect(sortTableRows(rows, 0, 'descending')).toEqual([['10'], ['2'], ['1']])
  })

  it('框选复制时为未选位置保留空格子', () => {
    const rows = [
      ['A', 'B'],
      ['C', 'D']
    ]
    expect(selectedCellsToTsv(rows, new Set(['0-0', '1-1']))).toBe('A\t\n\tD')
  })
})
