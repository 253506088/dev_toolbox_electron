import { format } from 'sql-formatter'

interface SqlPart { text: string; cdata: boolean; protected?: boolean }

/** Format SQL without interpreting or rewriting MyBatis parameters, attributes, or literals. */
export function formatSqlTemplate(input: string): string {
  if (!input.trim()) return ''
  let prefix = '__TOOLBOX_SQL_'
  while (input.includes(prefix)) prefix += '_'
  const originals: string[] = []
  const protect = (raw: string, comment = false): string => {
    const token = `${prefix}${originals.push(raw) - 1}__`
    return comment ? `/*${token}*/` : token
  }
  const parts: SqlPart[] = []
  let offset = 0
  let start = 0
  let cdata = false
  let hasMarkup = false
  const flush = (): void => {
    if (offset > start) parts.push({ text: input.slice(start, offset), cdata })
  }
  const consume = (end: number, comment = false): void => {
    flush()
    parts.push({ text: protect(input.slice(offset, end), comment), cdata, protected: true })
    offset = start = end
  }
  while (offset < input.length) {
    if (input.startsWith('<![CDATA[', offset) && !cdata) {
      consume(offset + 9, true)
      hasMarkup = cdata = true
    } else if (input.startsWith(']]>', offset) && cdata) {
      consume(offset + 3, true)
      cdata = false
    } else if (input.startsWith('<!--', offset) && !cdata) {
      consume(findEnd(input, offset, '-->', 'XML 注释'), true)
    } else if (input.startsWith('/*', offset)) {
      consume(findEnd(input, offset, '*/', 'SQL 注释'), true)
    } else if (input.startsWith('--', offset)) {
      const newline = input.indexOf('\n', offset)
      consume(newline < 0 ? input.length : newline + 1, true)
    } else if ((input[offset] === '#' || input[offset] === '$') && input[offset + 1] === '{') {
      consume(parameterEnd(input, offset))
    } else if ('\'"`'.includes(input[offset])) {
      consume(quotedEnd(input, offset, input[offset]))
    } else if (input[offset] === '[') {
      consume(quotedEnd(input, offset, ']'))
    } else if (!cdata && /^<\/?(?:mapper|select|insert|update|delete|sql|where|set|trim|if|foreach|choose|when|otherwise|bind|include|script)\b/i.test(input.slice(offset))) {
      consume(tagEnd(input, offset), true)
      hasMarkup = true
    } else {
      offset += 1
    }
  }
  flush()
  if (cdata) throw new Error('CDATA 未闭合，请补全 ]]> 后重试。')
  const source = parts.map((part) => {
    if (part.protected || part.cdata) return part.text
    if (hasMarkup) {
      // Keep XML operators intact, including <= and <> written with entities.
      return part.text.replace(/&(?:lt|gt|amp|quot|apos|#\d+|#x[\da-f]+);(?:[=>]|&(?:gt|lt|amp);)?/gi, (entity) => protect(entity))
    }
    return decodeXmlOperators(part.text)
  }).join('')
  const result = format(source, {
    language: 'sql', keywordCase: 'upper', tabWidth: 2, linesBetweenQueries: 2,
    paramTypes: { positional: true, custom: [{ regex: `${prefix}\\d+__` }] }
  })
  return result.replace(new RegExp(`/\\*${prefix}(\\d+)__\\*/|${prefix}(\\d+)__`, 'g'),
    (_token, commentIndex: string | undefined, parameterIndex: string | undefined) => {
      const raw = originals[Number(commentIndex ?? parameterIndex)]
      return !hasMarkup && raw.startsWith('<!--') ? `/*${raw.slice(4, -3).replaceAll('*/', '* /')}*/` : raw
    })
}

function findEnd(input: string, start: number, terminator: string, label: string): number {
  const end = input.indexOf(terminator, start + 2)
  if (end < 0) throw new Error(`${label}未闭合，请补全 ${terminator} 后重试。`)
  return end + terminator.length
}

function quotedEnd(input: string, start: number, quote: string): number {
  for (let index = start + 1; index < input.length; index += 1) {
    if (input[index] === '\\') { index += 1; continue }
    if (input[index] !== quote) continue
    if (input[index + 1] === quote) { index += 1; continue }
    return index + 1
  }
  throw new Error(`引号未闭合（第 ${lineAt(input, start)} 行），请检查 SQL 字符串或标识符。`)
}

function parameterEnd(input: string, start: number): number {
  let depth = 1
  for (let index = start + 2; index < input.length; index += 1) {
    const character = input[index]
    if (character === '\\') { index += 1; continue }
    if (character === '"' || character === "'") {
      index = quotedEnd(input, index, character) - 1
    } else if (character === '{') {
      depth += 1
    } else if (character === '}' && --depth === 0) {
      if (!input.slice(start + 2, index).trim()) throw new Error(`MyBatis 占位符不能为空（第 ${lineAt(input, start)} 行）。`)
      return index + 1
    }
  }
  throw new Error(`MyBatis 占位符未闭合（第 ${lineAt(input, start)} 行），请补全 } 后重试。`)
}

function tagEnd(input: string, start: number): number {
  for (let index = start + 1; index < input.length; index += 1) {
    if (input[index] === '"' || input[index] === "'") index = quotedEnd(input, index, input[index]) - 1
    else if (input[index] === '>') return index + 1
  }
  throw new Error(`MyBatis XML 标签未闭合（第 ${lineAt(input, start)} 行）。`)
}

function lineAt(input: string, index: number): number { return input.slice(0, index).split('\n').length }

function decodeXmlOperators(input: string): string {
  return input.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'").replaceAll('&amp;', '&')
}
