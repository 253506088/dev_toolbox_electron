import { copyFile, mkdir, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'

const defaultSource = 'D:\\code\\my\\1\\dev_toolbox\\assets\\ffmpeg\\ffmpeg.exe'
const source = resolve(process.env.DEV_TOOLBOX_FFMPEG_SOURCE || defaultSource)
const target = resolve('resources/ffmpeg/ffmpeg.exe')

/** 校验 FFmpeg 文件大小和版本输出，防止打出缺资源安装包。 */
async function validateFfmpeg(filePath: string): Promise<string> {
  const info = await stat(filePath)
  if (!info.isFile() || info.size < 10 * 1024 * 1024) throw new Error(`FFmpeg 文件异常：${filePath}`)
  const result = spawnSync(filePath, ['-version'], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(`FFmpeg 无法运行：${result.stderr || result.error?.message || '未知错误'}`)
  return result.stdout.split(/\r?\n/)[0]?.trim() || '版本未知'
}

/** 从指定来源复制并验证第三期打包所需的 FFmpeg。 */
async function prepare(): Promise<void> {
  await validateFfmpeg(source)
  await mkdir(dirname(target), { recursive: true })
  if (source.toLowerCase() !== target.toLowerCase()) await copyFile(source, target)
  const version = await validateFfmpeg(target)
  console.info(`FFmpeg 资源已准备：${target}`)
  console.info(version)
}

void prepare().catch((error: unknown) => {
  console.error(`准备 FFmpeg 失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
