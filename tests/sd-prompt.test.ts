import { describe, expect, it } from 'vitest'
import { normalizeTagForLookup, parsePromptTags } from '../src/shared/sd-prompt'
import { mergeCommonTags, parseDictionaryCsv } from '../src/shared/dictionary-parser'

describe('SD 提示词规则', () => {
  it('普通逗号会拆分标签', () => {
    expect(parsePromptTags('a, b, c')).toEqual(['a', 'b', 'c'])
  })

  it('括号内逗号不会拆分', () => {
    expect(parsePromptTags('a, (b, c), d')).toEqual(['a', '(b, c)', 'd'])
  })

  it('重复标签忽略大小写去重', () => {
    expect(parsePromptTags('Girl, girl, BOY')).toEqual(['Girl', 'BOY'])
  })

  it('嵌套括号和权重会还原为基础查词标签', () => {
    expect(normalizeTagForLookup('((White Background:1.2))')).toBe('white background')
  })

  it('空标签会被跳过', () => {
    expect(parsePromptTags('a, , ,b,')).toEqual(['a', 'b'])
  })

  it('CSV 双引号中的逗号能被正确保留', () => {
    expect(parseDictionaryCsv('tag,translation\nfoo,"中文,说明"\n', 1)).toEqual({ foo: '中文,说明' })
  })

  it('CSV BOM 和空行不会产生错误词条', () => {
    expect(parseDictionaryCsv('\ufefftag,translation\r\n\r\nbar,中文\r\n', 1)).toEqual({ bar: '中文' })
  })

  it('内置常用词覆盖远程翻译', () => {
    expect(mergeCommonTags({ masterpiece: '远程翻译' }).masterpiece).toBe('杰作')
  })
})
