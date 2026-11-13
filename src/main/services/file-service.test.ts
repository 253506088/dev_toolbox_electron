import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DirectoryBatchEvent } from '../../shared/electron-api'
import type { FolderSizePool } from './folder-size-pool'

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }))
vi.mock('./logger', () => ({ writeLog: vi.fn(async () => undefined) }))
import { FileService } from './file-service'

const directories: string[] = []
async function fixture(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'toolbox-file-service-'))
  directories.push(path)
  return path
}
function context() {
  const calls: string[] = []
  const pool = {
    enqueue: vi.fn((task: { path: string }) => { calls.push(`directory:${task.path}`) }),
    enqueueFile: vi.fn((task: { path: string }, _result: unknown) => { calls.push(`file:${task.path}`) }),
    finishRequest: vi.fn(), cancel: vi.fn()
  }
  const send = vi.fn((channel: string, _event: unknown) => { calls.push(channel) })
  const isDestroyed = vi.fn(() => false)
  return {
    service: new FileService(pool as unknown as FolderSizePool), pool, calls, send, isDestroyed,
    sender: { send, isDestroyed } as unknown as WebContents
  }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('文件管理器元数据与统计接入', () => {
  it('根文件硬链接进入共享队列，元数据先送达，联接点不读取目标容量', async () => {
    const root = await fixture()
    const external = await fixture()
    await mkdir(join(root, 'folder'))
    await writeFile(join(root, 'folder', 'shared.bin'), Buffer.alloc(32))
    await link(join(root, 'folder', 'shared.bin'), join(root, 'root-link.bin'))
    await writeFile(join(root, 'ordinary.bin'), Buffer.alloc(7))
    await writeFile(join(external, 'large.bin'), Buffer.alloc(1024))
    await symlink(external, join(root, 'external'), 'junction')
    const ctx = context()
    await ctx.service.listDirectory(root, 'request', ctx.sender)
    const event = ctx.send.mock.calls.find(([channel]) => channel === 'files:directory-batch')![1] as DirectoryBatchEvent
    expect(event.done).toBe(true)
    expect(event.entries.find((entry) => entry.name === 'root-link.bin')).toMatchObject({ size: null, logicalSize: 32, sizeState: 'pending' })
    expect(event.entries.find((entry) => entry.name === 'ordinary.bin')).toMatchObject({ size: 7, logicalSize: 7, sizeState: 'ready' })
    expect(event.entries.find((entry) => entry.name === 'external')).toMatchObject({ size: 0, logicalSize: 0, isSymbolicLink: true, sizeState: 'ready' })
    expect(ctx.calls[0]).toBe('files:directory-batch')
    expect(ctx.pool.enqueue).toHaveBeenCalledTimes(1)
    expect(ctx.pool.enqueueFile).toHaveBeenCalledTimes(1)
    expect(ctx.pool.enqueueFile.mock.calls[0][1]).toMatchObject({ size: 32, logicalSize: 32, hardlinks: [expect.objectContaining({ size: 32 })] })
    expect(ctx.pool.finishRequest).toHaveBeenCalledWith('request')
  })

  it('空目录发送结束批次，页面已销毁则不提交后台扫描', async () => {
    const root = await fixture()
    const ctx = context()
    await ctx.service.listDirectory(root, 'empty', ctx.sender)
    expect(ctx.send).toHaveBeenCalledWith('files:directory-batch', expect.objectContaining({ entries: [], done: true }))
    await mkdir(join(root, 'child'))
    ctx.send.mockClear()
    ctx.isDestroyed.mockReturnValue(true)
    await ctx.service.listDirectory(root, 'closed', ctx.sender)
    expect(ctx.send).not.toHaveBeenCalled()
    expect(ctx.pool.enqueue).not.toHaveBeenCalled()
    expect(ctx.pool.finishRequest).toHaveBeenCalledWith('closed')
  })
})
