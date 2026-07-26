<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { FileOutput, FileText, Images, ScanText } from '@lucide/vue'
import {
  NButton,
  NCheckbox,
  NIcon,
  NInput,
  NInputNumber,
  NModal,
  NProgress,
  NRadioButton,
  NRadioGroup,
  useMessage
} from 'naive-ui'
import type { WechatDeepseekOcrConfig, WechatExportEvent, WechatOcrEngine } from '@shared/wechat-export'

const message = useMessage()
let unsubscribe: (() => void) | undefined

// —— MD 转 PDF ——
const pdfVisible = ref(false)
const pdfMarkdownPath = ref('')
const pdfOnlyScreens = ref(true)
const pdfImageWidth = ref(900)
const pdfJpegQuality = ref(80)
const pdfBusy = ref(false)
const pdfStatus = ref('')
const pdfResultPath = ref('')

// —— 图片瘦身 ——
const slimVisible = ref(false)
const slimDirectory = ref('')
const slimFormat = ref<'webp' | 'jpeg'>('webp')
const slimMaxWidth = ref(900)
const slimQuality = ref(80)
const slimBusy = ref(false)
const slimStatus = ref('')
const slimResultPath = ref('')

// —— OCR 转文稿 ——
const ocrVisible = ref(false)
const ocrMode = ref<'directory' | 'pdf'>('directory')
const ocrEngine = ref<WechatOcrEngine>('windows')
const dsBaseUrl = ref('http://127.0.0.1:11434/v1')
const dsModel = ref('deepseek-ocr')
const dsApiKey = ref('')
const DS_STORAGE_KEY = 'wechat-export.deepseek-ocr'
const DS_PRESETS = {
  ollama: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'deepseek-ocr', apiKey: '' },
  siliconflow: { baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-OCR', apiKey: '' }
} as const

/** 一键填充本地 Ollama 或硅基流动的接入参数。 */
function applyDsPreset(name: keyof typeof DS_PRESETS): void {
  const preset = DS_PRESETS[name]
  dsBaseUrl.value = preset.baseUrl
  dsModel.value = preset.model
  if (name === 'ollama') dsApiKey.value = ''
}
const ocrPdfPath = ref('')
const ocrDirectory = ref('')
const ocrBusy = ref(false)
const ocrStatus = ref('')
const ocrCurrent = ref(0)
const ocrTotal = ref(0)
const ocrResultPath = ref('')
let ocrCancelled = false
let ocrSessionId = ''

/** DeepSeek 引擎时返回配置并顺手持久化；本地引擎返回 undefined。 */
function deepseekConfig(): WechatDeepseekOcrConfig | undefined {
  if (ocrEngine.value !== 'deepseek') return undefined
  const config = { baseUrl: dsBaseUrl.value.trim(), apiKey: dsApiKey.value.trim(), model: dsModel.value.trim() }
  localStorage.setItem(DS_STORAGE_KEY, JSON.stringify({ ...config, engine: ocrEngine.value }))
  return config
}

function restoreDeepseekConfig(): void {
  try {
    const raw = localStorage.getItem(DS_STORAGE_KEY)
    if (!raw) return
    const saved = JSON.parse(raw) as Partial<WechatDeepseekOcrConfig & { engine: WechatOcrEngine }>
    if (typeof saved.baseUrl === 'string' && saved.baseUrl) dsBaseUrl.value = saved.baseUrl
    if (typeof saved.model === 'string' && saved.model) dsModel.value = saved.model
    if (typeof saved.apiKey === 'string') dsApiKey.value = saved.apiKey
    if (saved.engine === 'deepseek') ocrEngine.value = 'deepseek'
  } catch {
    // 忽略损坏的本地配置
  }
}

async function pickMarkdown(): Promise<void> {
  const path = await window.electronApi.wechatExport.pickMarkdown()
  if (path) pdfMarkdownPath.value = path
}

async function pickSlimDirectory(): Promise<void> {
  const path = await window.electronApi.wechatExport.pickDirectory()
  if (path) slimDirectory.value = path
}

async function pickOcrPdf(): Promise<void> {
  const path = await window.electronApi.wechatExport.pickPdf()
  if (path) ocrPdfPath.value = path
}

