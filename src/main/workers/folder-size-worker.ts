import { parentPort } from 'node:worker_threads'
import { calculateDirectorySize } from '../services/folder-size-scanner'

/** 接收一个目录任务并把结果返回主进程。 */
async function handleTask(message: { path: string }): Promise<void> {
  try {
    parentPort?.postMessage(await calculateDirectorySize(message.path))
  } catch (error) {
    parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}

parentPort?.once('message', (message: { path: string }) => void handleTask(message))
