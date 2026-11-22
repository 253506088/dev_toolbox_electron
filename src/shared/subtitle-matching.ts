import type { SubtitleCandidate, SubtitleConfidence, SubtitleMatchRow } from './subtitle-api'

interface ParsedName {
  path: string
  name: string
  title: string
  tokens: string[]
  tokenSet: Set<string>
  grams: Set<string>
  episode?: number
  episodeRange?: [number, number]
  season?: number
  year?: number
  languagePreference: number
}

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
const noiseTokens = new Set([
  'web', 'dl', 'webdl', 'webrip', 'bluray', 'bdrip', 'brrip', 'hdtv', 'dvdrip', 'remux', 'uhd',
  'hevc', 'avc', 'h264', 'h265', 'x264', 'x265', 'av1', 'hdr', 'hdr10', 'dv', 'sdr', 'aac', 'ac3',
  'eac3', 'dts', 'ddp', 'dd', 'truehd', 'atmos', 'flac', 'opus', 'mp3', '10bit', '8bit', 'hi10p',
  'proper', 'repack', 'limited', 'internal', 'complete', 'multi', 'dual', 'audio', 'sub', 'subs', 'hd', 'ma',
  'subtitle', 'subtitles', 'chs', 'cht', 'sc', 'tc', 'zh', 'zho', 'chi', 'cn', 'zhcn', 'zhtw',
  'eng', 'en', 'english', 'jpn', 'ja', 'japanese', 'kor', 'ko', 'gb', 'big5', 'utf8', '简体', '繁体',
  '简中', '繁中', '中文', '中英', '双语', '简繁', '字幕', '特效', '精校', '修订', '外挂', '内封', '内嵌'
])

/** 从 Windows 或 POSIX 路径读取文件名，保持该算法可在渲染进程和测试中独立使用。 */
function fileName(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() ?? path
}

/** 解析中文集数及季数，覆盖零、两、十和百的常见写法。 */
function chineseNumber(text: string): number | undefined {
  if (/^\d+$/.test(text)) return Number(text)
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  let result = 0
  let current = 0
  for (const char of text) {
    if (char === '十' || char === '百') {
      result += (current || 1) * (char === '十' ? 10 : 100)
      current = 0
    } else if (char in digits) current = current * 10 + digits[char]
    else return undefined
  }
  const number = result + current
  return number > 0 && number <= 999 ? number : undefined
}

function validEpisode(value: string): number | undefined {
  const number = Number(value)
  return number > 0 && number <= 999 ? number : undefined
}

function characterGrams(text: string): Set<string> {
  return new Set(text.length < 2 ? [text] : Array.from({ length: text.length - 1 }, (_, index) => text.slice(index, index + 2)))
}

