/** 拆分 SD 提示词，括号内的逗号不会作为分隔符。 */
export function parsePromptTags(input: string): string[] {
  const result: string[] = []
  let current = ''
  let depth = 0
  for (const character of input) {
    if (character === '(' || character === '[' || character === '{') depth += 1
    if (character === ')' || character === ']' || character === '}') depth = Math.max(0, depth - 1)
    if (character === ',' && depth === 0) {
      appendUniqueTag(result, current)
      current = ''
    } else {
      current += character
    }
  }
  appendUniqueTag(result, current)
  return result
}

/** 去掉提示词外层括号和末尾权重，得到用于查词典的基础标签。 */
export function normalizeTagForLookup(tag: string): string {
  let normalized = tag.trim()
  while (
    (normalized.startsWith('(') && normalized.endsWith(')')) ||
    (normalized.startsWith('[') && normalized.endsWith(']')) ||
    (normalized.startsWith('{') && normalized.endsWith('}'))
  ) {
    normalized = normalized.slice(1, -1).trim()
  }
  return normalized.replace(/:\s*-?\d+(?:\.\d+)?$/, '').trim().toLowerCase()
}

/** 按不区分大小写规则追加非空且不重复的标签。 */
function appendUniqueTag(result: string[], rawTag: string): void {
  const tag = rawTag.trim()
  if (!tag) return
  if (!result.some((item) => item.toLowerCase() === tag.toLowerCase())) result.push(tag)
}
