import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { app } from 'electron'
import { basename, extname, join } from 'node:path'
import type { NoteInput, StickyNote } from '../../shared/electron-api'
import { hasSameReminderSchedule } from '../../shared/reminder-rules'
import { readJsonFile, writeJsonAtomic } from './file-storage'
import { writeLog } from './logger'

interface NoteDocument {
  schemaVersion: number
  notes: StickyNote[]
}

const NOTE_COLORS = [
  '#F7D7D9', '#FBE3BC', '#F6EDB6', '#DCECC8', '#C6E7D5', '#BFE4E7',
  '#C9E0F2', '#D3DCF2', '#DED5F0', '#EAD4E8', '#F2D2DF', '#F4D8CC',
  '#E8DDD2', '#D9E2DC', '#D4E7E2', '#CBE6EC', '#D0E1F5', '#D9D8F2',
  '#E5D7EE', '#F0D5E5', '#F5D9D2', '#F7E1C6', '#F3E9C4', '#E3ECCB',
  '#CFE8D0', '#C9E8DE', '#C8E3ED', '#D4E0EC', '#DEDDED', '#E8DCE3'
]
const NOTE_SCHEMA_VERSION = 2
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.gif', '.webp'])

/** 管理便签、提醒配置和便签图片的持久化。 */
export class NoteService {
  private notes: StickyNote[] = []
  private pendingPersist: Promise<void> = Promise.resolve()
  private readonly dataPath = join(app.getPath('userData'), 'notes-v1.json')
  private readonly imageDirectory = join(app.getPath('userData'), 'images')

  /** 初始化数据目录并读取便签。 */
  async initialize(): Promise<void> {
    await mkdir(this.imageDirectory, { recursive: true })
    const document = await readJsonFile<NoteDocument | null>(this.dataPath, null)
    const hasImageInventory = Array.isArray(document?.notes) && document.notes.every((note) =>
      Array.isArray(note?.imageNames) && note.imageNames.every((name) => typeof name === 'string')
    )
    this.notes = hasImageInventory ? document!.notes : []
    if (hasImageInventory && document?.schemaVersion !== NOTE_SCHEMA_VERSION) {
      this.notes = this.notes.map((note, index) => ({ ...note, color: NOTE_COLORS[index % NOTE_COLORS.length] }))
      await this.persist()
    }
    // 缺失或损坏的文档不能证明图片已不再使用，保留文件供恢复。
    if (hasImageInventory) await this.removeOrphanedImages()
    await writeLog('便签服务', `已加载 ${this.notes.length} 条便签`)
  }

