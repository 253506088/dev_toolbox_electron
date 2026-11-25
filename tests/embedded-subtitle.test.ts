import { describe, expect, it } from 'vitest'
import { isAbsolute, relative, resolve } from 'node:path'
import type { EmbeddedSubtitleTrack } from '../src/shared/subtitle-api'
import { buildEmbeddedExtractionArgs, chooseEmbeddedSubtitle, embeddedTrackCandidates, embeddedTrackLabel, parseEmbeddedVideoInfo } from '../src/main/services/embedded-subtitle-service'

function track(overrides: Partial<EmbeddedSubtitleTrack> = {}): EmbeddedSubtitleTrack {
  return { streamIndex: 2, subtitleIndex: 0, codec: 'ass', language: 'chi', title: 'chs&jpn[Haruhana]', default: true, supported: true, ...overrides }
}

const realStructure = `
Input #0, matroska,webm, from 'example.mkv':
  Metadata:
    title           : video title with Subtitle: text
  Stream #0:0: Video: av1 (Main), yuv420p10le, 1920x1080, 23.98 fps (default)
  Stream #0:1: Audio: opus, 48000 Hz, stereo (default)
  Stream #0:2(chi): Subtitle: ass (ssa), start 0.650000 (default)
    Metadata:
      title           : chs&jpn[Haruhana]
  Stream #0:3(chi): Subtitle: ass (ssa)
    Metadata:
      title           : cht&jpn[Haruhana]
  Stream #0:4(chi): Subtitle: ass (ssa)
    Metadata:
      title           : chs&jpn[Nekomoe kissaten]
  Stream #0:5(chi): Subtitle: ass (ssa)
    Metadata:
      title           : cht&jpn[Nekomoe kissaten]
  Stream #0:6(chi): Subtitle: ass (ssa)
    Metadata:
      title           : chs&jpn[KitaujiSub]
  Stream #0:7(chi): Subtitle: ass (ssa)
    Metadata:
      title           : cht&jpn[KitaujiSub]
  Stream #0:8(chi): Subtitle: ass (ssa)
    Metadata:
      title           : chs[Sakurato]
  Stream #0:9(chi): Subtitle: ass (ssa)
    Metadata:
      title           : cht[Sakurato]
  Stream #0:10(chi): Subtitle: subrip (srt)
    Metadata:
      title           : chs[Netflix]
  Stream #0:11(chi): Subtitle: subrip (srt)
    Metadata:
      title           : cht[Netflix]
  Stream #0:12(chi): Subtitle: subrip (srt)
    Metadata:
      title           : cht[Cantonese]
  Stream #0:13(jpn): Subtitle: subrip (srt)
    Metadata:
      title           : jpn[Netflix]
  Stream #0:14: Video: mjpeg, 640x360 (attached pic)
    Metadata:
      filename        : cover.jpg
      mimetype        : image/jpeg
  Stream #0:15: Attachment: none
    Metadata:
      filename        : 方正[0]_subset.ttf
      mimetype        : font/ttf
      title           : imported font for Subtitle: chs
  Stream #0:16: Attachment: none
    Metadata:
      filename        : source-serif.otf
      mimetype        : font/otf
`

describe('内置字幕与字体元数据', () => {
  it('区分全局流索引与字幕相对索引，正确读取默认简日ASS和Netflix SRT', () => {
    const info = parseEmbeddedVideoInfo(realStructure)
    expect(info.tracks).toHaveLength(12)
    expect(info.tracks[0]).toMatchObject(track())
    expect(info.tracks[8]).toMatchObject({ streamIndex: 10, subtitleIndex: 8, codec: 'subrip', title: 'chs[Netflix]', supported: true })
    expect(info.tracks[11]).toMatchObject({ streamIndex: 13, subtitleIndex: 11, language: 'jpn' })
    expect(info.fonts.map(font => font.streamIndex)).toEqual([15, 16])
    expect(info.fonts.some(font => font.filename === 'cover.jpg')).toBe(false)
    expect(chooseEmbeddedSubtitle(info.tracks)?.streamIndex).toBe(2)
  })

  it('支持文字轨格式，将PGS/DVD等图片字幕明确留为不支持', () => {
    const codecs = ['ass', 'ssa', 'subrip', 'srt', 'mov_text', 'text', 'webvtt', 'hdmv_pgs_subtitle', 'dvd_subtitle']
    const info = parseEmbeddedVideoInfo(codecs.map((codec, index) => `  Stream #0:${index + 2}(chi): Subtitle: ${codec}\n    Metadata:\n      title : chs`).join('\n'))
    expect(info.tracks.map(item => item.supported)).toEqual([true, true, true, true, true, true, true, false, false])
    const bitmap = info.tracks.at(-2)!
    expect(chooseEmbeddedSubtitle([bitmap])).toBeUndefined()
    const candidate = embeddedTrackCandidates([bitmap])[0]
    expect(candidate.supported).toBe(false)
    expect(candidate.source).toEqual({ kind: 'embedded', streamIndex: bitmap.streamIndex })
    expect(candidate.reason).toMatch(/不支持|图片|图像/)
  })

  it('大量字体附件不会把封面图计入字体，也不会截断后面的流', () => {
    const prefix = realStructure.slice(0, realStructure.indexOf('  Stream #0:15:'))
    const attachments = Array.from({ length: 58 }, (_, index) => `  Stream #0:${index + 15}: Attachment: none\n    Metadata:\n      filename : font-${index}[0]_subset.ttf\n      mimetype : font/ttf`).join('\n')
    const info = parseEmbeddedVideoInfo(prefix + attachments)
    expect(info.tracks).toHaveLength(12)
    expect(info.fonts).toHaveLength(58)
    expect(info.fonts.at(-1)?.streamIndex).toBe(72)
    expect(info.fonts.some(font => font.streamIndex === 14)).toBe(false)
  })

  it('危险附件名不成为路径，合法Unicode字体和重复原名仍按流身份处理', () => {
    const names = ['../escape.ttf', '..\\escape.ttf', 'C:\\private\\escape.ttf', '/private/escape.otf', 'safe.ttf', 'safe.ttf', '合法字体[0].ttc', 'notes.txt']
    const info = parseEmbeddedVideoInfo(names.map((name, index) => `  Stream #0:${index + 15}: Attachment: none\n    Metadata:\n      filename : ${name}\n      mimetype : font/ttf`).join('\n'))
    expect(info.fonts.map(font => font.streamIndex)).toEqual([19, 20, 21])
    expect(info.fonts.map(font => font.filename)).toEqual(['safe.ttf', 'safe.ttf', '合法字体[0].ttc'])
  })
})