async function pickOcrDirectory(): Promise<void> {
  const path = await window.electronApi.wechatExport.pickDirectory()
  if (path) ocrDirectory.value = path
}

async function runMarkdownToPdf(): Promise<void> {
  if (!pdfMarkdownPath.value || pdfBusy.value) return
  pdfBusy.value = true
  pdfStatus.value = '正在处理...'
  pdfResultPath.value = ''
  try {
    const result = await window.electronApi.wechatExport.markdownToPdf({
      markdownPath: pdfMarkdownPath.value,
      onlyScreens: pdfOnlyScreens.value,
      imageWidth: pdfImageWidth.value,
      jpegQuality: pdfJpegQuality.value
    })
    pdfResultPath.value = result.pdfPath
    pdfStatus.value = `已生成 ${formatBytes(result.pdfBytes)}（${result.imageCount} 张图片）`
    message.success('PDF 已生成')
  } catch (error) {
    pdfStatus.value = formatError(error)
    message.error(pdfStatus.value)
  } finally {
    pdfBusy.value = false
  }
}

async function runSlimImages(): Promise<void> {
  if (!slimDirectory.value || slimBusy.value) return
  slimBusy.value = true
  slimStatus.value = '正在处理...'
  slimResultPath.value = ''
  try {
    const result = await window.electronApi.wechatExport.slimImages({
      inputDirectory: slimDirectory.value,
      format: slimFormat.value,
      maxWidth: slimMaxWidth.value,
      quality: slimQuality.value
    })
    slimResultPath.value = result.outputDirectory
    slimStatus.value = `完成 ${result.fileCount} 张：${formatBytes(result.inputBytes)} → ${formatBytes(result.outputBytes)}`
    message.success('图片瘦身完成')
  } catch (error) {
    slimStatus.value = formatError(error)
    message.error(slimStatus.value)
  } finally {
    slimBusy.value = false
  }
}

/** 目录模式：主进程后台执行，进度和结果通过事件回推。 */
async function runOcrDirectory(): Promise<void> {
  if (!ocrDirectory.value || ocrBusy.value) return
  ocrBusy.value = true
  ocrCancelled = false
  ocrStatus.value = '正在启动...'
  ocrResultPath.value = ''
  ocrCurrent.value = 0
  ocrTotal.value = 0
  try {
    const result = await window.electronApi.wechatExport.ocrDirectoryStart({
      directory: ocrDirectory.value,
      engine: ocrEngine.value,
      deepseek: deepseekConfig()
    })
    ocrSessionId = result.runId
    ocrTotal.value = result.fileCount
  } catch (error) {
    ocrStatus.value = formatError(error)
    message.error(ocrStatus.value)
    ocrBusy.value = false
  }
}

