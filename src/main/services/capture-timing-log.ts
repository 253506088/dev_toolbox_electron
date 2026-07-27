import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

type TimingDetails = Record<string, unknown>

/** 每次截图任务的增量 JSONL 计时日志，单行损坏不会影响其余记录的分析。 */
export class CaptureTimingLog {
  readonly path: string
  private readonly startedAt = performance.now()
  private sequence = 0
  private writes: Promise<void> = Promise.resolve()
  private writeFailure: Error | null = null

  private constructor(outputDirectory: string) {
    this.path = join(outputDirectory, 'capture-timing.log')
  }

  static async create(outputDirectory: string, details: TimingDetails): Promise<CaptureTimingLog> {
    const log = new CaptureTimingLog(outputDirectory)
    await writeFile(log.path, '', 'utf8')
    log.record('task.start', undefined, details)
    return log
  }

  record(event: string, durationMs?: number, details: TimingDetails = {}): void {
    const entry = {
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      elapsedMs: roundMs(performance.now() - this.startedAt),
      event,
      ...(durationMs === undefined ? {} : { durationMs: roundMs(durationMs) }),
      ...details
    }
    this.writes = this.writes
      .then(() => appendFile(this.path, `${JSON.stringify(entry)}\n`, 'utf8'))
      .catch((error) => {
        this.writeFailure = error instanceof Error ? error : new Error(String(error))
      })
  }

  async measure<T>(event: string, action: () => Promise<T>, details: TimingDetails = {}): Promise<T> {
    const startedAt = performance.now()
    try {
      const result = await action()
      this.record(event, performance.now() - startedAt, { status: 'ok', ...details })
      return result
    } catch (error) {
      this.record(event, performance.now() - startedAt, {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        ...details
      })
      throw error
    }
  }

  async finish(status: 'complete' | 'stopped' | 'error', details: TimingDetails = {}): Promise<void> {
    this.record('task.finish', performance.now() - this.startedAt, { status, ...details })
    await this.writes
    if (this.writeFailure) console.error('截图计时日志写入失败', this.writeFailure)
  }
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100
}
