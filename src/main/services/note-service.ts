import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { app } from 'electron'
import { basename, extname, join } from 'node:path'
import type { NoteInput, StickyNote } from '../../shared/electron-api'
import { readJsonFile, writeJsonAtomic } from './file-storage'
import { writeLog } from './logger'

interface NoteDocument {
  schemaVersion: 1
  notes: StickyNote[]
}

const NOTE_COLORS = [
  '#FFF59D', '#E1BEE7', '#FFCCBC', '#C8E6C9', '#B3E5FC', '#F8BBD0', '#D7CCC8',
  '#CFD8DC', '#FFE0B2', '#FFECB3', '#E8DAEF', '#FFAB91', '#C5E1A5', '#B2DFDB',
  '#F48FB1', '#BCAAA4', '#F3E5F5', '#DCEDC8', '#80DEEA', '#FFCC80', '#D1C4E9'
]

/** 管理便签、提醒配置和便签图片的持久化。 */
export class NoteService {
  private notes: StickyNote[] = []
  private readonly dataPath = join(app.getPath('userData'), 'notes-v1.json')
  private readonly imageDirectory = join(app.getPath('userData'), 'images')

  /** 初始化数据目录并读取便签。 */
  async initialize(): Promise<void> {
    await mkdir(this.imageDirectory, { recursive: true })
    const document = await readJsonFile<NoteDocument>(this.dataPath, { schemaVersion: 1, notes: [] })
    this.notes = Array.isArray(document.notes) ? document.notes : []
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
      color: NOTE_COLORS[Math.floor(Math.random() * NOTE_COLORS.length)],
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
    const note: StickyNote = {
      ...previous,
      content: input.content,
      imageNames,
      reminder: input.reminder,
      updatedAt: new Date().toISOString()
    }
    this.notes[index] = note
    await this.persist()
    await Promise.all(previous.imageNames.filter((name) => !imageNames.includes(name)).map((name) => this.removeImage(name)))
    await writeLog('便签服务', `已更新便签：${id}`)
    return structuredClone(note)
  }

  /** 删除便签及其图片。 */
  async delete(id: string): Promise<void> {
    const note = this.notes.find((item) => item.id === id)
    if (!note) return
    this.notes = this.notes.filter((item) => item.id !== id)
    await this.persist()
    await Promise.all(note.imageNames.map((name) => this.removeImage(name)))
    await writeLog('便签服务', `已删除便签：${id}`)
  }

  /** 清空全部便签和关联图片。 */
  async clear(): Promise<void> {
    const images = this.notes.flatMap((note) => note.imageNames)
    this.notes = []
    await this.persist()
    await Promise.all(images.map((name) => this.removeImage(name)))
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
    await writeJsonAtomic(this.dataPath, { schemaVersion: 1, notes: this.notes } satisfies NoteDocument)
  }

  /** 删除一张受控图片，文件不存在时忽略。 */
  private async removeImage(imageName: string): Promise<void> {
    await rm(this.getImagePath(imageName), { force: true })
  }
}

/** 阻止绝对路径、父级路径和非图片扩展名越界。 */
function validateImageName(imageName: string): string {
  if (basename(imageName) !== imageName || !['.png', '.jpg', '.gif', '.webp'].includes(extname(imageName).toLowerCase())) {
    throw new Error('便签图片文件名不合法')
  }
  return imageName
}
