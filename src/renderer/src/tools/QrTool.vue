<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import { ClipboardPaste, Copy, Download, ImagePlus, Trash2 } from '@lucide/vue'
import { NButton, NIcon, NInput, NSpin, useMessage } from 'naive-ui'
import QRCode from 'qrcode'
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader'
import readerWasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url'
import ToolPage from '../components/ToolPage.vue'

const message = useMessage()
const source = ref('')
const canvas = ref<HTMLCanvasElement>()
const decodeImage = ref('')
const decodeName = ref('')
const decodedText = ref('')
const decodeError = ref('')
const decoding = ref(false)

prepareZXingModule({ overrides: { locateFile: () => readerWasmUrl } })

/** 输入变化时实时生成二维码。 */
watch(source, () => void renderQrCode(), { flush: 'post' })

/** 初次挂载时准备空画布。 */
onMounted(() => void renderQrCode())

/** 在固定 320 像素画布中生成二维码。 */
async function renderQrCode(): Promise<void> {
  await nextTick()
  const target = canvas.value
  if (!target) return
  if (!source.value) {
    const context = target.getContext('2d')
    context?.clearRect(0, 0, target.width, target.height)
    return
  }
  try {
    await QRCode.toCanvas(target, source.value, { width: 320, margin: 2, errorCorrectionLevel: 'M' })
  } catch (error) {
    message.error(`二维码生成失败：${formatError(error)}`)
  }
}

/** 把生成的二维码复制为 PNG 图片。 */
async function copyQrCode(): Promise<void> {
  if (!source.value || !canvas.value) return
  await window.electronApi.clipboard.writeImage(canvas.value.toDataURL('image/png'))
  message.success('二维码图片已复制')
}

/** 按三倍像素导出清晰 PNG。 */
async function saveQrCode(): Promise<void> {
  if (!source.value) return
  const exportCanvas = document.createElement('canvas')
  await QRCode.toCanvas(exportCanvas, source.value, { width: 960, margin: 2, errorCorrectionLevel: 'M' })
  const bytes = new Uint8Array(await (await fetch(exportCanvas.toDataURL('image/png'))).arrayBuffer())
  if (await window.electronApi.dialog.saveBinary('qrcode.png', bytes)) message.success('二维码已保存')
}

/** 通过系统选择框选择待解析图片。 */
async function chooseImage(): Promise<void> {
  const selected = await window.electronApi.dialog.openImage()
  if (selected) await decodeDataUrl(selected.dataUrl, selected.name)
}

/** 从系统剪贴板读取待解析图片。 */
async function pasteImage(): Promise<void> {
  const dataUrl = await window.electronApi.clipboard.readImage()
  if (!dataUrl) {
    message.warning('剪贴板中没有图片')
    return
  }
  await decodeDataUrl(dataUrl, '剪贴板图片')
}

/** 处理拖入的第一张图片。 */
async function handleDrop(event: DragEvent): Promise<void> {
  event.preventDefault()
  const file = [...event.dataTransfer?.files ?? []].find((item) => item.type.startsWith('image/'))
  if (!file) {
    message.warning('请拖入图片文件')
    return
  }
  await decodeDataUrl(await fileToDataUrl(file), file.name)
}

/** 使用 ZXing WASM 尝试旋转、反色和高精度解析。 */
async function decodeDataUrl(dataUrl: string, name: string): Promise<void> {
  decodeImage.value = dataUrl
  decodeName.value = name
  decodedText.value = ''
  decodeError.value = ''
  decoding.value = true
  try {
    const blob = await (await fetch(dataUrl)).blob()
    const image = await createImageBitmap(blob)
    const dimensions = `${image.width}×${image.height}`
    const results = await readBarcodes(blob, {
      formats: ['QRCode'],
      tryHarder: true,
      tryRotate: true,
      tryInvert: true,
      maxNumberOfSymbols: 1
    })
    image.close()
    if (results.length === 0 || !results[0].text) throw new Error(`没有识别到二维码，图片尺寸 ${dimensions}`)
    decodedText.value = results[0].text
  } catch (error) {
    decodeError.value = formatError(error)
  } finally {
    decoding.value = false
  }
}