/** 先识别明确季集标记，再从排除发行参数后的名称中识别独立集数。 */
function parseName(path: string): ParsedName {
  const name = fileName(path)
  let title = name.replace(/\.[^.]+$/, '').normalize('NFKC').toLowerCase()
  const original = title
  let season: number | undefined
  let episode: number | undefined
  let episodeRange: [number, number] | undefined
  const range = /(?:^|[^a-z0-9])(?:s\d{1,2}[ ._-]*)?(?:episode[ ._-]*|ep[ ._-]*|e)(\d{1,3})[ ._]*(?:e|-)[ ._-]*e?(\d{1,3})(?=$|[^0-9])/i.exec(title)
    ?? /(?:^|[^a-z0-9])\d{1,2}x(\d{1,3})[ ._]*-[ ._-]*(\d{1,3})(?=$|[^0-9])/i.exec(title)
  if (range && validEpisode(range[1]) !== undefined && validEpisode(range[2]) !== undefined && Number(range[2]) > Number(range[1])) {
    episodeRange = [Number(range[1]), Number(range[2])]
  }
  const seasonEpisode = /(?:^|[^a-z0-9])s(\d{1,2})[ ._-]*e(\d{1,3})(?=$|[^0-9])/i.exec(title)
    ?? /(?:^|[^a-z0-9])(\d{1,2})x(\d{1,3})(?=$|[^0-9])/i.exec(title)
  if (seasonEpisode) {
    season = Number(seasonEpisode[1])
    episode = validEpisode(seasonEpisode[2])
    title = title.replace(seasonEpisode[0], ' ')
  }
  const chineseSeason = /第?([零〇一二两三四五六七八九十百\d]+)季/.exec(title)
  if (chineseSeason) {
    season ??= chineseNumber(chineseSeason[1])
    title = title.replace(chineseSeason[0], ' ')
  }
  const latinSeason = /(?:^|[^a-z0-9])(?:season[ ._-]*|s)(\d{1,2})(?=$|[^a-z0-9])/.exec(title)
  if (latinSeason) {
    season ??= Number(latinSeason[1])
    title = title.replace(latinSeason[0], ' ')
  }
  const chineseEpisode = /第([零〇一二两三四五六七八九十百\d]+)[集话話回]/.exec(title)
  if (chineseEpisode) {
    episode ??= chineseNumber(chineseEpisode[1])
    title = title.replace(chineseEpisode[0], ' ')
  }
  const latinEpisode = /(?:^|[^a-z0-9])(?:episode[ ._-]*|ep[ ._-]*|e)(\d{1,3})(?=$|[^0-9])/.exec(title)
  if (latinEpisode) {
    episode ??= validEpisode(latinEpisode[1])
    title = title.replace(latinEpisode[0], ' ')
  }
  const bracketEpisode = /[[【(](\d{1,3})[\]】)]/.exec(title)
  if (bracketEpisode) {
    episode ??= validEpisode(bracketEpisode[1])
    title = title.replace(bracketEpisode[0], ' ')
  }

  const yearMatch = /(?:^|\D)((?:19|20)\d{2})(?=$|\D)/.exec(title)
  const year = yearMatch ? Number(yearMatch[1]) : undefined
  // 先去掉尺寸、编码、音频声道、校验码，以免把 264、10、5 等误当集数。
  title = title
    .replace(/\b(?:\d{3,4}[pi]|[248]k|\d{3,4}x\d{3,4}|[xh][ ._-]?26[45]|hdr10\+?|\d{1,2}bit|(?:aac|ddp?|dts|eac3|ac3)[ ._-]*\d(?:\.\d)?|\d\.\d(?:ch)?)\b/gi, ' ')
    .replace(/[[【(][a-f0-9]{8}[\]】)]/gi, ' ')
    .replace(/\b(?:19|20)\d{2}\b/g, ' ')
  const numericEpisodes = [...title.matchAll(/(?:^|[ ._\-\[\]()])0*(\d{1,3})(?=$|[ ._\-\[\]()])/g)]
    .filter((match) => validEpisode(match[1]) !== undefined)
  const numericEpisode = numericEpisodes.at(-1)
  if (numericEpisode) {
    episode ??= validEpisode(numericEpisode[1])
    title = title.replace(numericEpisode[0], ' ')
  }

  // 括号中的来源标签不会影响标题；含中文的标题括号仍保留。
  title = title.replace(/[[【(]([^\]】)]+)[\]】)]/g, (_all, inside: string) => {
    if (/[㐀-鿿]/.test(inside) && !/(?:字幕组|字幕組|压制|壓制|简体|繁体|双语|雙語|中英|简中|繁中)/.test(inside)) return ` ${inside} `
    return ' '
  })
  title = title
    .replace(/(?:简体中文|繁体中文|简体中字|繁体中字|中英双语|中英雙語|简繁双语|简繁|简体|繁体|简中|繁中|双语|雙語|中文字幕|中英字幕|中字|特效字幕|字幕组|字幕組)/g, ' ')
    .replace(/\b(?:zh[ ._-]*(?:cn|tw|hans|hant)|web[ ._-]*dl|blu[ ._-]*ray|h[ ._-]*26[45])\b/g, ' ')
  const tokens = title.split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token && !noiseTokens.has(token) && !/^\d+$/.test(token) && !/^[a-f0-9]{8}$/.test(token))
  const languagePreference = /(?:chs|zh[ ._-]?(?:cn|hans)|简体|简中|中英|双语|雙語)/i.test(original) ? 3
    : /(?:cht|zh[ ._-]?(?:tw|hant)|繁体|繁中)/i.test(original) ? 2
      : /(?:中文|中字|(?:^|[ ._-])(?:chi|zho|zh)(?:$|[ ._-]))/i.test(original) ? 1 : 0
  const normalizedTitle = tokens.join('')
  return { path, name, title: normalizedTitle, tokens, tokenSet: new Set(tokens), grams: characterGrams(normalizedTitle), episode, episodeRange, season, year, languagePreference }
}

