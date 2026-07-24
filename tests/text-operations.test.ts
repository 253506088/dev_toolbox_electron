import { describe, expect, it } from 'vitest'
import {
  compressJson,
  compressSql,
  decodeBase64,
  decodeUnicode,
  encodeBase64,
  encodeUnicode,
  escapeJsonText,
  formatJson,
  formatSqlIn,
  formatSqlText,
  jsonToXml,
  unescapeJsonText,
  unformatSqlIn,
  xmlToJson
} from '../src/renderer/src/utils/text-operations'

describe('文本转换核心', () => {
  it('格式化 SQL 并统一关键字大小写', () => {
    const result = formatSqlText('select id,name from users where id=1')
    expect(result).toContain('SELECT')
    expect(result).toMatch(/FROM\s+users/)
    expect(result).toContain('WHERE')
  })

  it('识别 MyBatis 占位符和 JDBC 问号参数', () => {
    const result = formatSqlText(
      "select * from users where id = #{userId} and name like ${namePattern} and status = ? and created_at > #{query.beginTime}"
    )
    expect(result).toContain('#{userId}')
    expect(result).toContain('${namePattern}')
    expect(result).toContain('#{query.beginTime}')
    expect(result).toContain('= ?')
    expect(result).toContain('WHERE')
  })

  it('把 SQL 压成单行', () => {
    expect(compressSql('SELECT  *\nFROM\tusers')).toBe('SELECT * FROM users')
  })

  it('把多行值格式化成 SQL IN 列表', () => {
    expect(formatSqlIn('a\n b \n\n3')).toBe("'a',\n'b',\n'3'")
  })

  it('去掉 SQL IN 外层括号和引号', () => {
    expect(unformatSqlIn("('a', \"b\", 3)")).toBe('a\nb\n3')
  })

  it('格式化并压缩 JSON', () => {
    const source = '{"name":"老大爷","items":[1,2]}'
    expect(formatJson(source)).toContain('\n  "name": "老大爷"')
    expect(compressJson(formatJson(source))).toBe(source)
  })

  it('非法 JSON 会抛出异常而不是覆盖原文', () => {
    expect(() => formatJson('{bad json}')).toThrow()
  })

  it('转义与去转义常见字符可往返', () => {
    const source = 'a\\b\n"c"\t'
    expect(unescapeJsonText(escapeJsonText(source))).toBe(source)
  })

  it('中文 Unicode 编码可往返', () => {
    const encoded = encodeUnicode('开发者 ABC')
    expect(encoded).toBe('\\u5f00\\u53d1\\u8005 ABC')
    expect(decodeUnicode(encoded)).toBe('开发者 ABC')
  })

  it('中文 Base64 编解码可往返', () => {
    const encoded = encodeBase64('开发者工具箱')
    expect(decodeBase64(encoded)).toBe('开发者工具箱')
  })

  it('XML 按对象结构转成 JSON', () => {
    const result = JSON.parse(xmlToJson('<root><name>工具箱</name><item>1</item></root>'))
    expect(result).toEqual({ root: { name: '工具箱', item: '1' } })
  })

  it('JSON 转 XML 时添加 root 和 XML 声明', () => {
    const result = jsonToXml('{"name":"工具箱","item":["1","2"]}')
    expect(result).toContain('<?xml version="1.0"?>')
    expect(result).toContain('<root>')
    expect(result).toContain('<item>1</item>')
    expect(result).toContain('<item>2</item>')
  })
})
