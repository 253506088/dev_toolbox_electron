import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

// 固定上游版本和内容哈希；字体二进制属于可重建的下载资源，OFL 许可随安装包分发。
const revision = '2894aab31764f10f29c421bdfd2340d3b382d384'
const expectedHash = 'a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da'
const source = `https://raw.githubusercontent.com/google/fonts/${revision}/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf`
const target = resolve('resources/subtitle-fonts/NotoSansSC.ttf')

function valid(bytes: Uint8Array): boolean {
  return createHash('sha256').update(bytes).digest('hex') === expectedHash
}

async function prepare(): Promise<void> {
  const license = await readFile(resolve('resources/subtitle-fonts/OFL.txt'), 'utf8')
  if (!license.includes('SIL OPEN FONT LICENSE')) throw new Error('字幕字体许可文件缺失或无效')
  const cached = await readFile(target).catch(() => null)
  if (cached && valid(cached)) {
    console.info(`字幕烧录字体已就绪：${target}`)
    return
  }
  console.info('正在准备字幕烧录所需的 Noto Sans SC 中文字体…')
  const response = await fetch(source, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`字体下载失败：HTTP ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (!valid(bytes)) throw new Error('字幕字体内容校验失败，请重新下载')
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, bytes, { flag: 'wx' })
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true })
  }
  console.info(`字幕烧录字体已准备并校验：${target}`)
}

void prepare().catch((error: unknown) => {
  console.error(`准备字幕字体失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