describe('内置轨推荐与提取边界', () => {
  it('优先简体中文与原默认，不让日文默认或招牌forced轨覆盖完整中文对白', () => {
    const simplified = track({ streamIndex: 3, subtitleIndex: 1, default: false })
    const japanese = track({ streamIndex: 2, subtitleIndex: 0, language: 'jpn', title: 'Japanese', default: true })
    const traditional = track({ streamIndex: 4, subtitleIndex: 2, title: 'cht&jpn[Haruhana]', default: true })
    const signs = track({ streamIndex: 5, subtitleIndex: 3, title: 'chs Signs & Songs', forced: true, default: true })
    expect(chooseEmbeddedSubtitle([japanese, signs, traditional, simplified])?.streamIndex).toBe(3)
    expect(chooseEmbeddedSubtitle([signs])).toBeUndefined()
    expect(chooseEmbeddedSubtitle([track({ default: false }), track({ streamIndex: 6, default: true })])?.streamIndex).toBe(6)
    expect(embeddedTrackLabel(simplified)).toMatch(/简体|简日|简中|chs/i)
  })

  it('内置候选携带明确source对象，不能伪装为真实外挂路径', () => {
    const candidates = embeddedTrackCandidates([track(), track({ streamIndex: 3, subtitleIndex: 1, title: 'cht' })])
    expect(candidates).toHaveLength(2)
    expect(candidates[0].path).toBe('')
    expect(candidates[0].source?.kind).toBe('embedded')
    expect(new Set(candidates.map(candidate => candidate.source?.kind === 'embedded' ? candidate.source.streamIndex : null)).size).toBe(2)
    expect(candidates[0].name).toMatch(/ASS|ass/)
  })

  it('安全ASCII提取目标不会随附件原名越界，也不会覆盖重复文件名', () => {
    const temporary = resolve('test-results', 'safe-extraction')
    const fonts = parseEmbeddedVideoInfo('  Stream #0:15: Attachment: none\n    Metadata:\n      filename: 同名.ttf\n  Stream #0:16: Attachment: none\n    Metadata:\n      filename: 同名.ttf').fonts
    const chosen = track({ streamIndex: 10, subtitleIndex: 8, codec: 'subrip', title: 'chs[Netflix]' })
    const extraction = buildEmbeddedExtractionArgs("F:\\目录 [视频],单引号'\\original.mkv", chosen, fonts, temporary)
    expect(extraction.subtitleExtension).toBe('srt')
    expect(extraction.args[extraction.args.indexOf('-map') + 1]).toMatch(/^0:(?:10|s:8)$/)
    expect(extraction.args).not.toContain('0:s:10')
    expect(extraction.args).toContain('-n')
    expect(new Set(extraction.fontTargets.map(font => font.path)).size).toBe(2)
    for (const target of [extraction.rawSubtitlePath, ...extraction.fontTargets.map(font => font.path)]) {
      const child = relative(temporary, target)
      expect(child).not.toBe('')
      expect(child.startsWith('..')).toBe(false)
      expect(isAbsolute(child)).toBe(false)
      expect(child).toMatch(/^[\x00-\x7f]+$/)
    }
  })

  it('图片轨和非整数流索引不能触发文字提取', () => {
    const temporary = resolve('test-results', 'invalid-extraction')
    expect(() => buildEmbeddedExtractionArgs('original.mkv', track({ codec: 'hdmv_pgs_subtitle', supported: false }), [], temporary)).toThrow()
    for (const streamIndex of [-1, 1.5, Number.NaN]) expect(() => buildEmbeddedExtractionArgs('original.mkv', track({ streamIndex }), [], temporary)).toThrow()
  })
})