/** PDF 模式：用 pdfjs 在渲染层逐页光栅化，交给主进程做版面分析 + 本地 OCR。 */
async function runOcrPdf(): Promise<void> {
  if (!ocrPdfPath.value || ocrBusy.value) return
  ocrBusy.value = true
  ocrCancelled = false
  ocrStatus.value = '正在读取 PDF...'
  ocrResultPath.value = ''
  ocrCurrent.value = 0
  ocrTotal.value = 0
  try {
    const begin = await window.electronApi.wechatExport.ocrBegin({
      pdfPath: ocrPdfPath.value,
      engine: ocrEngine.value,
      deepseek: deepseekConfig()
    })
    ocrSessionId = begin.sessionId
    const pdfjs = await import('pdfjs-dist')
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
    const loadingTask = pdfjs.getDocument({ data: begin.pdfData })
    const document = await loadingTask.promise
    try {
      ocrTotal.value = document.numPages
      for (let pageNumber = 1; pageNumber <= document.numPages && !ocrCancelled; pageNumber += 1) {
        ocrStatus.value = `正在识别第 ${pageNumber}/${document.numPages} 页...`
        const page = await document.getPage(pageNumber)
        const baseViewport = page.getViewport({ scale: 1 })
        const scale = Math.min(3, 1600 / baseViewport.width)
        const viewport = page.getViewport({ scale })
        const canvas = window.document.createElement('canvas')
        canvas.width = Math.ceil(viewport.width)
        canvas.height = Math.ceil(viewport.height)
        const context = canvas.getContext('2d')
        if (!context) throw new Error('无法创建画布')
        await page.render({ canvas, canvasContext: context, viewport }).promise
        const blob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob((value) => (value ? resolve(value) : reject(new Error('页面导出失败'))), 'image/png')
        })
        const bytes = new Uint8Array(await blob.arrayBuffer())
        await window.electronApi.wechatExport.ocrPage(ocrSessionId, pageNumber - 1, bytes)
        ocrCurrent.value = pageNumber
        page.cleanup()
      }
    } finally {
      await loadingTask.destroy()
    }
    if (ocrCancelled) {
      await window.electronApi.wechatExport.ocrCancel(ocrSessionId)
      ocrStatus.value = '已取消'
    } else {
      const result = await window.electronApi.wechatExport.ocrFinish(ocrSessionId)
      ocrResultPath.value = result.transcriptPath
      ocrStatus.value = `文稿已生成，共 ${result.messageCount} 条消息`
      message.success('聊天文稿已生成')
    }
  } catch (error) {
    ocrStatus.value = formatError(error)
    message.error(ocrStatus.value)
    if (ocrSessionId) void window.electronApi.wechatExport.ocrCancel(ocrSessionId)
  } finally {
    ocrSessionId = ''
    ocrBusy.value = false
  }
}

function cancelOcr(): void {
  ocrCancelled = true
  ocrStatus.value = '正在取消...'
  if (ocrMode.value === 'directory' && ocrSessionId) void window.electronApi.wechatExport.ocrCancel(ocrSessionId)
}

function reveal(path: string): void {
  if (path) void window.electronApi.wechatExport.revealPath(path)
}

onMounted(() => {
  restoreDeepseekConfig()
  unsubscribe = window.electronApi.wechatExport.onEvent((event: WechatExportEvent) => {
    if (event.task === 'pdf' && pdfBusy.value) pdfStatus.value = event.message
    if (event.task === 'slim' && slimBusy.value) slimStatus.value = event.message
    if (event.task === 'ocr' && ocrBusy.value && ocrMode.value === 'directory') {
      ocrStatus.value = event.message
      if (event.current !== undefined) ocrCurrent.value = event.current
      if (event.total !== undefined) ocrTotal.value = event.total
      if (event.stage === 'complete') {
        ocrResultPath.value = event.resultPath ?? ''
        ocrBusy.value = false
        ocrSessionId = ''
        message.success('聊天文稿已生成')
      }
      if (event.stage === 'stopped' || event.stage === 'error') {
        ocrBusy.value = false
        ocrSessionId = ''
        if (event.stage === 'error') message.error(event.message)
      }
    }
  })
})