/** 词组重合与字符二元组同时比较，适应中英文混合标题及不同来源的命名。 */
function titleSimilarity(left: ParsedName, right: ParsedName): number {
  if (!left.title || !right.title) return 0
  if (left.title === right.title) return 1
  const leftTokens = left.tokenSet
  const rightTokens = right.tokenSet
  let commonTokens = 0
  const smallTokens = leftTokens.size <= rightTokens.size ? leftTokens : rightTokens
  const largeTokens = smallTokens === leftTokens ? rightTokens : leftTokens
  for (const token of smallTokens) if (largeTokens.has(token)) commonTokens += 1
  const tokenCoverage = commonTokens / Math.max(1, Math.min(leftTokens.size, rightTokens.size))
  const leftGrams = left.grams
  const rightGrams = right.grams
  let commonGrams = 0
  const smallGrams = leftGrams.size <= rightGrams.size ? leftGrams : rightGrams
  const largeGrams = smallGrams === leftGrams ? rightGrams : leftGrams
  for (const gram of smallGrams) if (largeGrams.has(gram)) commonGrams += 1
  const dice = 2 * commonGrams / (leftGrams.size + rightGrams.size)
  const containment = left.title.length >= 3 && right.title.length >= 3 && (left.title.includes(right.title) || right.title.includes(left.title)) ? .9 : 0
  // 单个英文常用词不足以证明标题相同，至少需要两个词或较高字符相似度。
  const words = commonTokens >= 2 || Math.min(leftTokens.size, rightTokens.size) === 1 && Math.min(left.title.length, right.title.length) >= 4 ? tokenCoverage * .9 : tokenCoverage * .35
  return Math.max(dice, words, containment)
}

function confidence(score: number): SubtitleConfidence {
  return score >= 88 ? 'high' : score >= 65 ? 'medium' : 'low'
}

function scoreCandidate(video: ParsedName, subtitle: ParsedName, singlePair: boolean): SubtitleCandidate | null {
  if (video.season !== undefined && subtitle.season !== undefined && video.season !== subtitle.season) return null
  if (video.episode !== undefined && subtitle.episode !== undefined && video.episode !== subtitle.episode) return null
  if (video.episodeRange || subtitle.episodeRange) {
    if (!video.episodeRange || !subtitle.episodeRange || video.episodeRange[0] !== subtitle.episodeRange[0] || video.episodeRange[1] !== subtitle.episodeRange[1]) return null
  }
  const similarity = titleSimilarity(video, subtitle)
  const sameEpisode = video.episode !== undefined && video.episode === subtitle.episode
  const sameSeason = video.season !== undefined && video.season === subtitle.season
  const sameTitle = similarity >= .9
  let score: number
  let reason: string
  if (sameEpisode) {
    score = 73 + similarity * 20 + (sameSeason ? 5 : 0)
    reason = `${sameSeason ? '季数、' : ''}集数一致${similarity >= .55 ? '，名称相似' : '，名称差异较大，请核对'}`
  } else if (similarity >= .5) {
    score = 48 + similarity * 46
    if (video.episode !== undefined || subtitle.episode !== undefined) score -= 15
    if (video.year !== undefined && subtitle.year !== undefined && video.year !== subtitle.year) score -= 35
    reason = sameTitle ? '名称一致' : '名称相似'
    if (video.episode !== undefined || subtitle.episode !== undefined) reason += '，一侧缺少集数'
    if (video.year !== undefined && subtitle.year !== undefined && video.year !== subtitle.year) reason += '，年份不同，请核对'
  } else if (singlePair) {
    score = 25
    reason = '目录中仅有这一份字幕，名称不相似，请手动确认'
  } else return null
  const rounded = Math.min(100, Math.round(score))
  return { path: subtitle.path, name: subtitle.name, score: rounded, confidence: confidence(rounded), reason }
}

