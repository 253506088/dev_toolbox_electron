import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('../src/renderer/src/utils/text-worker-client', () => ({ runTextOperation: mocks.run }))
import { formatOperationError, useOperationState } from '../src/renderer/src/utils/tool-state'

describe('文本工具错误恢复', () => {
  beforeEach(() => { mocks.run.mockReset() })

  it('SQL 解析表错误被压缩为带位置的 SQL 摘要，不误判为 JSON', () => {
    const raw = 'Parse error at token: «EOF» at line 1 column 30\nUnexpected EOF token\n' + 'Expected token\n'.repeat(8000)
    const result = formatOperationError(new Error(raw), 'sql-format')
    expect(result).toContain('line 1 column 30')
    expect(result).toContain('SQL')
    expect(result).not.toContain('JSON')
    expect(result.length).toBeLessThan(320)
  })

  it('失败后保留原文且解除忙碌状态，修正后可以再次格式化', async () => {
    const state = useOperationState()
    mocks.run.mockRejectedValueOnce(new Error('Unexpected token #{time')).mockResolvedValueOnce('SELECT #{time}')
    expect(await state.run('sql-format', 'select #{time')).toBeUndefined()
    expect(state.busy.value).toBe(false)
    expect(state.error.value).toContain('原文已保留')
    expect(await state.run('sql-format', 'select #{time}')).toBe('SELECT #{time}')
    expect(state.error.value).toBe('')
    expect(state.busy.value).toBe(false)
  })

  it('用户修改原文后，晚到的错误不会覆盖当前状态', async () => {
    let reject!: (reason: Error) => void
    let current = true
    mocks.run.mockReturnValue(new Promise((_resolve, failure) => { reject = failure }))
    const state = useOperationState()
    const pending = state.run('sql-format', 'select (', () => current)
    current = false
    reject(new Error('Unexpected EOF'))
    await pending
    expect(state.error.value).toBe('')
    expect(state.busy.value).toBe(false)
  })
})
