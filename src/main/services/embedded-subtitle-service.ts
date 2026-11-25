import { extname, join } from 'node:path'
import type { EmbeddedSubtitleTrack, SubtitleCandidate } from '../../shared/subtitle-api'

export interface EmbeddedFontAttachment {
  streamIndex: number
  extension: '.ttf' | '.otf' | '.ttc'
  filename: string
}

export interface EmbeddedVideoInfo {
  tracks: EmbeddedSubtitleTrack[]
  fonts: EmbeddedFontAttachment[]
}

export interface EmbeddedExtractionPlan {
  args: string[]
  rawSubtitlePath: string
  subtitleExtension: 'ass' | 'srt'
  fontTargets: Array<{ path: string; streamIndex: number }>
}

const SUPPORTED_TEXT_CODECS = new Set(['ass', 'ssa', 'subrip', 'srt', 'mov_text', 'text', 'webvtt'])

/** 字幕和附件元信息位于容器头；字体原名只用于识别格式，绝不作为输出路径。 */
export function parseEmbeddedVideoInfo(stderr: string): EmbeddedVideoInfo {
  const headers = [...stderr.matchAll(/^\s{2}Stream #0:(\d+)(?:\[[^\]\r\n]*\])?(?:\(([^)\r\n]+)\))?:\s*(Video|Audio|Subtitle|Attachment):\s*([^\r\n]*)/gm)]
  const tracks: EmbeddedSubtitleTrack[] = []
  const fonts: EmbeddedFontAttachment[] = []
  const seen = new Set<number>()
  for (let index = 0; index < headers.length; index++) {
    const header = headers[index]
    const streamIndex = Number(header[1])
    if (!Number.isSafeInteger(streamIndex) || streamIndex < 0 || seen.has(streamIndex)) continue
    seen.add(streamIndex)
    const block = stderr.slice(header.index, headers[index + 1]?.index ?? stderr.length)
    const title = /^\s+title\s*:\s*([^\r\n]*)/m.exec(block)?.[1]?.trim()
    if (header[3] === 'Subtitle') {
      const codec = header[4].split(/[\s,(]/)[0].toLowerCase()
      tracks.push({
        streamIndex, subtitleIndex: tracks.length, codec,
        language: header[2]?.trim(), title,
        default: /\(default\)/i.test(header[4]),
        forced: /\(forced\)/i.test(header[4]),
        supported: SUPPORTED_TEXT_CODECS.has(codec)
      })
    } else if (header[3] === 'Attachment') {
      const filename = /^\s+filename\s*:\s*([^\r\n]*)/m.exec(block)?.[1]?.trim() ?? ''
      // 即使名字含目录或盘符也绝不导出，避免把不可信附件名当成路径。
      if (!filename || /[\\/:\u0000]/.test(filename) || filename === '.' || filename === '..') continue
      const extension = extname(filename).toLowerCase()
      if (!['.ttf', '.otf', '.ttc'].includes(extension)) continue
      fonts.push({ streamIndex, filename, extension: extension as EmbeddedFontAttachment['extension'] })
    }
  }
  return { tracks, fonts }
}

function chinese(track: EmbeddedSubtitleTrack): boolean {
  return /^(?:chi|zho|zh|cmn|yue)(?:[-_]|$)/i.test(track.language ?? '')
    || /(?:\bchs\b|\bcht\b|zh[-_ ]?(?:hans|hant|cn|tw)|简体|简中|繁体|繁中|中文)/i.test(track.title ?? '')
}

function simplified(track: EmbeddedSubtitleTrack): boolean {
  return /(?:\bchs\b|zh[-_ ]?(?:hans|cn)|简体|简中)/i.test(`${track.language ?? ''} ${track.title ?? ''}`)
}

function signsOnly(track: EmbeddedSubtitleTrack): boolean {
  return Boolean(track.forced) || /\b(?:signs?|songs?|forced)\b|仅(?:招牌|标识|歌词)|招牌字幕|歌词字幕/i.test(track.title ?? '')
}

/** 同视频内优先中文及简体默认轨，不能把强制招牌轨当成完整对白。 */
export function chooseEmbeddedSubtitle(tracks: EmbeddedSubtitleTrack[]): EmbeddedSubtitleTrack | undefined {
  return tracks.filter((track) => track.supported && !signsOnly(track)).sort((left, right) => {
    const score = (track: EmbeddedSubtitleTrack): number => (chinese(track) ? 100 : 0) + (simplified(track) ? 30 : 0) + (track.default ? 10 : 0)
    return score(right) - score(left) || left.streamIndex - right.streamIndex
  })[0]
}

export function isChineseEmbeddedSubtitle(track: EmbeddedSubtitleTrack): boolean { return chinese(track) }

/** 轨名直接说明语言/标题/格式，用户不用理解 FFmpeg 流索引。 */
export function embeddedTrackLabel(track: EmbeddedSubtitleTrack): string {
  const language = /^(chi|zho|zh|cmn)/i.test(track.language ?? '') ? '中文'
    : /^(jpn|ja)/i.test(track.language ?? '') ? '日语'
      : /^(eng|en)/i.test(track.language ?? '') ? '英语' : track.language || '未标注语言'
  const format = track.codec === 'subrip' ? 'SRT' : track.codec.toUpperCase()
  return `内置 · ${track.title || language} · ${format}${track.default ? ' · 默认' : ''}${track.forced ? ' · 强制轨' : ''}${track.supported ? '' : ' · 暂不支持烧录'}`
}

export function embeddedTrackCandidates(tracks: EmbeddedSubtitleTrack[]): SubtitleCandidate[] {
  return tracks.map((track) => ({
    path: '', source: { kind: 'embedded' as const, streamIndex: track.streamIndex },
    name: embeddedTrackLabel(track), score: 100,
    confidence: track.supported && chinese(track) && !signsOnly(track) ? 'high' as const : 'medium' as const,
    reason: track.supported ? '视频内部的字幕轨，烧录时自动提取字幕和字体' : '图片或不支持的字幕格式；请选择其他文本轨或外挂字幕',
    supported: track.supported
  }))
}

/** 固定 ASCII 原始字幕/字体名；只导出指定文本轨与已验证字体附件，不复制源视频。 */
export function buildEmbeddedExtractionArgs(video: string, track: EmbeddedSubtitleTrack, fonts: EmbeddedFontAttachment[], temporaryDirectory: string): EmbeddedExtractionPlan {
  if (!track.supported || !SUPPORTED_TEXT_CODECS.has(track.codec) || !Number.isSafeInteger(track.streamIndex) || track.streamIndex < 0) throw new Error('所选内置字幕不支持烧录，请选择 ASS / SRT 文本轨')
  const styled = track.codec === 'ass' || track.codec === 'ssa'
  const subtitleExtension = styled ? 'ass' : 'srt'
  const rawSubtitlePath = join(temporaryDirectory, `embedded-subtitle.${subtitleExtension}`)
  const fontTargets: EmbeddedExtractionPlan['fontTargets'] = []
  const args = ['-hide_banner', '-nostdin', '-v', 'error']
  const seen = new Set<number>()
  for (const font of fonts) {
    if (!Number.isSafeInteger(font.streamIndex) || font.streamIndex < 0 || seen.has(font.streamIndex) || !['.ttf', '.otf', '.ttc'].includes(font.extension)) continue
    seen.add(font.streamIndex)
    const target = join(temporaryDirectory, 'fonts', `embedded-font-${font.streamIndex}${font.extension}`)
    fontTargets.push({ path: target, streamIndex: font.streamIndex })
    args.push(`-dump_attachment:${font.streamIndex}`, target)
  }
  args.push('-i', video, '-map', `0:${track.streamIndex}`, '-vn', '-an', '-c:s', styled ? 'copy' : 'srt', '-f', subtitleExtension, '-n', rawSubtitlePath)
  return { args, rawSubtitlePath, subtitleExtension, fontTargets }
}
