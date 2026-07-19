import { XMLBuilder, XMLParser } from 'fast-xml-parser'
import { format as formatSql } from 'sql-formatter'

export type TextOperation =
  | 'sql-format'
  | 'sql-compress'
  | 'sql-in-format'
  | 'sql-in-unformat'
  | 'json-format'
  | 'json-compress'
  | 'json-escape'
  | 'json-unescape'
  | 'unicode-encode'
  | 'unicode-decode'
  | 'base64-encode'
  | 'base64-decode'
  | 'url-encode'
  | 'url-decode'
  | 'xml-to-json'
  | 'json-to-xml'

/**
 * 执行不接触系统资源的文本转换，供界面线程、Worker 和测试共用。
 */
export function executeTextOperation(operation: TextOperation, input: string): string {
  switch (operation) {
    case 'sql-format':
      return formatSqlText(input)
    case 'sql-compress':
      return compressSql(input)
    case 'sql-in-format':
      return formatSqlIn(input)
    case 'sql-in-unformat':
      return unformatSqlIn(input)
    case 'json-format':
      return formatJson(input)
    case 'json-compress':
      return compressJson(input)
    case 'json-escape':
      return escapeJsonText(input)
    case 'json-unescape':
      return unescapeJsonText(input)
    case 'unicode-encode':
      return encodeUnicode(input)
    case 'unicode-decode':
      return decodeUnicode(input)
    case 'base64-encode':
      return encodeBase64(input)
    case 'base64-decode':
      return decodeBase64(input)
    case 'url-encode':
      return encodeURIComponent(input)
    case 'url-decode':
      return decodeURIComponent(input)
    case 'xml-to-json':
      return xmlToJson(input)
    case 'json-to-xml':
      return jsonToXml(input)
  }
}

/**
 * 使用成熟格式化器整理 SQL，并统一为大写关键字和两个空格缩进。
 */
export function formatSqlText(input: string): string {
  if (!input.trim()) return ''
  return formatSql(input, {
    language: 'sql',
    keywordCase: 'upper',
    tabWidth: 2,
    linesBetweenQueries: 2
  })
}

/**
 * 把 SQL 中的换行、制表符和连续空格压成单行。
 */
export function compressSql(input: string): string {
  return input.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim()
}

/**
 * 把每行一个值转成 SQL IN 可直接粘贴的单引号列表。
 */
export function formatSqlIn(input: string): string {
  return input
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `'${line}'`)
    .join(',\n')
}

/**
 * 把逗号分隔的 SQL IN 值还原成每行一个值。
 */
export function unformatSqlIn(input: string): string {
  let content = input.trim()
  if (content.startsWith('(') && content.endsWith(')')) {
    content = content.slice(1, -1)
  }

  return content
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const isQuoted =
        (value.startsWith("'") && value.endsWith("'")) ||
        (value.startsWith('"') && value.endsWith('"'))
      return isQuoted ? value.slice(1, -1) : value
    })
    .join('\n')
}

/**
 * 校验并以两个空格格式化 JSON。
 */
export function formatJson(input: string): string {
  if (!input.trim()) return ''
  return JSON.stringify(JSON.parse(input.trim()), null, 2)
}

/**
 * 校验并压缩 JSON。
 */
export function compressJson(input: string): string {
  if (!input.trim()) return ''
  return JSON.stringify(JSON.parse(input.trim()))
}

/**
 * 按旧版顺序转义反斜杠、引号、换行、回车和制表符。
 */
export function escapeJsonText(input: string): string {
  return input
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t')
}

/**
 * 按旧版顺序还原常见转义字符。
 */
export function unescapeJsonText(input: string): string {
  return input
    .replaceAll('\\t', '\t')
    .replaceAll('\\r', '\r')
    .replaceAll('\\n', '\n')
    .replaceAll('\\"', '"')
    .replaceAll('\\\\', '\\')
}

/**
 * 把非 ASCII 字符转换成 Unicode 转义写法。
 */
export function encodeUnicode(input: string): string {
  return [...input]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint > 127 ? `\\u${codePoint.toString(16).padStart(4, '0')}` : character
    })
    .join('')
}

/**
 * 还原四位十六进制 Unicode 转义。
 */
export function decodeUnicode(input: string): string {
  return input.replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  )
}

/**
 * 按 UTF-8 编码文本，再转换为 Base64。
 */
export function encodeBase64(input: string): string {
  const bytes = new TextEncoder().encode(input)
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

/**
 * 解码 Base64，并严格按 UTF-8 还原文本。
 */
export function decodeBase64(input: string): string {
  const normalized = input.trim().replaceAll(/\s/g, '')
  const binary = atob(normalized)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

/**
 * 按 Parker 风格把 XML 转为易读 JSON。
 */
export function xmlToJson(input: string): string {
  if (!input.trim()) return ''
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: false
  })
  return JSON.stringify(parser.parse(input), null, 2)
}

/**
 * 把 JSON 放进 root 根节点并生成带声明的 XML。
 */
export function jsonToXml(input: string): string {
  if (!input.trim()) return ''
  const parsed: unknown = JSON.parse(input)
  const rootContent = normalizeXmlRoot(parsed)
  const builder = new XMLBuilder({
    format: true,
    ignoreAttributes: true,
    suppressEmptyNode: false,
    indentBy: '  '
  })
  return `<?xml version="1.0"?>\n${builder.build({ root: rootContent })}`.trimEnd()
}

/**
 * 把非对象根值转换成 XMLBuilder 能稳定输出的结构。
 */
function normalizeXmlRoot(value: unknown): unknown {
  if (Array.isArray(value)) return { item: value }
  if (value !== null && typeof value === 'object') return value
  return String(value)
}
