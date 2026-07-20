import { describe, expect, it } from 'vitest'
import { calculateTextMd5 } from './md5-service'

describe('MD5 字符编码', () => {
  it('默认使用 UTF-8', () => {
    expect(calculateTextMd5('hello')).toBe('5d41402abc4b2a76b9719d911017c592')
  })

  it('中文在 UTF-8 和 GBK 下得到不同结果', () => {
    expect(calculateTextMd5('中文', 'utf8')).toBe('a7bac2239fcdcb3a067903d8077c4a07')
    expect(calculateTextMd5('中文', 'gbk')).toBe('bcce109775e8e1972e9f5fcda3e12895')
  })

  it('支持 UTF-16 大小端', () => {
    expect(calculateTextMd5('hello', 'utf16-le')).toBe('fd186dd49a16b1bf2bd2f44e495e14c9')
    expect(calculateTextMd5('hello', 'utf16-be')).toBe('a009bccf13ca2631d3982cd37fbdcd8b')
  })

  it('拒绝未知编码', () => {
    expect(() => calculateTextMd5('hello', 'unknown')).toThrow('不支持的字符编码')
  })

  it('拒绝非字符串输入', () => {
    expect(() => calculateTextMd5(123, 'utf8')).toThrow('MD5 输入文本必须是字符串')
  })
})
