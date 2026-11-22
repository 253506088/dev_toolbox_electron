import { describe, expect, it } from 'vitest'
import { matchSubtitles } from '../src/shared/subtitle-matching'

describe('外挂字幕智能匹配', () => {
  it('不同发行来源按季集数匹配，并按集数自然排序', () => {
    const rows = matchSubtitles(
      ['D:\\剧集\\Show.S01E10.1080p.WEB-DL.x265-GROUP.mkv', 'D:\\剧集\\Show.S01E02.2160p.BluRay.x264.mkv'],
      ['D:\\剧集\\剧名.Show.1x02.简体.ass', 'D:\\剧集\\Show.S01E10.chs.srt', 'D:\\剧集\\Show.S02E02.chs.srt']
    )
    expect(rows.map((row) => row.episode)).toEqual(['S01E02', 'S01E10'])
    expect(rows[0].subtitlePath).toContain('1x02')
    expect(rows[0].confidence).toBe('high')
    expect(rows[0].candidates.some((candidate) => candidate.name.includes('S02E02'))).toBe(false)
    expect(rows[1].subtitlePath).toContain('S01E10')
  })

  it('支持中文数字季数和集数，以及没有季数的 EP 标记', () => {
    const rows = matchSubtitles(['/shows/长安第二季第十二集.mkv'], ['/shows/长安.S02E12.ass', '/shows/长安.EP12.chs.srt', '/shows/长安.S01E12.ass'])
    expect(rows[0].episode).toBe('S02E12')
    expect(rows[0].subtitlePath).toContain('S02E12')
    expect(rows[0].candidates.map((candidate) => candidate.name)).toContain('长安.EP12.chs.srt')
    expect(rows[0].candidates.map((candidate) => candidate.name)).not.toContain('长安.S01E12.ass')
  })

  it('识别百集中文写法和全角数字', () => {
    expect(matchSubtitles(['剧名.第三季.第一百零二集.mp4'], ['剧名.S03E102.srt'])[0].episode).toBe('S03E102')
    expect(matchSubtitles(['剧名.第０２集.mp4'], ['剧名.E02.srt'])[0].subtitlePath).toBe('剧名.E02.srt')
  })

  it('支持方括号和独立数字集数，忽略年份、分辨率及 CRC', () => {
    const rows = matchSubtitles(
      ['[VCB-Studio] 动画名称 [02] [1080p] [x265] [A1B2C3D4].mkv', '动画名称.2024.03.1080p.10bit.AAC.5.1.mkv'],
      ['动画名称.E02.chs.ass', '动画名称.E03.chs.ass', '动画名称.E10.chs.ass']
    )
    expect(rows.find((row) => row.videoName.includes('[02]'))?.episode).toBe('E02')
    expect(rows.find((row) => row.videoName.includes('.03.'))?.episode).toBe('E03')
    expect(rows.every((row) => row.subtitlePath !== null)).toBe(true)
  })

  it('不会将视频编码、年份、声道、分辨率误识别成集数', () => {
    const row = matchSubtitles(['Movie.2024.1080p.H.264.10bit.AAC.5.1.mkv'], ['Movie.2024.chs.srt'])[0]
    expect(row.episode).toBeUndefined()
    expect(row.subtitlePath).toBe('Movie.2024.chs.srt')
  })

  it('单独裸数字的字幕可以匹配对应集数', () => {
    const rows = matchSubtitles(['Series.S01E01.mp4', 'Series.S01E02.mp4'], ['01.ass', '02.ass'])
    expect(rows.map((row) => row.subtitlePath)).toEqual(['01.ass', '02.ass'])
    expect(rows.every((row) => row.confidence === 'medium')).toBe(true)
  })

  it('即使名称高度相似也排除错误集数', () => {
    const row = matchSubtitles(['Show.E02.mkv'], ['Show.E01.srt'])[0]
    expect(row.subtitlePath).toBeNull()
    expect(row.candidates).toEqual([])
  })

  it('续集电影的数字不同不会因相同标题而错配', () => {
    const row = matchSubtitles(['Toy.Story.2.2010.1080p.mkv'], ['Toy.Story.3.2010.chs.srt'])[0]
    expect(row.subtitlePath).toBeNull()
    expect(row.candidates).toEqual([])
  })

  it('含数字的作品标题后还有独立集数时，优先最后的集数', () => {
    const row = matchSubtitles(['86.Eighty.Six.02.1080p.mkv'], ['86.Eighty.Six.E02.chs.srt'])[0]
    expect(row.episode).toBe('E02')
    expect(row.subtitlePath).toContain('E02')
  })

  it('合并多集的视频不能误匹配其中一集的字幕，相同范围可以匹配', () => {
    const row = matchSubtitles(['Show.S01E01E02.mkv'], ['Show.S01E01.srt', 'Show.S01E02.srt', 'Show.S01E01-E02.chs.srt'])[0]
    expect(row.episode).toBe('S01E01–E02')
    expect(row.subtitlePath).toBe('Show.S01E01-E02.chs.srt')
    expect(row.candidates).toHaveLength(1)
    expect(matchSubtitles(['Show.E01-02.mkv'], ['Show.E01.srt'])[0].subtitlePath).toBeNull()
  })

  it('不同年份的同名电影保留低置信候选，避免直接匹配翻拍版本', () => {
    const row = matchSubtitles(['Movie.1980.1080p.mkv'], ['Movie.2024.chs.srt'])[0]
    expect(row.subtitlePath).toBeNull()
    expect(row.candidates[0].reason).toContain('年份不同')
  })

  it('电影混合中英文、发行信息和字幕语言后仍能识别名称', () => {
    const row = matchSubtitles(['The.Interstellar.2014.2160p.BluRay.HEVC.DTS.mkv'], ['星际穿越.The.Interstellar.2014.中英双语.ass', 'Another.Movie.2014.srt'])[0]
    expect(row.subtitlePath).toContain('星际穿越')
    expect(row.confidence).toBe('high')
  })

  it('同名字幕确定性优先简体中文，并保留语言候选', () => {
    const videos = ['剧名.S01E01.mkv']
    const subtitles = ['剧名.S01E01.eng.srt', '剧名.S01E01.cht.ass', '剧名.S01E01.chs.ass']
    const first = matchSubtitles(videos, subtitles)[0]
    const reverse = matchSubtitles(videos, [...subtitles].reverse())[0]
    expect(first.subtitlePath).toBe('剧名.S01E01.chs.ass')
    expect(reverse.subtitlePath).toBe(first.subtitlePath)
    expect(first.candidates).toHaveLength(3)
    expect(first.confidence).toBe('high')
  })

  it('相同集数但标题不同的相近候选会标记为低置信度', () => {
    const row = matchSubtitles(['未知剧集.E01.mp4'], ['不同作品.E01.srt', '另一作品.E01.srt'])[0]
    expect(row.subtitlePath).not.toBeNull()
    expect(row.confidence).toBe('low')
    expect(row.reason).toContain('存在相近候选')
  })

  it('无关电影不会自动匹配，单视频单字幕保留手动确认候选', () => {
    const row = matchSubtitles(['Interstellar.mp4'], ['Toy.Story.srt'])[0]
    expect(row.subtitlePath).toBeNull()
    expect(row.candidates[0].confidence).toBe('low')
    const rows = matchSubtitles(['Interstellar.mp4', 'Arrival.mp4'], ['Toy.Story.srt', 'Cars.srt'])
    expect(rows.every((item) => item.subtitlePath === null && item.candidates.length === 0)).toBe(true)
  })

  it('没有字幕、没有视频或重复输入均能稳定处理', () => {
    expect(matchSubtitles([], ['test.srt'])).toEqual([])
    expect(matchSubtitles(['test.mp4'], [])[0].subtitlePath).toBeNull()
    expect(matchSubtitles(['test.mp4', 'test.mp4'], ['test.srt', 'test.srt'])).toHaveLength(1)
  })

  it('同一字幕被多个视频推荐时提示重复，并优先分配可用替代字幕', () => {
    const rows = matchSubtitles(['Show.E01.1080p.mp4', 'Show.E01.720p.mp4'], ['Show.E01.chs.srt', 'Show.E01.cht.srt'])
    expect(new Set(rows.map((row) => row.subtitlePath)).size).toBe(2)
    const withoutAlternative = matchSubtitles(['Show.E01.1080p.mp4', 'Show.E01.720p.mp4'], ['Show.E01.srt'])
    expect(withoutAlternative.filter((row) => row.reason.includes('其他视频'))).toHaveLength(1)
  })

  it('不修改传入路径数组，候选评分始终在 0 到 100 内', () => {
    const videos = ['Show.E10.mkv', 'Show.E02.mkv']
    const subtitles = ['Show.E02.chs.srt', 'Show.E10.chs.srt']
    const original = [...videos]
    const rows = matchSubtitles(videos, subtitles)
    expect(videos).toEqual(original)
    expect(rows.flatMap((row) => row.candidates).every((candidate) => candidate.score >= 0 && candidate.score <= 100)).toBe(true)
  })

  it('大批量跨来源剧集仍逐集匹配，不串集', () => {
    const videos = Array.from({ length: 500 }, (_, index) => `剧集.E${index + 1}.1080p.WEB-DL.mkv`)
    const subtitles = [...videos].reverse().map((name) => name.replace('1080p.WEB-DL.mkv', 'chs.ass'))
    const rows = matchSubtitles(videos, subtitles)
    expect(rows).toHaveLength(500)
    expect(rows.every((row) => row.candidates.length === 1 && row.subtitlePath === row.videoName.replace('1080p.WEB-DL.mkv', 'chs.ass'))).toBe(true)
  })
})
