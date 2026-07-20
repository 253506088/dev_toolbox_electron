import { createHash } from 'node:crypto'
import iconv from 'iconv-lite'
import { MD5_ENCODINGS, type Md5Encoding } from '../../shared/electron-api'

const md5EncodingSet = new Set<string>(MD5_ENCODINGS.map((item) => item.value))

/** 按指定字符编码将文本转换为字节并计算 32 位小写 MD5。 */
export function calculateTextMd5(text: unknown, encoding: unknown = 'utf8'): string {
  if (typeof text !== 'string') throw new Error('MD5 输入文本必须是字符串')
  if (typeof encoding !== 'string' || !md5EncodingSet.has(encoding)) {
    throw new Error(`不支持的字符编码：${String(encoding)}`)
  }
  const bytes = iconv.encode(text, encoding as Md5Encoding)
  return createHash('md5').update(bytes).digest('hex')
}