onUnmounted(() => unsubscribe?.())

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.round(bytes / 1024)} KB`
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
</script>

<template>
  <div class="export-tools">
    <NButton :disabled="pdfBusy" @click="pdfVisible = true">
      <template #icon><NIcon :component="FileOutput" /></template>
      MD 转 PDF
    </NButton>
    <NButton :disabled="ocrBusy" @click="ocrVisible = true">
      <template #icon><NIcon :component="ScanText" /></template>
      OCR 转聊天文稿
    </NButton>
    <NButton :disabled="slimBusy" @click="slimVisible = true">
      <template #icon><NIcon :component="Images" /></template>
      图片瘦身
    </NButton>

    <NModal v-model:show="pdfVisible" preset="card" title="Markdown 转 PDF" class="export-modal">
      <p class="modal-hint">嵌入图片会按宽度缩放并转 JPEG，体积远小于直接转换；默认跳过重复的“无缝长图”章节。</p>
      <button class="path-pick" :disabled="pdfBusy" :title="pdfMarkdownPath" @click="pickMarkdown">
        <FileText :size="16" />
        <span>{{ pdfMarkdownPath || '选择截图 Markdown 文件...' }}</span>
      </button>
      <div class="option-grid">
        <label>图片宽度<NInputNumber v-model:value="pdfImageWidth" :min="320" :max="2400" :step="100" :disabled="pdfBusy" /></label>
        <label>JPEG 质量<NInputNumber v-model:value="pdfJpegQuality" :min="30" :max="100" :step="5" :disabled="pdfBusy" /></label>
      </div>
      <NCheckbox v-model:checked="pdfOnlyScreens" :disabled="pdfBusy">只嵌入分屏图（跳过无缝长图）</NCheckbox>
      <div class="modal-actions">
        <NButton type="primary" :loading="pdfBusy" :disabled="!pdfMarkdownPath" @click="runMarkdownToPdf">开始转换</NButton>
        <NButton v-if="pdfResultPath" @click="reveal(pdfResultPath)">查看文件</NButton>
      </div>
      <p v-if="pdfStatus" class="modal-status">{{ pdfStatus }}</p>
    </NModal>

    <NModal v-model:show="ocrVisible" preset="card" title="OCR 转聊天文稿" class="export-modal">
      <p class="modal-hint">
        逐页版面分析：只识别聊天气泡里的文字，表情包、头像、图片和卡片杂讯用占位符代替，输出可直接发给
        AI 的 Markdown 文稿。使用 Windows 自带离线 OCR，当前针对浅色模式微信截图。
      </p>
      <NRadioGroup v-model:value="ocrMode" size="small" :disabled="ocrBusy">
        <NRadioButton value="directory">图片目录（推荐，识别原图更准）</NRadioButton>
        <NRadioButton value="pdf">PDF 文件</NRadioButton>
      </NRadioGroup>
      <p v-if="ocrMode === 'pdf'" class="modal-hint">注意：PDF 里的图片经过压缩再放大，识别精度低于直接使用截图目录（如 screenshots）。</p>
      <div class="engine-block">
        <span class="engine-label">识别引擎</span>
        <NRadioGroup v-model:value="ocrEngine" size="small" :disabled="ocrBusy">
          <NRadioButton value="windows">Windows 本地（免费离线）</NRadioButton>
          <NRadioButton value="deepseek">DeepSeek-OCR（本地/云端）</NRadioButton>
        </NRadioGroup>
        <template v-if="ocrEngine === 'deepseek'">
          <div class="preset-row">
            <span class="engine-label">快速填充</span>
            <NButton size="tiny" :disabled="ocrBusy" @click="applyDsPreset('ollama')">本地 Ollama</NButton>
            <NButton size="tiny" :disabled="ocrBusy" @click="applyDsPreset('siliconflow')">硅基流动</NButton>
          </div>
          <label class="engine-field">接口地址<NInput v-model:value="dsBaseUrl" placeholder="http://127.0.0.1:11434/v1" :disabled="ocrBusy" /></label>
          <label class="engine-field">模型名称<NInput v-model:value="dsModel" placeholder="deepseek-ocr" :disabled="ocrBusy" /></label>
          <label class="engine-field">API Key<NInput v-model:value="dsApiKey" type="password" show-password-on="click" placeholder="本地 Ollama 留空；云端服务必填" :disabled="ocrBusy" /></label>
          <p class="modal-hint">
            本地部署：升级 Ollama 至 0.13+ 后执行 <code>ollama pull deepseek-ocr</code>（6.7GB），点上方"本地
            Ollama"即可，无需联网调用；也兼容自建 vLLM 或硅基流动等云端 OpenAI 兼容接口（按量计费）。
          </p>
        </template>
      </div>
      <button v-if="ocrMode === 'directory'" class="path-pick" :disabled="ocrBusy" :title="ocrDirectory" @click="pickOcrDirectory">
        <Images :size="16" />
        <span>{{ ocrDirectory || '选择截图目录（如输出目录下的 screenshots）...' }}</span>
      </button>
      <button v-else class="path-pick" :disabled="ocrBusy" :title="ocrPdfPath" @click="pickOcrPdf">
        <FileText :size="16" />
        <span>{{ ocrPdfPath || '选择 PDF 文件...' }}</span>
      </button>
      <div class="modal-actions">
        <NButton
          v-if="!ocrBusy"
          type="primary"
          :disabled="ocrMode === 'directory' ? !ocrDirectory : !ocrPdfPath"
          @click="ocrMode === 'directory' ? runOcrDirectory() : runOcrPdf()"
        >开始识别</NButton>
        <NButton v-else type="error" @click="cancelOcr">取消</NButton>
        <NButton v-if="ocrResultPath" @click="reveal(ocrResultPath)">查看文稿</NButton>
      </div>
      <NProgress
        v-if="ocrBusy && ocrTotal > 0"
        type="line"
        :percentage="Math.round((ocrCurrent / ocrTotal) * 100)"
        :height="6"
      />
      <p v-if="ocrStatus" class="modal-status">{{ ocrStatus }}</p>
    </NModal>

    <NModal v-model:show="slimVisible" preset="card" title="图片瘦身" class="export-modal">
      <p class="modal-hint">把目录里的截图批量缩放并转成 WebP/JPEG，输出到同级“_瘦身”目录，适合直接上传给 AI。</p>
      <button class="path-pick" :disabled="slimBusy" :title="slimDirectory" @click="pickSlimDirectory">
        <Images :size="16" />
        <span>{{ slimDirectory || '选择图片目录...' }}</span>
      </button>
      <div class="option-grid">
        <label>最大宽度<NInputNumber v-model:value="slimMaxWidth" :min="320" :max="4000" :step="100" :disabled="slimBusy" /></label>
        <label>压缩质量<NInputNumber v-model:value="slimQuality" :min="30" :max="100" :step="5" :disabled="slimBusy" /></label>
      </div>
      <NRadioGroup v-model:value="slimFormat" size="small" :disabled="slimBusy">
        <NRadioButton value="webp">WebP（更小）</NRadioButton>
        <NRadioButton value="jpeg">JPEG（兼容）</NRadioButton>
      </NRadioGroup>
      <div class="modal-actions">
        <NButton type="primary" :loading="slimBusy" :disabled="!slimDirectory" @click="runSlimImages">开始压缩</NButton>
        <NButton v-if="slimResultPath" @click="reveal(slimResultPath)">查看目录</NButton>
      </div>
      <p v-if="slimStatus" class="modal-status">{{ slimStatus }}</p>
    </NModal>
  </div>
</template>

<style scoped>
.export-tools { display: flex; flex-direction: column; gap: 8px; }
.export-modal { width: min(560px, 94vw); }
.export-modal .modal-hint { margin: 0 0 12px; color: var(--text-muted); font-size: var(--ui-font-sm); line-height: 1.6; }
.export-modal .path-pick { display: flex; align-items: center; width: 100%; min-height: 36px; gap: 8px; padding: 6px 10px; margin-bottom: 12px; border: 1px solid var(--border-color); border-radius: 4px; color: var(--text-color); background: transparent; cursor: pointer; }
.export-modal .path-pick:hover:not(:disabled) { border-color: var(--accent-color); }
.export-modal .path-pick:disabled { cursor: not-allowed; opacity: .55; }
.export-modal .path-pick span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.export-modal .option-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px; }
.export-modal .option-grid label { display: flex; flex-direction: column; gap: 5px; color: var(--text-muted); font-size: var(--ui-font-sm); font-weight: 700; }
.export-modal .modal-actions { display: flex; align-items: center; gap: 10px; margin-top: 14px; }
.export-modal .modal-status { margin: 10px 0 0; color: var(--text-muted); font-size: var(--ui-font-sm); word-break: break-all; }
.export-modal .n-radio-group { margin: 2px 0 12px; }
.export-modal .engine-block { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; margin-bottom: 12px; border: 1px solid var(--border-color); border-radius: 5px; }
.export-modal .engine-block .n-radio-group { margin: 0; }
.export-modal .engine-label { color: var(--text-muted); font-size: var(--ui-font-sm); font-weight: 700; }
.export-modal .engine-field { display: flex; flex-direction: column; gap: 4px; color: var(--text-muted); font-size: var(--ui-font-sm); font-weight: 700; }
.export-modal .preset-row { display: flex; align-items: center; gap: 8px; }
.export-modal .modal-hint code { padding: 1px 5px; border-radius: 3px; background: var(--border-color); font-size: 0.92em; }
</style>
