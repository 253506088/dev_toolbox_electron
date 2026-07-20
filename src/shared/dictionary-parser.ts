import { parse } from 'csv-parse/sync'

export const COMMON_SD_TAGS: Record<string, string> = {
  masterpiece: '杰作',
  'best quality': '最佳质量',
  'high quality': '高质量',
  absurdres: '超高分辨率',
  '1boy': '1个男孩',
  '1girl': '1个女孩',
  solo: '单人',
  'white background': '白色背景',
  'upper body': '上半身',
  'looking at viewer': '直视观众',
  smile: '微笑',
  'long hair': '长发',
  'short hair': '短发',
  'black hair': '黑发',
  'blonde hair': '金发',
  'blue eyes': '蓝眼',
  'red eyes': '红眼'
}

/** 结构化解析 GitHub CSV，并只保留具有中英文内容的行。 */
export function parseDictionaryCsv(csvText: string, minimumEntries = 50_000): Record<string, string> {
  const rows = parse(csvText, { bom: true, relaxColumnCount: true, skipEmptyLines: true }) as string[][]
  const dictionary: Record<string, string> = {}
  for (const row of rows) {
    const key = String(row[0] ?? '').trim().toLowerCase()
    const value = String(row[1] ?? '').trim()
    if (key && value && key !== 'tag' && key !== 'name') dictionary[key] = value
  }
  const count = Object.keys(dictionary).length
  if (count < minimumEntries) throw new Error(`有效词条只有 ${count} 条，低于安全阈值 ${minimumEntries}`)
  return dictionary
}

/** 让内置常用词覆盖远程翻译。 */
export function mergeCommonTags(dictionary: Record<string, string>): Record<string, string> {
  return { ...dictionary, ...COMMON_SD_TAGS }
}
