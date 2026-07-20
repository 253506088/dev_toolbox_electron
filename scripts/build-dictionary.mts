import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { mergeCommonTags, parseDictionaryCsv } from '../src/shared/dictionary-parser.ts'

const SOURCE_URL = 'https://raw.githubusercontent.com/Physton/sd-webui-prompt-all-in-one-assets/main/tags/danbooru.zh_CN.csv'

/** 从 GitHub 构建安装包内置 SD 词典。 */
async function buildDictionary(): Promise<void> {
  console.info('开始从 GitHub 下载 SD 中文词典...')
  const response = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`GitHub 返回 HTTP ${response.status}`)
  const dictionary = mergeCommonTags(parseDictionaryCsv(await response.text()))
  const outputPath = resolve('resources/data/sd_tags.json')
  const temporaryPath = `${outputPath}.tmp`
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(temporaryPath, JSON.stringify(dictionary, null, 2), 'utf8')
  await rename(temporaryPath, outputPath)
  console.info(`SD 词典构建完成：${outputPath}，共 ${Object.keys(dictionary).length} 条`)
}

void buildDictionary().catch((error) => {
  console.error('SD 词典构建失败：', error)
  process.exitCode = 1
})
