<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { Ban, CheckCheck, ChevronRight, CircleCheck, FileVideo, FolderOpen, ListChecks, Play, RefreshCw, RotateCcw, Search, ShieldCheck, Subtitles, Upload } from '@lucide/vue'
import { NButton, NCheckbox, NIcon, NInput, NInputNumber, NPagination, NProgress, NSelect, NTag, NTooltip, useMessage } from 'naive-ui'
import type { FfmpegStatus } from '@shared/media-api'
import type { EmbeddedSubtitleTrack, SubtitleAcceleration, SubtitleBatchItem, SubtitleBatchSnapshot, SubtitleCandidate, SubtitleConfidence, SubtitleEmbedMode, SubtitleEncoding, SubtitleHardwareStatus, SubtitleInputSource, SubtitleMatchRow, SubtitleOutputFormat, SubtitleProcessingPhase, SubtitleResolution, SubtitleScanProgress, SubtitleScanResult } from '@shared/subtitle-api'
import ToolPage from '../components/ToolPage.vue'

const message = useMessage()
const scan = ref<SubtitleScanResult | null>(null)
const selectedIds = ref(new Set<string>())
const batch = ref<SubtitleBatchSnapshot | null>(null)
const loading = ref(false)
const starting = ref(false)
const cancelling = ref(false)
const dragging = ref(false)
const errorText = ref('')
const search = ref('')
const filter = ref('all')
const page = ref(1)
const embedMode = ref<SubtitleEmbedMode>('burn')
const format = ref<SubtitleOutputFormat>('mp4')
const acceleration = ref<SubtitleAcceleration>('auto')
const resolution = ref<SubtitleResolution>('source')
const encoding = ref<SubtitleEncoding>('auto')
const offsetSeconds = ref<number | null>(0)
const ffmpeg = ref<FfmpegStatus>({ available: false, message: '正在检测 FFmpeg…' })
const checkingFfmpeg = ref(true)
const hardware = ref<SubtitleHardwareStatus | null>(null)
const hardwareError = ref('')
const checkingHardware = ref(true)
const manualLoading = ref('')
const scanProgress = ref<SubtitleScanProgress | null>(null)
const bufferedEvents = new Map<string, SubtitleBatchSnapshot>()
const notifiedBatches = new Set<string>()
let unsubscribe: (() => void) | undefined
let unsubscribeScan: (() => void) | undefined
let eventRevision = 0
let dragDepth = 0
const PAGE_SIZE = 20

const running = computed(() => starting.value || batch.value?.status === 'running')
const busy = computed(() => running.value || loading.value || Boolean(manualLoading.value))
const rows = computed(() => scan.value?.rows ?? [])
const selectedRows = computed(() => rows.value.filter((row) => selectedIds.value.has(row.id)))
const readyRows = computed(() => selectedRows.value.filter(canProcessRow))
const unmatchedCount = computed(() => selectedRows.value.filter((row) => !row.scanError && !hasSupportedSubtitle(row)).length)
const scanErrorCount = computed(() => selectedRows.value.filter((row) => Boolean(row.scanError)).length)
const embeddedSoftRows = computed(() => embedMode.value === 'soft' ? selectedRows.value.filter((row) => hasSupportedSubtitle(row) && selectedSource(row)?.kind === 'embedded') : [])
const embeddedCount = computed(() => scan.value?.embeddedSubtitleCount ?? rows.value.reduce((count, row) => count + (row.embeddedTracks?.length ?? 0), 0))
const reviewCount = computed(() => readyRows.value.filter((row) => row.confidence !== 'high').length)
const allSelected = computed(() => rows.value.length > 0 && selectedRows.value.length === rows.value.length)
const partialSelected = computed(() => selectedRows.value.length > 0 && !allSelected.value)
const filteredRows = computed(() => {
  const query = search.value.trim().toLocaleLowerCase()
  return rows.value.filter((row) => {
    if (query && !`${row.videoName} ${selectedSubtitleLabel(row)} ${row.candidates.map((candidate) => candidateDisplayName(candidate, row)).join(' ')} ${row.episode ?? ''}`.toLocaleLowerCase().includes(query)) return false
    if (filter.value === 'unmatched') return !hasSupportedSubtitle(row) || Boolean(row.scanError)
    if (filter.value === 'review') return hasSupportedSubtitle(row) && row.confidence !== 'high'
    if (filter.value === 'selected') return selectedIds.value.has(row.id)
    return true
  })
})
const pageRows = computed(() => filteredRows.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE))
const batchItemsByVideo = computed(() => new Map(batch.value?.items.map((item) => [item.videoPath, item]) ?? []))
const batchCounts = computed(() => {
  const items = batch.value?.items ?? []
  return {
    total: items.length,
    succeeded: items.filter((item) => item.status === 'succeeded').length,
    failed: items.filter((item) => item.status === 'failed').length,
    cancelled: items.filter((item) => item.status === 'cancelled').length,
    finished: items.filter((item) => !['queued', 'running'].includes(item.status)).length
  }
})
const batchProgress = computed(() => {
  const items = batch.value?.items ?? []
  return items.length ? Math.round(items.reduce((total, item) => total + (['succeeded', 'failed', 'cancelled'].includes(item.status) ? 1 : item.progress), 0) / items.length * 100) : 0
})
const activeItem = computed(() => batch.value?.items.find((item) => item.status === 'running'))
const retryRows = computed(() => rows.value.filter((row) => ['failed', 'cancelled'].includes(batchItemsByVideo.value.get(row.videoPath)?.status ?? '') && canProcessRow(row)))
const encodingReady = computed(() => embedMode.value === 'soft' || acceleration.value === 'cpu-fast' || (!checkingHardware.value && !hardwareError.value && hardware.value?.qsvAvailable === true))
const canStart = computed(() => Boolean(scan.value) && readyRows.value.length > 0 && embeddedSoftRows.value.length === 0 && !busy.value && ffmpeg.value.available && offsetSeconds.value !== null && encodingReady.value)
const hardwareMessage = computed(() => checkingHardware.value ? '正在读取本机硬件并实测 QSV 编码…' : hardwareError.value || hardware.value?.message || '硬件检测尚未完成')
const reusedSubtitles = computed(() => {
  const counts = new Map<string, number>()
  for (const row of readyRows.value) {
    const source = selectedSource(row)
    if (source?.kind === 'external') counts.set(source.path, (counts.get(source.path) ?? 0) + 1)
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([path]) => path))
})

const filterOptions = [
  { label: '全部视频', value: 'all' },
  { label: '需要确认', value: 'review' },
  { label: '未匹配字幕', value: 'unmatched' },
  { label: '已勾选', value: 'selected' }
]
const encodingOptions = [
  { label: '自动识别（推荐）', value: 'auto' },
  { label: 'UTF-8', value: 'utf8' },
  { label: 'GB18030 / GBK（简体中文）', value: 'gb18030' },
  { label: 'Big5（繁体中文）', value: 'big5' },
  { label: 'Shift_JIS（日文）', value: 'shift_jis' }
]
const resolutionOptions = [
  { label: '保留原分辨率（默认）', value: 'source' },
  { label: '1080p 速度模式', value: '1080p' }
]

watch([search, filter], () => { page.value = 1 })
watch(() => filteredRows.value.length, (length) => { page.value = Math.min(page.value, Math.max(1, Math.ceil(length / PAGE_SIZE))) })