/** 清空生成和解析区域。 */
function clearAll(): void {
  source.value = ''
  decodeImage.value = ''
  decodeName.value = ''
  decodedText.value = ''
  decodeError.value = ''
}

/** 复制解析出的文字。 */
async function copyDecodedText(): Promise<void> {
  await window.electronApi.clipboard.writeText(decodedText.value)
  message.success('解析结果已复制')
}

/** 把浏览器文件读取为 data URL。 */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

/** 把未知异常转换成简短文字。 */
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
</script>

<template>
  <ToolPage title="二维码">
    <template #actions>
      <NButton :disabled="!source" @click="copyQrCode"><template #icon><NIcon :component="Copy" /></template>复制图片</NButton>
      <NButton :disabled="!source" @click="saveQrCode"><template #icon><NIcon :component="Download" /></template>保存 PNG</NButton>
      <NButton secondary @click="clearAll"><template #icon><NIcon :component="Trash2" /></template>清空</NButton>
    </template>
    <div class="qr-layout">
      <section class="qr-generate">
        <h2>生成</h2>
        <NInput v-model:value="source" type="textarea" :rows="6" placeholder="输入文字、网址或任意内容" />
        <div class="qr-canvas-host" :class="{ empty: !source }">
          <canvas ref="canvas" width="320" height="320" />
          <span v-if="!source">输入内容后实时生成</span>
        </div>
      </section>
      <section class="qr-decode">
        <h2>解析</h2>
        <div class="qr-drop-zone" @click="chooseImage" @dragover.prevent @drop="handleDrop">
          <img v-if="decodeImage" :src="decodeImage" alt="待解析二维码" />
          <div v-else><NIcon :component="ImagePlus" :size="36" /><span>点击选择或拖入二维码图片</span></div>
        </div>
        <div class="qr-decode-actions">
          <NButton @click="chooseImage"><template #icon><NIcon :component="ImagePlus" /></template>选择图片</NButton>
          <NButton @click="pasteImage"><template #icon><NIcon :component="ClipboardPaste" /></template>粘贴图片</NButton>
        </div>
        <NSpin :show="decoding">
          <div class="qr-result" :class="{ error: decodeError }">
            <div><strong>{{ decodeError ? '解析失败' : '解析结果' }}</strong><span>{{ decodeName }}</span></div>
            <p>{{ decodeError || decodedText || '等待解析图片' }}</p>
            <NButton v-if="decodedText" size="small" @click="copyDecodedText"><template #icon><NIcon :component="Copy" /></template>复制文字</NButton>
          </div>
        </NSpin>
      </section>
    </div>
  </ToolPage>
</template>

<style scoped>
.qr-layout { display: grid; grid-template-columns: minmax(360px, 1fr) minmax(360px, 1fr); height: 100%; gap: 18px; overflow: auto; }
.qr-layout section { min-width: 0; }
.qr-layout h2 { margin: 0 0 10px; font-size: var(--ui-font-lg); }
.qr-canvas-host { position: relative; display: grid; place-items: center; width: min(100%, 360px); aspect-ratio: 1; margin: 16px auto; border: 1px solid var(--border-color); background: white; }
.qr-canvas-host canvas { width: min(90%, 320px); height: auto; aspect-ratio: 1; }
.qr-canvas-host > span { position: absolute; color: #6b7280; }
.qr-drop-zone { display: grid; place-items: center; height: 300px; overflow: hidden; border: 2px dashed var(--border-color); border-radius: 6px; background: var(--surface-muted); cursor: pointer; }
.qr-drop-zone img { max-width: 100%; max-height: 100%; object-fit: contain; }
.qr-drop-zone > div { display: flex; flex-direction: column; align-items: center; gap: 9px; color: var(--text-muted); }
.qr-decode-actions { display: flex; gap: 8px; margin: 10px 0; }
.qr-result { min-height: 112px; padding: 12px; border: 1px solid var(--border-color); border-radius: 5px; background: var(--surface-color); }
.qr-result > div { display: flex; justify-content: space-between; color: var(--text-muted); font-size: var(--ui-font-sm); }
.qr-result p { white-space: pre-wrap; overflow-wrap: anywhere; }
.qr-result.error { border-color: var(--error-color); color: var(--error-color); }
@media (max-width: 1000px) { .qr-layout { grid-template-columns: 1fr; } }
</style>
