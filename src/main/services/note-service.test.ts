import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electronState = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => electronState.userData }
}))

import { NoteService } from './note-service'

const TEST_IMAGE = 'data:image/png;base64,aGVsbG8='

describe('便签存储', () => {
  beforeEach(async () => {
    electronState.userData = await mkdtemp(join(tmpdir(), 'dev-toolbox-notes-'))
  })

  afterEach(async () => {
    await rm(electronState.userData, { recursive: true, force: true })
  })

  it('少量便签优先使用不同颜色', async () => {
    const service = new NoteService()
    await service.initialize()
    for (let index = 0; index < 8; index += 1) {
      await service.create({ content: `便签 ${index}`, imageNames: [] })
    }
    expect(new Set(service.list().map((note) => note.color)).size).toBe(8)
  })

  it('保存编辑结果后删除不再引用的图片文件', async () => {
    const service = new NoteService()
    await service.initialize()
    const imageName = await service.saveImage(TEST_IMAGE)
    const note = await service.create({ content: '带图片的便签', imageNames: [imageName] })

    await service.update(note.id, { content: note.content, imageNames: [] })

    await expect(access(service.getImagePath(imageName))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('下次启动时清理未被便签引用的临时图片', async () => {
    const firstService = new NoteService()
    await firstService.initialize()
    await firstService.create({ content: '已保存便签', imageNames: [] })
    const imageName = await firstService.saveImage(TEST_IMAGE)

    const restartedService = new NoteService()
    await restartedService.initialize()

    await expect(access(restartedService.getImagePath(imageName))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([undefined, '{incomplete json', '{"schemaVersion":2,"notes":[{}]}'])(
    '缺失或损坏的便签文档不会导致图片被误当孤儿删除：%s',
    async (document) => {
      const firstService = new NoteService()
      await firstService.initialize()
      const imageName = await firstService.saveImage(TEST_IMAGE)
      const dataPath = join(electronState.userData, 'notes-v1.json')
      if (document !== undefined) await writeFile(dataPath, document)

      const restartedService = new NoteService()
      await restartedService.initialize()

      await expect(access(restartedService.getImagePath(imageName))).resolves.toBeUndefined()
      if (document !== undefined) await expect(readFile(dataPath, 'utf8')).resolves.toBe(document)
    }
  )

  it('同一图片被多条便签使用时，删除其中一条不会破坏其他便签', async () => {
    const service = new NoteService()
    await service.initialize()
    const imageName = await service.saveImage(TEST_IMAGE)
    const first = await service.create({ content: '第一条', imageNames: [imageName] })
    await service.create({ content: '第二条', imageNames: [imageName] })

    await service.delete(first.id)

    await expect(access(service.getImagePath(imageName))).resolves.toBeUndefined()
    const restartedService = new NoteService()
    await restartedService.initialize()
    await expect(access(service.getImagePath(imageName))).resolves.toBeUndefined()
  })

  it('并发新建便签按序持久化，不覆盖临时文件或丢失最后的状态', async () => {
    const service = new NoteService()
    await service.initialize()

    await Promise.all(Array.from({ length: 12 }, (_, index) => service.create({ content: `并发 ${index}`, imageNames: [] })))

    const restartedService = new NoteService()
    await restartedService.initialize()
    expect(restartedService.list()).toEqual(service.list())
    expect(restartedService.list()).toHaveLength(12)
  })

  it('触发提醒和保存旧编辑器副本同时发生时保留去重记录及最新正文', async () => {
    const service = new NoteService()
    await service.initialize()
    const schedule = { type: 'daily' as const, hour: 9, minute: 0, enabled: true }
    const note = await service.create({ content: '原文', imageNames: [], reminder: schedule })
    const triggeredAt = new Date().toISOString()

    await Promise.all([
      service.markReminderTriggered(note.id, triggeredAt),
      service.update(note.id, { content: '更新正文', imageNames: [], reminder: schedule })
    ])

    const restartedService = new NoteService()
    await restartedService.initialize()
    expect(restartedService.list()[0]).toMatchObject({ content: '更新正文', reminder: { lastTriggered: triggeredAt } })

    await service.update(note.id, { content: '改时间', imageNames: [], reminder: { ...schedule, minute: 30 } })
    expect(service.list()[0].reminder?.lastTriggered).toBeUndefined()
  })
})
