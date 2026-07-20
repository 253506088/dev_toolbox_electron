import { parentPort } from 'node:worker_threads'
import { parseDictionaryCsv } from '../../shared/dictionary-parser'

/** 接收 CSV 文本并返回经过校验的词典。 */
function handleMessage(message: { csvText: string }): void {
  try {
    parentPort?.postMessage({ entries: parseDictionaryCsv(message.csvText) })
  } catch (error) {
    parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}

parentPort?.once('message', handleMessage)
