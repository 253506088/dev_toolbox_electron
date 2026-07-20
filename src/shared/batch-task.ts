/** 批量图片任务支持的处理类型。 */
export type BatchTaskKind = 'image-resize' | 'image-matting'

/** 单项任务的生命周期状态。 */
export type BatchTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

/** 批量队列中的一个文件任务。 */
export interface BatchTaskItem {
  id: string
  batchId: string
  kind: BatchTaskKind
  inputPath: string
  outputPath: string
  status: BatchTaskStatus
  progress: number
  stage: string
  error?: string
}

/** 批量任务的汇总数据。 */
export interface BatchTaskSummary {
  batchId: string
  total: number
  queued: number
  running: number
  succeeded: number
  failed: number
  cancelled: number
}

/** 主进程推送给界面的批量任务事件。 */
export interface BatchTaskEvent {
  batchId: string
  item: BatchTaskItem
  summary: BatchTaskSummary
}

/** 新建批量任务后的完整快照。 */
export interface BatchTaskSnapshot {
  batchId: string
  items: BatchTaskItem[]
  summary: BatchTaskSummary
}

/** 根据任务列表生成状态汇总。 */
export function summarizeBatch(batchId: string, items: BatchTaskItem[]): BatchTaskSummary {
  return {
    batchId,
    total: items.length,
    queued: items.filter((item) => item.status === 'queued').length,
    running: items.filter((item) => item.status === 'running').length,
    succeeded: items.filter((item) => item.status === 'succeeded').length,
    failed: items.filter((item) => item.status === 'failed').length,
    cancelled: items.filter((item) => item.status === 'cancelled').length
  }
}
