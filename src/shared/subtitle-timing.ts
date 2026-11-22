/** 平移临时字幕的时间轴，不改变视频时间戳；跨零的字幕裁切，零前结束的字幕丢弃。 */
export function shiftSubtitleTimestamps(text: string, format: string, offsetSeconds: number): string {
  const offset = Math.round(offsetSeconds * 1000)
  let retained = 0
  let result: string
  if (format.toLowerCase() === 'ass' || format.toLowerCase() === 'ssa') {
    let inEvents = false
    let startIndex = 1
    let endIndex = 2
    result = text.split(/\r?\n/).flatMap((line): string[] => {
      const section = /^\s*\[([^\]]+)\]/.exec(line)
      if (section) inEvents = section[1].toLowerCase() === 'events'
      if (!inEvents) return [line]
      const columns = /^\s*Format:\s*(.*)$/i.exec(line)
      if (columns) {
        const names = columns[1].split(',').map((name) => name.trim().toLowerCase())
        startIndex = names.indexOf('start')
        endIndex = names.indexOf('end')
        return [line]
      }
      const event = /^(\s*Dialogue:\s*)(.*)$/i.exec(line)
      if (!event || startIndex < 0 || endIndex < 0) return [line]
      const fields = event[2].split(',')
      const start = parseTime(fields[startIndex]?.trim() ?? '')
      const end = parseTime(fields[endIndex]?.trim() ?? '')
      if (start === null || end === null) return [line]
      const shiftedStart = Math.max(0, start + offset)
      const shiftedEnd = end + offset
      if (shiftedEnd <= shiftedStart) return []
      fields[startIndex] = formatTime(shiftedStart, 'ass')
      fields[endIndex] = formatTime(shiftedEnd, 'ass')
      retained++
      return [`${event[1]}${fields.join(',')}`]
    }).join('\n')
  } else {
    const timing = /^([ \t]*)((?:\d+:)?\d{2}:\d{2}[.,]\d{1,3})[ \t]+-->[ \t]+((?:\d+:)?\d{2}:\d{2}[.,]\d{1,3})([^\r\n]*)$/m
    result = text.split(/\r?\n[ \t]*\r?\n/).flatMap((block): string[] => {
      const match = timing.exec(block)
      if (!match) return [block]
      const start = parseTime(match[2])
      const end = parseTime(match[3])
      if (start === null || end === null) return [block]
      const shiftedStart = Math.max(0, start + offset)
      const shiftedEnd = end + offset
      if (shiftedEnd <= shiftedStart) return []
      retained++
      const kind = format.toLowerCase() === 'vtt' ? 'vtt' : 'srt'
      return [block.replace(timing, `${match[1]}${formatTime(shiftedStart, kind)} --> ${formatTime(shiftedEnd, kind)}${match[4]}`)]
    }).join('\n\n')
  }
  if (retained === 0) throw new Error('字幕中没有可用的时间段；请检查字幕内容和时间偏移')
  return result
}

function parseTime(value: string): number | null {
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(value)
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) return null
  return (Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000 + Number(match[4].padEnd(3, '0'))
}

function formatTime(milliseconds: number, kind: 'ass' | 'srt' | 'vtt'): string {
  const rounded = kind === 'ass' ? Math.round(milliseconds / 10) * 10 : Math.round(milliseconds)
  const hours = Math.floor(rounded / 3600000)
  const minutes = Math.floor(rounded / 60000) % 60
  const seconds = Math.floor(rounded / 1000) % 60
  const fraction = rounded % 1000
  return `${kind === 'ass' ? hours : String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${kind === 'srt' ? ',' : '.'}${kind === 'ass' ? String(Math.floor(fraction / 10)).padStart(2, '0') : String(fraction).padStart(3, '0')}`
}