  /** 按更新时间倒序返回便签副本。 */
  list(): StickyNote[] {
    return structuredClone(this.notes).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  /** 新建便签并持久化。 */
  async create(input: NoteInput): Promise<StickyNote> {
    const now = new Date().toISOString()
    const note: StickyNote = {
      id: randomUUID(),
      content: input.content,
      color: this.nextColor(),
      imageNames: input.imageNames.map(validateImageName),
      createdAt: now,
      updatedAt: now,
      reminder: input.reminder
    }
    this.notes.unshift(note)
    await this.persist()
    await writeLog('便签服务', `已新建便签：${note.id}`)
    return structuredClone(note)
  }

  /** 更新指定便签并清理已移除图片。 */
  async update(id: string, input: NoteInput): Promise<StickyNote> {
    const index = this.notes.findIndex((note) => note.id === id)
    if (index < 0) throw new Error('要更新的便签不存在')
    const previous = this.notes[index]
    const imageNames = input.imageNames.map(validateImageName)
    // 编辑器可能在提醒触发前打开，不能用旧副本清除主进程刚写下的去重记录。
    const reminder = previous.reminder && input.reminder && hasSameReminderSchedule(previous.reminder, input.reminder)
      ? { ...input.reminder, lastTriggered: previous.reminder.lastTriggered }
      : input.reminder
    const note: StickyNote = {
      ...previous,
      content: input.content,
      imageNames,
      reminder,
      updatedAt: new Date().toISOString()
    }
    this.notes[index] = note
    await this.persist()
    await this.removeImagesIfUnreferenced(previous.imageNames.filter((name) => !imageNames.includes(name)))
    await writeLog('便签服务', `已更新便签：${id}`)
    return structuredClone(note)
  }

  /** 删除便签及其图片。 */
  async delete(id: string): Promise<void> {
    const note = this.notes.find((item) => item.id === id)
    if (!note) return
    this.notes = this.notes.filter((item) => item.id !== id)
    await this.persist()
    await this.removeImagesIfUnreferenced(note.imageNames)
    await writeLog('便签服务', `已删除便签：${id}`)
  }

  /** 清空全部便签和关联图片。 */
  async clear(): Promise<void> {
    const images = this.notes.flatMap((note) => note.imageNames)
    this.notes = []
    await this.persist()
    await this.removeImagesIfUnreferenced(images)
    await writeLog('便签服务', '已清空全部便签')
  }

  /** 保存 data URL 图片并返回随机文件名。 */
  async saveImage(dataUrl: string): Promise<string> {
    const match = /^data:image\/(png|jpeg|gif|webp);base64,([a-z0-9+/=\r\n]+)$/i.exec(dataUrl)
    if (!match) throw new Error('剪贴板或拖入内容不是支持的图片')
    const bytes = Buffer.from(match[2], 'base64')
    if (bytes.length === 0 || bytes.length > 25 * 1024 * 1024) throw new Error('图片为空或超过 25MB')
    const extension = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase()
    const imageName = `${randomUUID()}.${extension}`
    await writeFile(this.getImagePath(imageName), bytes)
    await writeLog('便签服务', `已保存便签图片：${imageName}，${bytes.length} 字节`)
    return imageName
  }

  /** 删除未被任何便签引用的临时图片。 */
  async deleteTempImage(imageName: string): Promise<void> {
    validateImageName(imageName)
    if (this.notes.some((note) => note.imageNames.includes(imageName))) return
    await this.removeImage(imageName)
  }

  /** 返回经过文件名校验的便签图片绝对路径。 */
  getImagePath(imageName: string): string {
    return join(this.imageDirectory, validateImageName(imageName))
  }

  /** 更新提醒的最后触发时间并返回新便签。 */
  async markReminderTriggered(id: string, triggeredAt: string): Promise<StickyNote | null> {
    const note = this.notes.find((item) => item.id === id)
    if (!note?.reminder) return null
    note.reminder = { ...note.reminder, lastTriggered: triggeredAt }
    note.updatedAt = triggeredAt
    await this.persist()
    return structuredClone(note)
  }

  /** 原子保存便签文档。 */
  private async persist(): Promise<void> {
    // 提醒触发与编辑保存可以同时到达；按调用顺序写快照，避免共用的 .tmp
    // 相互覆盖或重命名失败，也避免较早的状态最后才落盘。
    const document = { schemaVersion: NOTE_SCHEMA_VERSION, notes: structuredClone(this.notes) } satisfies NoteDocument
    const operation = this.pendingPersist.then(() => writeJsonAtomic(this.dataPath, document))
    this.pendingPersist = operation.catch(() => {})
    await operation
  }

  /** 优先选择当前便签尚未使用的颜色，用完后选择使用次数最少的颜色。 */
  private nextColor(): string {
    const counts = new Map(NOTE_COLORS.map((color) => [color, 0]))
    for (const note of this.notes) {
      if (counts.has(note.color)) counts.set(note.color, (counts.get(note.color) ?? 0) + 1)
    }
    const minimum = Math.min(...counts.values())
    const previousColor = this.notes[0]?.color
    const start = this.notes.length % NOTE_COLORS.length
    for (let offset = 0; offset < NOTE_COLORS.length; offset += 1) {
      const color = NOTE_COLORS[(start + offset) % NOTE_COLORS.length]
      if (counts.get(color) === minimum && color !== previousColor) return color
    }
    return NOTE_COLORS[start]
  }

  /** 删除候选图片中已经不被任何便签引用的文件。 */
  private async removeImagesIfUnreferenced(imageNames: string[]): Promise<void> {
    const referenced = new Set(this.notes.flatMap((note) => note.imageNames))
    const removable = [...new Set(imageNames)].filter((name) => !referenced.has(name))
    await Promise.all(removable.map((name) => this.removeImage(name)))
  }

  /** 启动时清理由异常退出遗留、且没有便签引用的图片。 */
  private async removeOrphanedImages(): Promise<void> {
    const referenced = new Set(this.notes.flatMap((note) => note.imageNames))
    const entries = await readdir(this.imageDirectory, { withFileTypes: true })
    const orphaned = entries
      .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase()) && !referenced.has(entry.name))
      .map((entry) => entry.name)
    await Promise.all(orphaned.map((name) => this.removeImage(name)))
    if (orphaned.length > 0) await writeLog('便签服务', `已清理 ${orphaned.length} 张未引用图片`)
  }

  /** 删除一张受控图片，文件不存在时忽略。 */
  private async removeImage(imageName: string): Promise<void> {
    await rm(this.getImagePath(imageName), { force: true })
  }
}

/** 阻止绝对路径、父级路径和非图片扩展名越界。 */
function validateImageName(imageName: string): string {
  if (basename(imageName) !== imageName || !IMAGE_EXTENSIONS.has(extname(imageName).toLowerCase())) {
    throw new Error('便签图片文件名不合法')
  }
  return imageName
}