function episodeLabel(video: ParsedName): string | undefined {
  if (video.episode === undefined) return video.season === undefined ? undefined : `S${String(video.season).padStart(2, '0')}`
  return `${video.season === undefined ? '' : `S${String(video.season).padStart(2, '0')}`}E${String(video.episode).padStart(2, '0')}${video.episodeRange ? `–E${String(video.episodeRange[1]).padStart(2, '0')}` : ''}`
}

/**
 * 以季集冲突为硬约束，按集数、名称与中文语言偏好推荐同目录外挂字幕。
 * 不读取文件，不修改输入；无法合理判断时保留候选但不自动选中。
 */
export function matchSubtitles(videoPaths: string[], subtitlePaths: string[]): SubtitleMatchRow[] {
  const videos = [...new Set(videoPaths)].map(parseName).sort((left, right) => collator.compare(left.name, right.name) || left.path.localeCompare(right.path))
  const subtitles = [...new Set(subtitlePaths)].map(parseName)
  const parsedByPath = new Map(subtitles.map((subtitle) => [subtitle.path, subtitle]))
  const byEpisode = new Map<number, ParsedName[]>()
  const withoutEpisode: ParsedName[] = []
  for (const subtitle of subtitles) {
    if (subtitle.episode === undefined) withoutEpisode.push(subtitle)
    else {
      const group = byEpisode.get(subtitle.episode) ?? []
      group.push(subtitle)
      byEpisode.set(subtitle.episode, group)
    }
  }
  const singlePair = videos.length === 1 && subtitles.length === 1
  const rows = videos.map((video, index): SubtitleMatchRow => {
    const pool = video.episode === undefined ? subtitles : [...(byEpisode.get(video.episode) ?? []), ...withoutEpisode]
    const candidates = pool.map((subtitle) => scoreCandidate(video, subtitle, singlePair))
      .filter((candidate): candidate is SubtitleCandidate => candidate !== null)
      .sort((left, right) => right.score - left.score
        || (parsedByPath.get(right.path)?.languagePreference ?? 0) - (parsedByPath.get(left.path)?.languagePreference ?? 0)
        || collator.compare(left.name, right.name) || left.path.localeCompare(right.path))
      .slice(0, 12)
    const best = candidates[0]
    const second = candidates[1]
    // 相同标题的语言版本可明确优选；不同标题的近分候选需要提醒。
    const ambiguous = best && second && best.score - second.score <= 4
      && titleSimilarity(parsedByPath.get(best.path)!, parsedByPath.get(second.path)!) < .8
    if (best && ambiguous) {
      best.confidence = 'low'
      best.reason += '；存在相近候选，请确认'
    }
    const selected = best && best.score >= 65 ? best : undefined
    return {
      id: `subtitle-row-${index + 1}`,
      videoPath: video.path,
      videoName: video.name,
      episode: episodeLabel(video),
      subtitlePath: selected?.path ?? null,
      candidates,
      confidence: selected?.confidence ?? null,
      reason: selected?.reason ?? (best ? '未找到足够可靠的匹配，可手动选择候选字幕' : '未找到匹配字幕，可手动指定')
    }
  })

  // 名称匹配造成同一字幕被多个视频认领时，优先保留明确对应者。
  const claims = new Map<string, SubtitleMatchRow[]>()
  for (const row of rows) {
    if (!row.subtitlePath) continue
    const peers = claims.get(row.subtitlePath) ?? []
    peers.push(row)
    claims.set(row.subtitlePath, peers)
  }
  for (const peers of claims.values()) {
    if (peers.length < 2) continue
    peers.sort((left, right) => (right.candidates[0]?.score ?? 0) - (left.candidates[0]?.score ?? 0))
    for (const row of peers.slice(1)) {
      row.confidence = 'low'
      row.reason += '；此字幕也匹配了其他视频，请核对'
      const unclaimed = row.candidates.find((candidate) => candidate.score >= 65 && !claims.has(candidate.path))
      if (unclaimed) {
        row.subtitlePath = unclaimed.path
        row.confidence = unclaimed.confidence
        row.reason = unclaimed.reason
        claims.set(unclaimed.path, [row])
      }
    }
  }
  return rows
}
