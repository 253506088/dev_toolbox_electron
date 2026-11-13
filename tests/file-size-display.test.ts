import { describe, expect, it } from 'vitest'
import { formatExactFileSize, formatFileSize, formatSizeShare } from '../src/shared/file-size-display'

describe('文件容量展示', () => {
  it('列表、图块和汇总使用一致的二进制换算单位', () => {
    expect(formatFileSize(0)).toBe('0 B')
    expect(formatFileSize(1023)).toBe('1023 B')
    expect(formatFileSize(1024)).toBe('1.00 KB')
    expect(formatFileSize(1024 ** 2)).toBe('1.00 MB')
    expect(formatFileSize(100.23 * 1024 ** 3)).toBe('100.2 GB')
    expect(formatFileSize(1024 ** 5)).toBe('1.00 PB')
  })

  it('即将进位的容量不会显示为1024 KB造成单位误读', () => {
    expect(formatFileSize(1024 ** 2 - 1)).toBe('1.00 MB')
    expect(formatFileSize(1024 ** 3 - 1)).toBe('1.00 GB')
  })

  it('未完成、无效和空内容有不同的含义', () => {
    expect(formatFileSize(null)).toBe('计算中…')
    expect(formatFileSize(undefined)).toBe('计算中…')
    for (const invalid of [NaN, Infinity, -1]) expect(formatFileSize(invalid)).toBe('未知')
    expect(formatExactFileSize(1_073_741_824)).toBe('1,073,741,824 字节')
    expect(formatExactFileSize(NaN)).toBe('未知大小')
  })

  it('占比不把很小的文件舍入为零，并限制异常分母', () => {
    expect(formatSizeShare(60, 100)).toBe('60%')
    expect(formatSizeShare(1, 3)).toBe('33.3%')
    expect(formatSizeShare(1, 1_000_000)).toBe('<0.1%')
    expect(formatSizeShare(0, 0)).toBe('0%')
    expect(formatSizeShare(Infinity, 100)).toBe('0%')
    expect(formatSizeShare(200, 100)).toBe('100%')
  })
})
