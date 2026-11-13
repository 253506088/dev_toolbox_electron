import { mkdtemp, mkdir, writeFile, link, symlink, rm, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BigIntStats } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { calculateDirectorySize, fileSizeResult } from './folder-size-scanner'

const temporaryDirectories: string[] = []
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'toolbox-folder-size-'))
  temporaryDirectories.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('目录文件内容大小统计', () => {
  it('同一文件的硬链接只计一次，但内容相同的独立文件分别计数', async () => {
    const root = await fixture()
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'first.bin'), Buffer.alloc(1024, 1))
    await link(join(root, 'first.bin'), join(root, 'nested', 'shared.bin'))
    await writeFile(join(root, 'copy.bin'), Buffer.alloc(1024, 1))
    const result = await calculateDirectorySize(root)
    expect(result.size).toBe(2048)
    expect(result.logicalSize).toBe(3072)
    expect(result.hardlinks).toHaveLength(1)
    expect(result.skippedEntries).toBe(0)
  })

  it('不跟随指向目录外部和自身的联接点，避免越界和循环', async () => {
    const root = await fixture()
    const external = await fixture()
    await writeFile(join(root, 'own.bin'), Buffer.alloc(10))
    await writeFile(join(external, 'outside.bin'), Buffer.alloc(4096))
    await symlink(external, join(root, 'external'), 'junction')
    await symlink(root, join(root, 'cycle'), 'junction')
    const result = await calculateDirectorySize(root)
    expect(result).toMatchObject({ size: 10, logicalSize: 10, skippedEntries: 0 })
    expect((await calculateDirectorySize(join(root, 'external'))).size).toBe(0)
  })

  it('保留NTFS超过Number安全范围的文件编号，并区分不同卷', () => {
    const make = (ino: bigint, dev = 1n, nlink = 2n): BigIntStats => ({
      ino, dev, nlink, size: 7n, isFile: () => true, isSymbolicLink: () => false
    }) as BigIntStats
    const first = fileSizeResult(make(9007199254740992n))
    const second = fileSizeResult(make(9007199254740993n))
    const anotherVolume = fileSizeResult(make(9007199254740992n, 2n))
    expect(new Set([first, second, anotherVolume].map((result) => result.hardlinks[0].identity)).size).toBe(3)
    expect(fileSizeResult(make(0n)).hardlinks).toEqual([])
    expect(fileSizeResult(make(9n, 1n, 1n)).hardlinks).toEqual([])
  })

  it('空目录返回完整的零结果，不存在或普通文件作为目录时明确报错', async () => {
    const root = await fixture()
    expect(await calculateDirectorySize(root)).toEqual({ size: 0, logicalSize: 0, hardlinks: [], skippedEntries: 0 })
    await expect(calculateDirectorySize(join(root, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' })
    const file = join(root, 'file.txt')
    await writeFile(file, 'x')
    await expect(calculateDirectorySize(file)).rejects.toThrow('不是文件夹')
    expect(fileSizeResult(await lstat(root, { bigint: true })).size).toBe(0)
  })
})