function fileName(path: string): string { return path.split(/[\\/]/).pop() ?? path }
function selectedSource(row: SubtitleMatchRow): SubtitleInputSource | undefined {
  return row.subtitleSource ?? (row.subtitlePath ? { kind: 'external', path: row.subtitlePath } : undefined)
}
function sourceKey(source: SubtitleInputSource): string { return source.kind === 'embedded' ? `embedded:${source.streamIndex}` : source.path }
function candidateSource(candidate: SubtitleCandidate): SubtitleInputSource { return candidate.source ?? { kind: 'external', path: candidate.path } }
function candidateKey(candidate: SubtitleCandidate): string { return sourceKey(candidateSource(candidate)) }
function selectionValue(row: SubtitleMatchRow): string | null { const source = selectedSource(row); return source ? sourceKey(source) : null }
function selectedCandidate(row: SubtitleMatchRow): SubtitleCandidate | undefined { return row.candidates.find((candidate) => candidateKey(candidate) === selectionValue(row)) }
function selectedTrack(row: SubtitleMatchRow): EmbeddedSubtitleTrack | undefined {
  const source = selectedSource(row)
  return source?.kind === 'embedded' ? row.embeddedTracks?.find((track) => track.streamIndex === source.streamIndex) : undefined
}
function hasSupportedSubtitle(row: SubtitleMatchRow): boolean {
  const source = selectedSource(row)
  return Boolean(source && selectedCandidate(row)?.supported !== false && selectedTrack(row)?.supported !== false && (source.kind === 'embedded' || source.path))
}
function canProcessRow(row: SubtitleMatchRow): boolean { return !row.scanError && hasSupportedSubtitle(row) && (embedMode.value === 'burn' || selectedSource(row)?.kind === 'external') }
function trackLanguageLabel(track: EmbeddedSubtitleTrack): string {
  const title = track.title ?? ''
  const tags = `${title} ${track.language ?? ''}`
  const simplified = /(?:chs|zh[-_. ]?hans|zh[-_. ]?cn|简体|简中)/i.test(tags)
  const traditional = /(?:cht|zh[-_. ]?hant|zh[-_. ]?tw|繁体|繁中)/i.test(tags)
  const japanese = /(?:(?:^|[^a-z])jpn(?:$|[^a-z])|japanese|日语|日文|中日|简日|繁日)/i.test(title)
  const english = /(?:(?:^|[^a-z])eng(?:$|[^a-z])|english|英语|英文|中英|简英|繁英)/i.test(title)
  if (simplified || traditional) return `${simplified ? '简体' : '繁体'}${japanese ? ' / 日语双语' : english ? ' / 英语双语' : '中文'}`
  if (/(?:chi|zho|zh)(?:$|[-_])/i.test(track.language ?? '')) return '中文'
  if (/^(?:jpn|ja)$/i.test(track.language ?? '')) return '日语'
  if (/^(?:eng|en)$/i.test(track.language ?? '')) return '英语'
  return track.language ? `语言 ${track.language}` : '语言未标注'
}
function trackCodecLabel(codec: string): string {
  const name = codec.toLowerCase()
  return ({ ass: 'ASS', ssa: 'SSA', subrip: 'SRT', srt: 'SRT', webvtt: 'VTT', vtt: 'VTT', mov_text: '文本字幕', text: '文本字幕', hdmv_pgs_subtitle: 'PGS 图片字幕', dvd_subtitle: 'DVD 图片字幕', dvb_subtitle: 'DVB 图片字幕' } as Record<string, string>)[name] ?? codec.toUpperCase()
}
function candidateDisplayName(candidate: SubtitleCandidate, row?: SubtitleMatchRow): string {
  const source = candidateSource(candidate)
  if (source.kind === 'external') return candidate.name
  const track = row?.embeddedTracks?.find((item) => item.streamIndex === source.streamIndex)
  if (!track) return candidate.name
  const group = /\[([^\]]+)\]/.exec(track.title ?? '')?.[1]
  const title = group || track.title?.replace(/^(?:chs|cht|zh[-_. ]?(?:hans|hant|cn|tw))(?:(?:[&+._ -])(?:jpn|eng))*\s*/i, '').trim()
  return [`第 ${track.subtitleIndex + 1} 条`, trackLanguageLabel(track), title, trackCodecLabel(track.codec), track.default ? '原片默认' : '', track.forced ? '强制字幕' : '', track.supported ? '' : '暂不支持'].filter(Boolean).join(' · ')
}
function selectedSubtitleLabel(row: SubtitleMatchRow): string { const candidate = selectedCandidate(row); return candidate ? candidateDisplayName(candidate, row) : fileName(row.subtitlePath ?? '') }
function sourceKind(row: SubtitleMatchRow): 'embedded' | 'external' | 'none' { return selectedSource(row)?.kind ?? 'none' }
function sourceBadgeLabel(row: SubtitleMatchRow): string { return sourceKind(row) === 'embedded' ? '视频内字幕' : sourceKind(row) === 'external' ? '外挂字幕' : '未选择' }
function rowConfidenceLabel(row: SubtitleMatchRow): string {
  if (selectedSource(row) && !hasSupportedSubtitle(row)) return '此字幕暂不支持'
  if (sourceKind(row) === 'embedded') return row.confidence === 'high' ? '内置字幕已选' : '请确认字幕语言'
  return confidenceLabel(row.confidence)
}
function formatError(error: unknown): string { return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(error) }
function confidenceLabel(confidence: SubtitleConfidence | null): string { return confidence ? { high: '匹配可靠', medium: '建议确认', low: '需要确认' }[confidence] : '未匹配' }
function confidenceType(confidence: SubtitleConfidence | null): 'success' | 'warning' | 'default' { return confidence === 'high' ? 'success' : confidence ? 'warning' : 'default' }
function operationLabel(mode: SubtitleEmbedMode): string { return mode === 'burn' ? '字幕烧录' : '字幕轨内封' }
function itemStatusLabel(status: string, phase?: SubtitleProcessingPhase): string {
  if (status === 'running' && phase === 'finalizing') return '正在整理文件'
  if (status === 'running' && phase === 'preparing') return '正在准备数据'
  if (status === 'running' && phase === 'probing') return '正在检测视频'
  const operation = operationLabel(batch.value?.mode ?? embedMode.value)
  return ({ queued: '等待处理', running: `${operation}中`, succeeded: `${operation}完成`, failed: '处理失败', cancelled: '已取消' } as Record<string, string>)[status] ?? status
}
function encoderLabel(encoder?: string): string {
  if (!encoder) return '准备中'
  if (/qsv/i.test(encoder)) return `Intel QSV · ${encoder}`
  if (/libx264/i.test(encoder)) return `CPU · ${encoder}`
  if (/^(?:copy|stream-copy)$/i.test(encoder)) return '音视频直接复制'
  return encoder
}
function decoderLabel(decoder?: string): string {
  if (!decoder) return '准备中'
  if (/qsv/i.test(decoder)) return `Intel 硬件解码 · ${decoder}`
  if (/d3d11va|dxva2/i.test(decoder)) return `硬件解码 · ${decoder}`
  if (/^(?:cpu|software)$/i.test(decoder)) return 'CPU 软件解码'
  if (/^(?:copy|none|stream-copy)$/i.test(decoder)) return '直接复制'
  if (/[（(]CPU[）)]/i.test(decoder)) return `CPU 软件解码 · ${decoder.replace(/\s*[（(]CPU[）)]/i, '')}`
  return `CPU · ${decoder}`
}
function formatDuration(seconds?: number): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '计算中'
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor(total % 3600 / 60)
  const rest = String(total % 60).padStart(2, '0')
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`
}
function remainingLabel(item: SubtitleBatchItem): string {
  if (item.status === 'succeeded') return '已完成'
  if (item.status === 'cancelled' || item.status === 'failed') return '已停止'
  if (item.phase === 'finalizing') return '整理中'
  return formatDuration(item.estimatedRemainingSeconds)
}
function telemetryItems(item: SubtitleBatchItem): Array<{ label: string; value: string }> {
  if (item.status === 'queued') return []
  if (batch.value?.mode === 'soft') {
    const details = [
      { label: '编码', value: encoderLabel(item.actualEncoder) },
      { label: '解码', value: decoderLabel(item.actualDecoder) },
      { label: '已用', value: formatDuration(item.elapsedSeconds) },
      { label: '剩余', value: remainingLabel(item) }
    ]
    if (item.outputWidth && item.outputHeight) details.push({ label: '输出', value: `${item.outputWidth}×${item.outputHeight}` })
    return details
  }
  const details = [
    { label: '编码', value: encoderLabel(item.actualEncoder) },
    { label: '解码', value: decoderLabel(item.actualDecoder) },
    { label: 'FPS', value: item.fps !== undefined && Number.isFinite(item.fps) && item.fps > 0 ? item.fps.toFixed(1) : '计算中' },
    { label: '倍速', value: item.speed !== undefined && Number.isFinite(item.speed) && item.speed > 0 ? `${item.speed.toFixed(2)}x` : '计算中' },
    { label: '已用', value: formatDuration(item.elapsedSeconds) },
    { label: '剩余', value: remainingLabel(item) }
  ]
  if (item.outputWidth && item.outputHeight) details.push({ label: '输出', value: `${item.outputWidth}×${item.outputHeight}` })
  return details
}
function changeAcceleration(value: SubtitleAcceleration): void { if (!busy.value) acceleration.value = value }
function changeMode(mode: SubtitleEmbedMode): void {
  if (busy.value || embedMode.value === mode) return
  embedMode.value = mode
  format.value = mode === 'burn' ? 'mp4' : 'mkv'
}

function selectAll(checked: boolean): void {
  if (busy.value) return
  selectedIds.value = checked ? new Set(rows.value.map((row) => row.id)) : new Set()
}
function selectRow(rowId: string, checked: boolean): void {
  if (busy.value) return
  const next = new Set(selectedIds.value)
  if (checked) next.add(rowId)
  else next.delete(rowId)
  selectedIds.value = next
}
function invertSelection(): void {
  if (!busy.value) selectedIds.value = new Set(rows.value.filter((row) => !selectedIds.value.has(row.id)).map((row) => row.id))
}
function selectReliable(): void {
  if (!busy.value) selectedIds.value = new Set(rows.value.filter((row) => canProcessRow(row) && row.confidence === 'high').map((row) => row.id))
}
function deselectEmbeddedSoftRows(): void {
  if (busy.value) return
  const excluded = new Set(embeddedSoftRows.value.map((row) => row.id))
  selectedIds.value = new Set([...selectedIds.value].filter((id) => !excluded.has(id)))
}

function applyScan(result: SubtitleScanResult): void {
  scan.value = result
  selectAllAfterScan(result)
  batch.value = null
  search.value = ''
  filter.value = 'all'
  page.value = 1
  errorText.value = ''
  if (!result.rows.length) message.info('当前目录没有支持的视频文件')
}
function selectAllAfterScan(result: SubtitleScanResult): void { selectedIds.value = new Set(result.rows.map((row) => row.id)) }

async function chooseSource(mode: 'folder' | 'video'): Promise<void> {
  if (busy.value) return
  loading.value = true
  scanProgress.value = null
  errorText.value = ''
  try {
    const result = await (mode === 'folder' ? window.electronApi.subtitles.selectFolder() : window.electronApi.subtitles.selectVideo())
    if (result) applyScan(result)
  } catch (error) { errorText.value = formatError(error) }
  finally { loading.value = false }
}

async function rescan(): Promise<void> {
  if (!scan.value || busy.value) return
  const path = scan.value.mode === 'video' ? scan.value.rows[0]?.videoPath : scan.value.directory
  if (!path) return
  loading.value = true
  scanProgress.value = null
  errorText.value = ''
  try { applyScan(await window.electronApi.subtitles.scanPath(path)) }
  catch (error) { errorText.value = formatError(error) }
  finally { loading.value = false }
}

function dragEnter(event: DragEvent): void {
  if (!event.dataTransfer?.types.includes('Files') || busy.value) return
  event.preventDefault()
  dragDepth += 1
  dragging.value = true
}
function dragLeave(): void { dragDepth = Math.max(0, dragDepth - 1); dragging.value = dragDepth > 0 }
async function dropSource(event: DragEvent): Promise<void> {
  event.preventDefault()
  dragDepth = 0
  dragging.value = false
  if (busy.value) return
  const files = event.dataTransfer?.files
  if (!files?.length) return
  if (files.length > 1) { message.warning('请一次拖入一个文件夹或一个视频'); return }
  const path = window.electronApi.media.pathForFile(files[0])
  if (!path) { message.warning('无法读取拖入文件的位置，请使用选择按钮'); return }
  loading.value = true
  scanProgress.value = null
  errorText.value = ''
  try { applyScan(await window.electronApi.subtitles.scanPath(path)) }
  catch (error) { errorText.value = formatError(error) }
  finally { loading.value = false }
}

function candidateOptions(row: SubtitleMatchRow): Array<{ label: string; value: string; disabled: boolean }> {
  return row.candidates.map((candidate) => {
    const source = candidateSource(candidate)
    const track = source.kind === 'embedded' ? row.embeddedTracks?.find((item) => item.streamIndex === source.streamIndex) : undefined
    return { label: source.kind === 'embedded' ? `视频内 · ${candidateDisplayName(candidate, row)}` : `外挂 · ${candidate.name} · 匹配 ${candidate.score}`, value: candidateKey(candidate), disabled: candidate.supported === false || track?.supported === false || (source.kind === 'external' && !source.path) }
  })
}
function changeSubtitle(row: SubtitleMatchRow, value: string | null): void {
  if (busy.value) return
  const candidate = row.candidates.find((item) => candidateKey(item) === value)
  if (candidate?.supported === false) { message.warning(candidate.reason || '此字幕轨暂不支持烧录'); return }
  row.subtitleSource = candidate ? candidateSource(candidate) : undefined
  row.subtitlePath = row.subtitleSource?.kind === 'external' ? row.subtitleSource.path : null
  row.confidence = candidate?.confidence ?? null
  row.reason = candidate?.reason ?? '请从视频内字幕或外挂候选中选择，也可以手动指定字幕文件'
}
async function chooseSubtitle(row: SubtitleMatchRow): Promise<void> {
  if (!scan.value || busy.value) return
  manualLoading.value = row.id
  try {
    const candidate = await window.electronApi.subtitles.selectSubtitle(scan.value.scanId, row.id)
    if (!candidate) return
    row.candidates = [candidate, ...row.candidates.filter((item) => candidateKey(item) !== candidateKey(candidate))]
    row.subtitleSource = candidateSource(candidate)
    row.subtitlePath = row.subtitleSource.kind === 'external' ? row.subtitleSource.path : null
    row.confidence = candidate.confidence
    row.reason = candidate.reason
  } catch (error) { message.error(formatError(error)) }
  finally { manualLoading.value = '' }
}

function notifyFinished(snapshot: SubtitleBatchSnapshot): void {
  if (snapshot.status === 'running' || notifiedBatches.has(snapshot.batchId)) return
  notifiedBatches.add(snapshot.batchId)
  const succeeded = snapshot.items.filter((item) => item.status === 'succeeded').length
  const failed = snapshot.items.filter((item) => item.status === 'failed').length
  const operation = operationLabel(snapshot.mode)
  if (snapshot.status === 'cancelled') message.info(`${operation}已停止，已完成 ${succeeded} 个视频`)
  else if (failed) message.warning(`${operation}结束：成功 ${succeeded} 个，失败 ${failed} 个`)
  else message.success(`${operation}完成，共 ${succeeded} 个视频`)
}
function handleEvent(snapshot: SubtitleBatchSnapshot): void {
  eventRevision += 1
  if (starting.value) {
    bufferedEvents.set(snapshot.batchId, snapshot)
    if (bufferedEvents.size > 4) bufferedEvents.delete(bufferedEvents.keys().next().value!)
    return
  }
  if (batch.value && snapshot.batchId !== batch.value.batchId) return
  batch.value = snapshot
  if (!scan.value && snapshot.status === 'running') {
    embedMode.value = snapshot.mode
    acceleration.value = snapshot.acceleration
    resolution.value = snapshot.resolution
    format.value = snapshot.mode === 'burn' ? 'mp4' : 'mkv'
  }
  if (snapshot.status !== 'running') cancelling.value = false
  notifyFinished(snapshot)
}

async function startBatch(onlyRetry = false): Promise<void> {
  if (!scan.value || busy.value || !ffmpeg.value.available || !encodingReady.value || embeddedSoftRows.value.length) return
  const targets = onlyRetry ? retryRows.value : readyRows.value
  if (!targets.length || offsetSeconds.value === null) return
  starting.value = true
  errorText.value = ''
  bufferedEvents.clear()
  try {
    const result = await window.electronApi.subtitles.start({
      scanId: scan.value.scanId,
      items: targets.map((row) => {
        const source = selectedSource(row)!
        return { rowId: row.id, source: source.kind === 'embedded'
          ? { kind: 'embedded' as const, streamIndex: source.streamIndex }
          : { kind: 'external' as const, path: source.path } }
      }),
      mode: embedMode.value,
      acceleration: acceleration.value,
      resolution: embedMode.value === 'burn' ? resolution.value : 'source',
      format: embedMode.value === 'burn' ? 'mp4' : format.value,
      encoding: encoding.value,
      offsetSeconds: offsetSeconds.value
    })
    batch.value = bufferedEvents.get(result.batchId) ?? result
    notifyFinished(batch.value)
  } catch (error) { errorText.value = formatError(error) }
  finally { starting.value = false; bufferedEvents.clear() }
}

async function cancelBatch(): Promise<void> {
  if (!batch.value || cancelling.value) return
  cancelling.value = true
  try { await window.electronApi.subtitles.cancel(batch.value.batchId) }
  catch (error) { cancelling.value = false; message.error(formatError(error)) }
}
async function openOutput(): Promise<void> {
  if (!batch.value) return
  try { await window.electronApi.subtitles.openOutput(batch.value.batchId) }
  catch (error) { message.error(formatError(error)) }
}
async function refreshFfmpeg(): Promise<void> {
  checkingFfmpeg.value = true
  try { ffmpeg.value = await window.electronApi.media.ffmpegStatus() }
  catch (error) { ffmpeg.value = { available: false, message: formatError(error) } }
  finally { checkingFfmpeg.value = false }
}
async function refreshHardware(force = false): Promise<void> {
  if (force && (busy.value || checkingHardware.value)) return
  checkingHardware.value = true
  hardwareError.value = ''
  try { hardware.value = await window.electronApi.subtitles.hardwareStatus(force) }
  catch (error) { hardwareError.value = formatError(error) }
  finally { checkingHardware.value = false }
}

onMounted(() => {
  unsubscribe = window.electronApi.subtitles.onEvent(handleEvent)
  unsubscribeScan = window.electronApi.subtitles.onScanProgress((progress) => { if (loading.value) scanProgress.value = progress })
  const revision = eventRevision
  void window.electronApi.subtitles.snapshot().then((snapshot) => {
    if (eventRevision !== revision || !snapshot) return
    batch.value = snapshot
    if (snapshot.status === 'running') {
      embedMode.value = snapshot.mode
      format.value = snapshot.mode === 'burn' ? 'mp4' : 'mkv'
      acceleration.value = snapshot.acceleration
      resolution.value = snapshot.resolution
    }
    if (snapshot.status !== 'running') notifiedBatches.add(snapshot.batchId)
  }).catch((error: unknown) => { errorText.value = formatError(error) })
  void refreshFfmpeg()
  void refreshHardware()
})
onUnmounted(() => { unsubscribe?.(); unsubscribeScan?.() })
</script>

<template>
  <ToolPage title="视频字幕烧录">
    <template #actions>
      <NButton data-testid="subtitle-select-folder" :disabled="busy" :loading="loading" @click="chooseSource('folder')"><template #icon><NIcon :component="FolderOpen" /></template>选择文件夹</NButton>
      <NButton data-testid="subtitle-select-video" :disabled="busy" @click="chooseSource('video')"><template #icon><NIcon :component="FileVideo" /></template>选择视频</NButton>
    </template>
    <template #status>
      <NTooltip><template #trigger><NTag size="small" :type="checkingFfmpeg ? 'default' : ffmpeg.available ? 'success' : 'error'">{{ checkingFfmpeg ? '检测中' : ffmpeg.available ? 'FFmpeg 已就绪' : 'FFmpeg 不可用' }}</NTag></template>{{ ffmpeg.message }}</NTooltip>
    </template>

    <div class="subtitle-workspace" :class="{ 'is-dragging': dragging }" @dragenter="dragEnter" @dragleave="dragLeave" @dragover.prevent @drop="dropSource">
      <div v-if="dragging" class="drop-overlay"><Upload :size="40" /><strong>松开以匹配字幕</strong><span>支持一个文件夹或一个视频</span></div>
      <div v-if="errorText" class="error-banner" role="alert"><span>{{ errorText }}</span><NButton size="tiny" quaternary @click="errorText = ''">关闭</NButton></div>
      <div v-if="loading" data-testid="subtitle-scan-progress" :data-completed="scanProgress?.completed ?? 0" :data-total="scanProgress?.total ?? 0" class="scan-progress" aria-live="polite"><div><strong>正在读取视频字幕{{ scanProgress?.total ? ` ${scanProgress.completed}/${scanProgress.total}` : '…' }}</strong><span v-if="scanProgress?.videoName" :title="scanProgress.videoName">{{ scanProgress.videoName }}</span></div><NProgress v-if="scanProgress?.total" type="line" :percentage="Math.round(scanProgress.completed / scanProgress.total * 100)" :show-indicator="false" /></div>

      <div class="workspace-columns">
        <section class="matching-panel">
          <template v-if="scan">
            <div class="source-bar">
              <div class="source-icon"><NIcon :component="scan.mode === 'folder' ? FolderOpen : FileVideo" :size="22" /></div>
              <div class="source-copy"><strong :title="scan.directory">{{ fileName(scan.directory) || scan.directory }}</strong><span :title="scan.directory">{{ scan.directory }}</span></div>
              <NTag size="small">{{ scan.mode === 'folder' ? '整个文件夹' : '单个视频' }}</NTag>
              <NTooltip><template #trigger><NButton quaternary circle :disabled="busy" aria-label="重新扫描当前目录" @click="rescan"><template #icon><NIcon :component="RefreshCw" /></template></NButton></template>重新匹配</NTooltip>
            </div>
            <div class="match-heading"><div><strong>视频与字幕选择</strong><span>{{ rows.length }} 个视频 · {{ embeddedCount }} 条视频内字幕 · {{ scan.subtitleCount }} 个外挂字幕</span></div><span class="scope-note">扫描当前目录</span></div>
            <div class="list-controls">
              <NInput v-model:value="search" clearable placeholder="搜索视频、字幕或集数" size="small"><template #prefix><NIcon :component="Search" /></template></NInput>
              <NSelect v-model:value="filter" :options="filterOptions" size="small" class="filter-select" aria-label="筛选匹配结果" />
            </div>
            <div class="selection-toolbar">
              <NCheckbox :checked="allSelected" :indeterminate="partialSelected" :disabled="busy || !rows.length" @update:checked="selectAll">全选 <span class="selection-count">{{ selectedRows.length }}/{{ rows.length }}</span></NCheckbox>
              <div><NButton size="tiny" quaternary :disabled="busy || !rows.length" @click="invertSelection">反选</NButton><NButton size="tiny" quaternary :disabled="busy || !rows.length" @click="selectReliable"><template #icon><NIcon :component="CheckCheck" /></template>只选推荐字幕</NButton></div>
            </div>
            <div class="match-list" aria-label="视频字幕匹配列表" :aria-busy="loading">
              <article v-for="row in pageRows" :key="row.id" data-testid="subtitle-match-row" :data-row-id="row.id" :data-source-kind="sourceKind(row)" class="match-row" :class="{ 'is-selected': selectedIds.has(row.id), 'is-unmatched': !hasSupportedSubtitle(row) || row.scanError }">
                <div class="row-select"><NCheckbox data-testid="subtitle-row-checkbox" :checked="selectedIds.has(row.id)" :disabled="busy" :aria-label="`选择视频 ${row.videoName}`" @update:checked="selectRow(row.id, $event)" /></div>
                <div class="row-content">
                  <div class="video-line"><FileVideo :size="17" /><strong :title="row.videoPath">{{ row.videoName }}</strong><NTag v-if="row.episode" size="tiny" class="episode-tag">{{ row.episode }}</NTag></div>
                  <div class="subtitle-line"><ChevronRight :size="15" class="pair-arrow" /><NSelect data-testid="subtitle-track-select" :data-source-kind="sourceKind(row)" :value="selectionValue(row)" :options="candidateOptions(row)" :disabled="busy" clearable filterable size="small" placeholder="请选择视频内字幕或外挂文件" :title="selectedSubtitleLabel(row) || undefined" :aria-label="`${row.videoName} 的字幕来源`" @update:value="changeSubtitle(row, $event)" /><NTooltip><template #trigger><NButton data-testid="subtitle-select-subtitle" size="small" secondary :disabled="busy" :loading="manualLoading === row.id" :aria-label="`为 ${row.videoName} 选择外挂字幕文件`" @click="chooseSubtitle(row)"><template #icon><NIcon :component="FolderOpen" /></template><span class="manual-label">指定</span></NButton></template>手动选择外挂字幕文件</NTooltip></div>
                  <div class="match-explanation"><NTag data-testid="subtitle-source-kind" :data-kind="sourceKind(row)" size="tiny" :type="sourceKind(row) === 'embedded' ? 'info' : 'default'">{{ sourceBadgeLabel(row) }}</NTag><NTag size="tiny" :type="selectedSource(row) && !hasSupportedSubtitle(row) ? 'warning' : confidenceType(row.confidence)">{{ rowConfidenceLabel(row) }}</NTag><span :title="row.reason">{{ row.reason }}</span><span v-if="row.subtitlePath && reusedSubtitles.has(row.subtitlePath)" class="reuse-warning">同一外挂字幕被多次选择</span></div>
                  <p v-if="sourceKind(row) === 'embedded' && row.embeddedFontCount" class="font-hint">附带 {{ row.embeddedFontCount }} 个字体，烧录时自动保留字幕样式。</p>
                  <p v-if="row.scanError" class="row-warning" role="alert">无法读取此视频：{{ row.scanError }}。本项将跳过，可重新扫描。</p>
                  <p v-if="embedMode === 'soft' && sourceKind(row) === 'embedded' && hasSupportedSubtitle(row)" class="row-warning">视频已有内置字幕；本项需切换“烧录到画面”，不会重复内封。</p>
                  <div v-if="batchItemsByVideo.has(row.videoPath)" data-testid="subtitle-batch-item" :data-status="batchItemsByVideo.get(row.videoPath)!.status" class="row-result" :class="`result-${batchItemsByVideo.get(row.videoPath)!.status}`">
                    <NProgress v-if="batchItemsByVideo.get(row.videoPath)!.status === 'running'" type="line" :percentage="Math.round(batchItemsByVideo.get(row.videoPath)!.progress * 100)" :show-indicator="false" :processing="true" />
                    <CircleCheck v-if="batchItemsByVideo.get(row.videoPath)!.status === 'succeeded'" :size="14" />
                    <span :title="batchItemsByVideo.get(row.videoPath)!.error || batchItemsByVideo.get(row.videoPath)!.message">{{ itemStatusLabel(batchItemsByVideo.get(row.videoPath)!.status, batchItemsByVideo.get(row.videoPath)!.phase) }}{{ batchItemsByVideo.get(row.videoPath)!.error ? `：${batchItemsByVideo.get(row.videoPath)!.error}` : '' }}</span>
                  </div>
                  <div v-if="batchItemsByVideo.has(row.videoPath) && batchItemsByVideo.get(row.videoPath)!.status !== 'queued'" data-testid="subtitle-item-telemetry" :data-encoder="batchItemsByVideo.get(row.videoPath)!.actualEncoder" :data-decoder="batchItemsByVideo.get(row.videoPath)!.actualDecoder" :data-phase="batchItemsByVideo.get(row.videoPath)!.phase" class="row-telemetry"><span v-for="metric in telemetryItems(batchItemsByVideo.get(row.videoPath)!)" :key="metric.label" :title="`${metric.label}：${metric.value}`"><small>{{ metric.label }}</small><strong>{{ metric.value }}</strong></span></div>
                </div>
              </article>
              <div v-if="!pageRows.length" class="list-empty"><Search :size="30" /><strong>{{ rows.length ? '没有符合条件的视频' : '当前目录没有视频' }}</strong><span>{{ rows.length ? '调整搜索或筛选条件即可查看其他视频' : '支持 MP4、MKV、AVI、MOV、TS 等常见视频格式' }}</span></div>
            </div>
            <div class="list-footer"><span>显示 {{ filteredRows.length ? (page - 1) * PAGE_SIZE + 1 : 0 }}–{{ Math.min(page * PAGE_SIZE, filteredRows.length) }} / {{ filteredRows.length }}</span><NPagination v-if="filteredRows.length > PAGE_SIZE" v-model:page="page" :page-size="PAGE_SIZE" :item-count="filteredRows.length" :page-slot="5" size="small" /></div>
          </template>

          <div v-else-if="!batch" class="welcome-state">
            <div class="welcome-art"><FileVideo :size="44" /><span><Subtitles :size="25" /></span></div>
            <div class="welcome-copy"><h2>让字幕直接出现在视频画面里</h2><p>有视频内字幕或外挂字幕都可以。<br>选择文件夹，确认中文轨，再点烧录；新视频拷到平板就能直接显示。</p></div>
            <div class="source-choices"><button :disabled="busy" @click="chooseSource('folder')"><FolderOpen :size="23" /><strong>处理整个文件夹</strong><span>读取内置轨并匹配外挂，默认全选</span></button><button :disabled="busy" @click="chooseSource('video')"><FileVideo :size="23" /><strong>处理单个视频</strong><span>读取字幕轨，也可手动指定外挂</span></button></div>
            <div class="drag-hint"><Upload :size="15" /><span>也可以把文件夹或视频拖到这里</span></div>
            <div class="welcome-steps"><span><i>1</i>选择视频</span><ChevronRight :size="14" /><span><i>2</i>确认字幕</span><ChevronRight :size="14" /><span><i>3</i>烧录到画面</span></div>
          </div>

          <template v-if="batch">
            <section class="batch-panel" :class="{ 'batch-restored': !scan }" aria-live="polite">
              <div class="batch-heading"><div><strong>{{ activeItem?.phase === 'finalizing' ? '正在整理文件' : `${operationLabel(batch.mode)}${batch.status === 'running' ? '中' : batch.status === 'cancelled' ? '已停止' : '已结束'}` }}</strong><span>{{ batchCounts.finished }}/{{ batchCounts.total }} 个视频</span></div><NButton v-if="batch.status === 'running'" data-testid="subtitle-cancel" size="small" type="error" secondary :loading="cancelling" @click="cancelBatch"><template #icon><NIcon :component="Ban" /></template>{{ cancelling ? '正在停止' : '停止处理' }}</NButton><NButton v-else size="small" secondary @click="openOutput"><template #icon><NIcon :component="FolderOpen" /></template>打开输出</NButton></div>
              <NProgress type="line" :percentage="batchProgress" :processing="batch.status === 'running'" :status="batch.status === 'running' ? 'default' : batchCounts.failed ? 'warning' : batch.status === 'cancelled' ? 'default' : 'success'" />
              <div class="batch-summary"><span class="success-count">完成 {{ batchCounts.succeeded }}</span><span :class="{ 'failure-count': batchCounts.failed }">失败 {{ batchCounts.failed }}</span><span>取消 {{ batchCounts.cancelled }}</span><span v-if="activeItem" class="active-file" :title="activeItem.videoName">{{ activeItem.videoName }} · {{ Math.round(activeItem.progress * 100) }}%</span></div>
              <div v-if="activeItem && scan" class="active-telemetry" aria-label="当前视频处理速度"><span>{{ encoderLabel(activeItem.actualEncoder) }}</span><template v-if="batch.mode === 'burn'"><span>{{ activeItem.fps !== undefined && Number.isFinite(activeItem.fps) && activeItem.fps > 0 ? `${activeItem.fps.toFixed(1)} FPS` : 'FPS 计算中' }}</span><span>{{ activeItem.speed !== undefined && Number.isFinite(activeItem.speed) && activeItem.speed > 0 ? `${activeItem.speed.toFixed(2)}x` : '倍速计算中' }}</span></template><span>剩余 {{ remainingLabel(activeItem) }}</span></div>
              <div v-if="!scan" class="restored-queue"><article v-for="item in batch.items" :key="item.id" data-testid="subtitle-batch-item" :data-status="item.status" :class="`result-${item.status}`"><div><strong :title="item.videoPath">{{ item.videoName }}</strong><span :title="item.error || item.message">{{ item.error || item.message }}</span><div v-if="item.status !== 'queued'" data-testid="subtitle-item-telemetry" :data-encoder="item.actualEncoder" :data-decoder="item.actualDecoder" :data-phase="item.phase" class="row-telemetry"><span v-for="metric in telemetryItems(item)" :key="metric.label"><small>{{ metric.label }}</small><strong>{{ metric.value }}</strong></span></div></div><NTag size="small" :type="item.status === 'succeeded' ? 'success' : item.status === 'failed' ? 'error' : 'default'">{{ itemStatusLabel(item.status, item.phase) }}</NTag></article></div>
              <p v-if="!scan" class="restore-note">已恢复最近一次任务。处理结束后，可重新选择来源继续操作。</p>
            </section>
          </template>
        </section>

        <aside class="output-panel">
          <div class="settings-title"><Subtitles :size="20" /><h2>字幕处理设置</h2></div>
          <div class="settings-scroll">
          <section data-testid="subtitle-hardware-status" :data-qsv-available="hardware?.qsvAvailable ?? false" :data-checking="checkingHardware" class="hardware-card"><div class="hardware-heading"><strong>{{ hardware?.gpuName || (checkingHardware ? '正在读取本机硬件' : '本机硬件检测') }}</strong><NTooltip><template #trigger><NButton quaternary circle size="tiny" :disabled="busy || checkingHardware" :loading="checkingHardware" aria-label="重新检测本机硬件加速" @click="refreshHardware(true)"><template #icon><NIcon :component="RefreshCw" /></template></NButton></template>重新检测本机设备与 QSV 硬件编码</NTooltip></div><span v-if="hardware?.cpuName" class="hardware-device">{{ hardware.cpuName }}</span><span v-if="hardware?.driverVersion" class="hardware-device">显卡驱动 {{ hardware.driverVersion }}</span><NTag size="tiny" :type="checkingHardware ? 'default' : hardware?.qsvAvailable && !hardwareError ? 'success' : 'warning'">{{ checkingHardware ? '正在检测硬件加速' : hardware?.qsvAvailable && !hardwareError ? 'Intel QSV 已就绪' : 'QSV 尚不可用' }}</NTag><p :class="{ 'hardware-warning': !checkingHardware && (!hardware?.qsvAvailable || hardwareError) }">{{ hardwareMessage }}</p></section>
          <div class="setting-section mode-section"><label class="setting-label">字幕处理方式</label><div class="mode-choices"><button data-testid="subtitle-mode-burn" :class="{ active: embedMode === 'burn' }" :disabled="busy" :aria-pressed="embedMode === 'burn'" @click="changeMode('burn')"><div><strong>烧录到画面</strong><span>推荐</span></div><small>跨设备播放，字幕直接可见</small></button><button data-testid="subtitle-mode-soft" :class="{ active: embedMode === 'soft' }" :disabled="busy" :aria-pressed="embedMode === 'soft'" @click="changeMode('soft')"><div><strong>内置字幕轨</strong><span>可开关</span></div><small>需要播放器支持并开启字幕轨</small></button></div><p class="setting-description mode-description">{{ embedMode === 'burn' ? '字幕成为画面的一部分，复制视频到手机、电视等设备也能直接显示；无法关闭字幕。视频会重新编码，耗时更长。' : '字幕存入视频文件无需外挂，但播放器需要支持并开启字幕轨。视频与音频直接复制，处理更快。' }}</p></div>
          <div class="preserve-note"><ShieldCheck :size="19" /><div><strong>原文件完整保留</strong><span>原视频、视频内字幕及外挂文件均不修改。<br>字幕和字体自动读取，成品另存。</span></div></div>
          <template v-if="embedMode === 'burn'">
            <div class="setting-section"><label class="setting-label">编码方式</label><div class="mode-choices"><button data-testid="subtitle-acceleration-auto" :class="{ active: acceleration === 'auto' }" :disabled="busy" :aria-pressed="acceleration === 'auto'" @click="changeAcceleration('auto')"><div><strong>自动硬件加速</strong><span>推荐</span></div><small>使用本机已通过实际检测的 Intel QSV</small></button><button data-testid="subtitle-acceleration-cpu-fast" :class="{ active: acceleration === 'cpu-fast' }" :disabled="busy" :aria-pressed="acceleration === 'cpu-fast'" @click="changeAcceleration('cpu-fast')"><div><strong>CPU 快速编码</strong><span>veryfast</span></div><small>明确使用 CPU，速度仍取决于分辨率</small></button></div><p class="setting-description">{{ acceleration === 'cpu-fast' ? '使用 CPU 的 veryfast 编码预设，比原先的 medium 更快。4K 仍需处理大量像素，实际速度见运行进度。' : '根据本机实际检测结果启用硬件解码与编码。加速不可用时会提示原因，不会自动切换为 CPU 编码。' }}</p></div>
            <div class="setting-section"><label class="setting-label" for="subtitle-resolution">输出分辨率</label><NSelect id="subtitle-resolution" v-model:value="resolution" data-testid="subtitle-resolution" :data-resolution="resolution" aria-label="输出分辨率" :options="resolutionOptions" :disabled="busy" size="small" /><p class="setting-description" :class="{ 'resolution-note': resolution === '1080p' }">{{ resolution === 'source' ? '保留原始宽高，4K 视频默认仍输出 4K；不会为了提速自动缩小画面。' : '主动降低到最高 1080p，可减少编码量；保留画面比例，较小视频不会放大。' }}</p></div>
            <div class="setting-section"><label class="setting-label">输出格式</label><div class="burn-format"><strong>MP4</strong><NTag size="small">H.264 / AAC · 8-bit</NTag></div><p class="setting-description">烧录视频输出为 8-bit，即使源视频为 10-bit 也会转换。字幕已写入画面，播放时无需开启字幕轨。</p></div>
          </template>
          <div v-else class="setting-section"><label class="setting-label">输出格式</label><div class="format-choices"><button :class="{ active: format === 'mkv' }" :disabled="busy" :aria-pressed="format === 'mkv'" @click="format = 'mkv'"><strong>MKV</strong><span>推荐</span></button><button :class="{ active: format === 'mp4' }" :disabled="busy" :aria-pressed="format === 'mp4'" @click="format = 'mp4'"><strong>MP4</strong><span>文本字幕</span></button></div><p class="setting-description">{{ format === 'mkv' ? '保留 ASS / SSA 字幕样式，更适合多音轨、特效字幕和原片收藏。' : '字幕转换为文本轨，部分样式会简化；原视频或音频编码不兼容 MP4 时会提示失败，可改用 MKV。' }}</p></div>
          <div class="setting-section destination-section"><label class="setting-label"><FolderOpen :size="15" />输出位置</label><div data-testid="subtitle-output" class="destination" :title="batch?.outputDirectory || scan?.outputDirectory"><strong>{{ scan || batch ? fileName(batch?.outputDirectory || scan!.outputDirectory) : '内嵌字幕处理+原目录名称' }}</strong><span>{{ batch?.outputDirectory || scan?.outputDirectory || '在视频所在目录下自动新建' }}</span></div><p class="setting-description">新视频集中放入此文件夹。已有同名文件会自动编号，避免覆盖。</p></div>
          <details class="advanced-settings"><summary><span>高级选项</span><span>编码 · 时间偏移</span></summary><div><label class="setting-label" for="subtitle-encoding">字幕编码</label><NSelect id="subtitle-encoding" v-model:value="encoding" :options="encodingOptions" :disabled="busy" size="small" /><p class="setting-description">通常保持自动；字幕出现乱码时可指定原文件的编码。</p><label class="setting-label" for="subtitle-offset">字幕时间偏移（秒）</label><NInputNumber id="subtitle-offset" v-model:value="offsetSeconds" :min="-3600" :max="3600" :precision="3" :step="0.5" :disabled="busy" size="small" placeholder="0" /><p class="setting-description">正数让字幕延后，负数让字幕提前。只影响输出视频。</p></div></details>
          </div>
          <div class="run-area">
            <div v-if="embedMode === 'burn' && acceleration === 'auto' && !encodingReady && !running" class="acceleration-warning"><span>{{ checkingHardware ? '正在验证硬件加速，可先选择视频并确认字幕。' : '自动加速当前不可用。请查看检测原因，或明确选择 CPU 快速编码后开始。' }}</span><NButton v-if="!checkingHardware" size="tiny" secondary :disabled="busy" @click="changeAcceleration('cpu-fast')">使用 CPU 快速编码</NButton></div>
            <template v-if="scan"><div class="ready-summary"><ListChecks :size="19" /><span>将处理 <strong>{{ readyRows.length }}</strong> 个视频</span></div><p v-if="unmatchedCount" class="run-warning">{{ unmatchedCount }} 个已勾选视频没有可用字幕，将跳过。可在左侧选轨或指定外挂。</p><p v-if="scanErrorCount" class="run-warning">{{ scanErrorCount }} 个视频读取失败，将跳过。可修复后重新扫描。</p><div v-if="embeddedSoftRows.length" class="source-mode-warning"><p>{{ embeddedSoftRows.length }} 个已勾选视频使用内置字幕，当前模式无法处理，开始按钮已暂停。请切回烧录，或取消这些项。</p><div><NButton size="tiny" secondary :disabled="busy" @click="changeMode('burn')">切回烧录</NButton><NButton size="tiny" quaternary :disabled="busy" @click="deselectEmbeddedSoftRows">取消这些项</NButton></div></div><p v-if="reviewCount" class="run-warning">{{ reviewCount }} 项字幕需要确认，请检查语言或文件是否对应。</p><p v-if="reusedSubtitles.size" class="run-warning">存在外挂字幕重复使用，请确认是否为同一内容。</p></template>
            <NButton data-testid="subtitle-start" type="primary" size="large" block :disabled="!canStart" :loading="starting" @click="startBatch()"><template #icon><NIcon :component="Play" /></template>{{ starting ? '正在启动' : running ? `${operationLabel(batch?.mode ?? embedMode)}中…` : embedMode === 'burn' ? '开始烧录字幕' : '开始内封字幕轨' }}</NButton>
            <NButton v-if="retryRows.length && !running" block secondary :disabled="busy || !ffmpeg.available || !encodingReady || embeddedSoftRows.length > 0" @click="startBatch(true)"><template #icon><NIcon :component="RotateCcw" /></template>重试失败 / 取消项（{{ retryRows.length }}）</NButton>
            <NButton v-if="batch && batch.status === 'running'" block secondary @click="openOutput"><template #icon><NIcon :component="FolderOpen" /></template>打开输出目录</NButton>
            <div v-if="!ffmpeg.available && !checkingFfmpeg" class="ffmpeg-warning"><span>{{ ffmpeg.message }}</span><NButton size="tiny" secondary :loading="checkingFfmpeg" @click="refreshFfmpeg">重新检测</NButton></div>
            <p class="run-footnote">{{ running ? '可以切换其他页签，任务会继续。停止时保留已完成的视频。' : '读取视频内字幕 / 匹配外挂文件 / 确认后烧录' }}</p>
          </div>
        </aside>
      </div>
    </div>
  </ToolPage>
</template>

<style scoped>
.subtitle-workspace { position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; gap: 10px; }
.workspace-columns { display: grid; grid-template-columns: minmax(0, 1fr) 290px; flex: 1; min-height: 0; gap: 18px; }
.matching-panel { display: flex; flex-direction: column; min-width: 0; min-height: 0; gap: 10px; }
.error-banner { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 12px; border: 1px solid var(--error-color); border-radius: 6px; background: var(--surface-muted); color: var(--error-color); overflow-wrap: anywhere; }
.scan-progress { display: flex; flex-direction: column; flex-shrink: 0; gap: 5px; padding: 8px 12px; border: 1px solid var(--row-divider); border-radius: 6px; background: var(--surface-muted); }
.scan-progress > div { display: flex; align-items: center; gap: 12px; min-width: 0; font-size: var(--ui-font-sm); }
.scan-progress strong { flex-shrink: 0; }
.scan-progress span { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--text-muted); }
.source-bar { display: flex; align-items: center; min-width: 0; gap: 10px; padding: 11px 12px; border: 1px solid var(--row-divider); border-radius: 7px; background: var(--surface-muted); }
.source-icon { display: grid; place-items: center; width: 36px; height: 36px; flex-shrink: 0; color: var(--accent-color); }
.source-copy { display: flex; flex: 1; flex-direction: column; min-width: 0; gap: 2px; }
.source-copy strong, .source-copy span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.source-copy strong { font-size: var(--ui-font-lg); }
.source-copy span { color: var(--text-muted); font-size: var(--ui-font-sm); }
.match-heading, .batch-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.match-heading > div, .batch-heading > div { display: flex; align-items: baseline; gap: 9px; flex-wrap: wrap; }
.match-heading > div > span, .scope-note, .batch-heading > div > span { color: var(--text-muted); font-size: var(--ui-font-sm); }
.list-controls { display: flex; gap: 8px; }
.list-controls > .n-input { flex: 1; }
.filter-select { width: 135px; flex-shrink: 0; }
.selection-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 1px 0; }
.selection-toolbar > div { display: flex; gap: 4px; }
.selection-count { margin-left: 5px; color: var(--text-muted); font-size: var(--ui-font-sm); }
.match-list { flex: 1; min-height: 100px; overflow-y: auto; border: 1px solid var(--row-divider); border-radius: 7px; }
.match-row { display: flex; align-items: flex-start; gap: 10px; padding: 13px 12px; border-bottom: 1px solid var(--row-divider); }
.match-row:last-child { border-bottom: 0; }
.match-row.is-selected { background: color-mix(in srgb, var(--active-background) 28%, var(--surface-color)); }
.row-select { padding-top: 1px; }
.row-content { display: flex; flex: 1; flex-direction: column; min-width: 0; gap: 8px; }
.video-line { display: flex; align-items: center; gap: 7px; min-width: 0; }
.video-line > svg { flex-shrink: 0; color: var(--text-muted); }
.video-line strong { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-weight: 600; }
.episode-tag { margin-left: auto; flex-shrink: 0; }
.subtitle-line { display: flex; align-items: center; gap: 7px; }
.subtitle-line > .n-select { flex: 1; min-width: 0; }
.pair-arrow { flex-shrink: 0; color: var(--text-muted); }
.match-explanation { display: flex; align-items: center; gap: 7px; min-width: 0; padding-left: 22px; font-size: var(--ui-font-xs); color: var(--text-muted); }
.match-explanation > span:not(.n-tag) { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.match-explanation > .reuse-warning { margin-left: auto; color: var(--warning-color); flex-shrink: 0; }
.font-hint, .row-warning { margin: 0; padding-left: 22px; font-size: var(--ui-font-xs); line-height: 1.6; overflow-wrap: anywhere; }
.font-hint { color: var(--text-muted); }
.row-warning { color: var(--warning-color); }
.row-result { display: flex; align-items: center; min-width: 0; gap: 6px; padding-left: 22px; font-size: var(--ui-font-sm); color: var(--text-muted); }
.row-result > .n-progress { flex: 1; max-width: 170px; }
.row-result > span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.row-telemetry { display: flex; flex-wrap: wrap; gap: 5px 12px; padding-left: 22px; font-size: var(--ui-font-xs); }
.row-telemetry > span { display: inline-flex; align-items: baseline; gap: 5px; min-width: 0; max-width: 100%; }
.row-telemetry small { color: var(--text-muted); font-size: inherit; flex-shrink: 0; }
.row-telemetry strong { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--text-color); font-size: inherit; font-weight: 500; }
.result-succeeded { color: var(--success-color); }
.result-failed { color: var(--error-color); }
.list-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 27px; font-size: var(--ui-font-sm); color: var(--text-muted); }
.list-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 190px; height: 100%; gap: 9px; padding: 24px; color: var(--text-muted); text-align: center; }
.list-empty strong { color: var(--text-color); }
.list-empty > span { font-size: var(--ui-font-sm); }
.welcome-state { display: flex; flex: 1; flex-direction: column; align-items: center; justify-content: center; gap: 24px; padding: 26px 10px; overflow-y: auto; }
.welcome-art { position: relative; display: grid; place-items: center; width: 88px; height: 88px; border-radius: 24px; color: var(--accent-color); background: var(--active-background); }
.welcome-art > span { position: absolute; right: -9px; bottom: -7px; display: grid; place-items: center; width: 40px; height: 35px; border: 3px solid var(--surface-color); border-radius: 10px; background: var(--chip-background); color: var(--chip-text); }
.welcome-copy { text-align: center; }
.welcome-copy h2 { margin: 0 0 10px; font-size: var(--ui-font-xxl); font-weight: 650; }
.welcome-copy p { margin: 0; line-height: 1.8; color: var(--text-muted); }
.source-choices { display: grid; grid-template-columns: 1fr 1fr; width: min(480px, 100%); gap: 12px; }
.source-choices > button { display: flex; flex-direction: column; align-items: flex-start; gap: 9px; padding: 18px; border: 1px solid var(--border-color); border-radius: 9px; background: var(--surface-color); color: var(--text-color); font: inherit; text-align: left; cursor: pointer; transition: border-color .15s, background .15s; }
.source-choices > button:hover { border-color: var(--accent-color); background: var(--active-background); }
.source-choices > button > svg { color: var(--accent-color); }
.source-choices > button > span { color: var(--text-muted); font-size: var(--ui-font-sm); }
.source-choices > button:disabled { cursor: default; opacity: .55; }
.drag-hint { display: flex; align-items: center; gap: 6px; color: var(--text-muted); font-size: var(--ui-font-sm); }
.welcome-steps { display: flex; align-items: center; gap: 15px; margin-top: 12px; color: var(--text-muted); font-size: var(--ui-font-sm); }
.welcome-steps > span { display: flex; align-items: center; gap: 7px; }
.welcome-steps i { display: grid; place-items: center; width: 21px; height: 21px; border: 1px solid var(--row-divider); border-radius: 50%; font-style: normal; }
.output-panel { display: flex; flex-direction: column; min-width: 0; min-height: 0; gap: 16px; overflow: hidden; padding: 5px 0 4px 18px; border-left: 1px solid var(--row-divider); }
.settings-scroll { display: flex; flex: 1; flex-direction: column; min-height: 0; gap: 18px; overflow-y: auto; padding-right: 3px; }
.settings-scroll > * { flex-shrink: 0; }
.settings-title { display: flex; align-items: center; gap: 8px; }
.settings-title > svg { color: var(--accent-color); }
.settings-title h2 { margin: 0; font-size: var(--ui-font-lg); }
.hardware-card { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; padding: 10px 11px; border: 1px solid var(--row-divider); border-radius: 7px; background: var(--surface-muted); }
.hardware-heading { display: flex; align-items: center; justify-content: space-between; gap: 5px; width: 100%; }
.hardware-heading > strong { min-width: 0; font-size: var(--ui-font-sm); overflow-wrap: anywhere; }
.hardware-device { color: var(--text-muted); font-size: var(--ui-font-xs); overflow-wrap: anywhere; }
.hardware-card p { margin: 0; color: var(--text-muted); font-size: var(--ui-font-xs); line-height: 1.6; overflow-wrap: anywhere; }
.hardware-card .hardware-warning { color: var(--warning-color); }
.preserve-note { display: flex; align-items: flex-start; gap: 9px; padding: 12px 11px; border-radius: 7px; background: var(--surface-muted); }
.preserve-note > svg { flex-shrink: 0; margin-top: 1px; color: var(--success-color); }
.preserve-note > div { display: flex; flex-direction: column; gap: 5px; }
.preserve-note strong { font-size: var(--ui-font-sm); }
.preserve-note span { color: var(--text-muted); font-size: var(--ui-font-sm); line-height: 1.65; }
.setting-section { display: flex; flex-direction: column; gap: 8px; }
.setting-label { display: flex; align-items: center; gap: 6px; font-size: var(--ui-font-sm); font-weight: 600; }
.mode-choices { display: flex; flex-direction: column; gap: 8px; }
.mode-choices > button { display: flex; flex-direction: column; gap: 5px; padding: 11px 12px; border: 1px solid var(--border-color); border-radius: 6px; background: var(--surface-color); color: var(--text-color); font: inherit; text-align: left; cursor: pointer; }
.mode-choices > button.active { border-color: var(--accent-color); background: var(--active-background); }
.mode-choices > button > div { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.mode-choices > button > div > span { font-size: var(--ui-font-xs); color: var(--text-muted); }
.mode-choices > button > small { color: var(--text-muted); font-size: var(--ui-font-sm); }
.mode-choices > button:disabled { cursor: default; }
.mode-description { line-height: 1.7; }
.burn-format { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 12px; border: 1px solid var(--row-divider); border-radius: 6px; background: var(--surface-muted); }
.format-choices { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.format-choices > button { display: flex; align-items: center; justify-content: space-between; gap: 5px; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; background: var(--surface-color); color: var(--text-color); font: inherit; cursor: pointer; }
.format-choices > button.active { border-color: var(--accent-color); background: var(--active-background); }
.format-choices > button > span { color: var(--text-muted); font-size: var(--ui-font-xs); }
.format-choices > button:disabled { cursor: default; }
.setting-description { margin: 0; color: var(--text-muted); font-size: var(--ui-font-sm); line-height: 1.65; }
.setting-description.resolution-note { color: var(--warning-color); }
.destination { display: flex; flex-direction: column; gap: 6px; padding: 11px; border: 1px dashed var(--border-color); border-radius: 6px; background: var(--surface-muted); overflow-wrap: anywhere; }
.destination strong { font-size: var(--ui-font-sm); font-weight: 600; }
.destination > span { color: var(--text-muted); font-size: var(--ui-font-xs); line-height: 1.55; }
.advanced-settings { padding: 11px 0; border-top: 1px solid var(--row-divider); border-bottom: 1px solid var(--row-divider); }
.advanced-settings summary { display: flex; align-items: center; justify-content: space-between; gap: 8px; cursor: pointer; font-size: var(--ui-font-sm); }
.advanced-settings summary > span:first-child { font-weight: 600; }
.advanced-settings summary > span:last-child { color: var(--text-muted); font-size: var(--ui-font-xs); }
.advanced-settings summary::after { content: '+'; color: var(--text-muted); font-size: var(--ui-font-lg); }
.advanced-settings[open] summary::after { content: '−'; }
.advanced-settings > div { display: flex; flex-direction: column; gap: 8px; margin-top: 14px; }
.advanced-settings > div .setting-label:not(:first-child) { margin-top: 7px; }
.run-area { display: flex; flex-shrink: 0; flex-direction: column; gap: 9px; margin-top: auto; padding-top: 12px; border-top: 1px solid var(--row-divider); }
.ready-summary { display: flex; align-items: center; gap: 8px; }
.ready-summary > svg { color: var(--accent-color); }
.ready-summary strong { color: var(--accent-color); font-size: var(--ui-font-lg); }
.run-warning { margin: 0; color: var(--warning-color); font-size: var(--ui-font-sm); line-height: 1.6; }
.source-mode-warning { display: flex; flex-direction: column; gap: 5px; color: var(--warning-color); font-size: var(--ui-font-sm); }
.source-mode-warning p { margin: 0; line-height: 1.6; }
.source-mode-warning > div { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.acceleration-warning { display: flex; flex-direction: column; align-items: flex-start; gap: 7px; color: var(--warning-color); font-size: var(--ui-font-sm); line-height: 1.6; }
.run-footnote { margin: 0; color: var(--text-muted); font-size: var(--ui-font-xs); line-height: 1.6; text-align: center; }
.ffmpeg-warning { display: flex; flex-direction: column; align-items: flex-start; gap: 7px; font-size: var(--ui-font-sm); color: var(--error-color); overflow-wrap: anywhere; }
.batch-panel { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--row-divider); border-radius: 7px; background: var(--surface-muted); }
.batch-summary { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 13px; font-size: var(--ui-font-sm); color: var(--text-muted); }
.success-count { color: var(--success-color); }
.failure-count { color: var(--error-color); }
.active-file { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; text-align: right; }
.active-telemetry { display: flex; flex-wrap: wrap; gap: 4px 12px; color: var(--text-muted); font-size: var(--ui-font-xs); }
.batch-restored { flex: 1; min-height: 0; }
.restored-queue { display: flex; flex: 1; flex-direction: column; min-height: 100px; overflow-y: auto; border-top: 1px solid var(--row-divider); }
.restored-queue > article { display: flex; align-items: center; gap: 10px; padding: 12px 0; border-bottom: 1px solid var(--row-divider); }
.restored-queue > article > div { display: flex; flex: 1; flex-direction: column; min-width: 0; gap: 3px; }
.restored-queue strong, .restored-queue span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.restored-queue > article > div > span { font-size: var(--ui-font-sm); }
.restored-queue .row-telemetry { padding-left: 0; padding-top: 5px; }
.restore-note { margin: 0; color: var(--text-muted); font-size: var(--ui-font-sm); }
.drop-overlay { position: absolute; inset: 0; z-index: 20; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; border: 2px dashed var(--accent-color); border-radius: 9px; color: var(--accent-color); background: color-mix(in srgb, var(--surface-color) 94%, transparent); pointer-events: none; }
.drop-overlay strong { font-size: var(--ui-font-xxl); }
.drop-overlay span { color: var(--text-muted); }
@media (max-width: 1150px) { .workspace-columns { grid-template-columns: minmax(0, 1fr) 260px; gap: 12px; } .output-panel { padding-left: 12px; } .reuse-warning { display: none; } .scope-note { display: none; } }
@media (max-height: 740px) and (min-width: 931px) { .matching-panel { gap: 6px; } .source-bar { padding: 8px 10px; } .match-list { min-height: 60px; } .batch-panel { gap: 6px; padding: 9px 10px; } .list-footer { min-height: 25px; } }
@media (max-width: 930px) { .workspace-columns { display: flex; flex-direction: column; overflow-y: auto; min-height: 0; } .matching-panel { min-height: 440px; flex-shrink: 0; } .output-panel { min-height: auto; overflow: visible; border-left: 0; border-top: 1px solid var(--row-divider); padding: 18px 2px 4px; gap: 16px; } .settings-scroll { display: grid; flex: none; grid-template-columns: 1fr 1fr; overflow: visible; gap: 16px; } .preserve-note { grid-column: 1 / -1; } .welcome-state { min-height: 460px; } .match-list { max-height: 500px; } .manual-label { display: none; } }
@media (max-width: 650px) { .source-choices { grid-template-columns: 1fr; } .settings-scroll { display: flex; } .selection-toolbar { flex-wrap: wrap; } .match-explanation { flex-wrap: wrap; } .match-explanation > span:not(.n-tag) { max-width: 100%; } .welcome-steps { gap: 8px; } }
</style>
