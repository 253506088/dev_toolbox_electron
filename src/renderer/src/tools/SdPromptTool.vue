<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Copy, Download, Languages, RefreshCw, Search, Trash2, X } from '@lucide/vue'
import { NButton, NIcon, NInput, NModal, NProgress, NSpin, useMessage } from 'naive-ui'
import draggable from 'vuedraggable'
import type { DictionaryProgress, DictionaryStatus } from '@shared/electron-api'
import { normalizeTagForLookup, parsePromptTags } from '@shared/sd-prompt'
import ToolPage from '../components/ToolPage.vue'
import { SdDictionaryClient, type DictionarySearchResult } from '../utils/sd-dictionary-client'

const message = useMessage()
const client = new SdDictionaryClient()
const dictionary = ref<Record<string, string>>({})
const status = ref<DictionaryStatus>({ builtInCount: 0, totalCount: 0, updating: false })
const loading = ref(true)
const promptInput = ref('')
const tags = ref<string[]>([])
const searchText = ref('')
const searchResults = ref<DictionarySearchResult[]>([])
const searching = ref(false)
const updateProgress = ref<DictionaryProgress>()
const translating = ref(false)
const translateDone = ref(0)
const translateFailed = ref(0)
const cancelTranslation = ref(false)
const editVisible = ref(false)
const editingIndex = ref(-1)
const editingValue = ref('')
let searchGeneration = 0
let stopProgress: (() => void) | undefined

const unknownCount = computed(() => tags.value.filter((tag) => !dictionary.value[normalizeTagForLookup(tag)]).length)
const updatePercent = computed(() => updateProgress.value?.percent ?? 0)

/** 首次进入时懒加载词典并建立 Worker 索引。 */
onMounted(async () => {
  stopProgress = window.electronApi.dictionary.onProgress((progress) => {
    updateProgress.value = progress
    status.value.updating = !['complete', 'cancelled', 'error'].includes(progress.stage)
  })
  await loadDictionary()
})

/** 页面销毁时释放 Worker 和 IPC 监听。 */
onBeforeUnmount(() => {
  stopProgress?.()
  client.dispose()
})

/** 搜索输入变化后执行有代次保护的异步搜索。 */
watch(searchText, async (query) => {
  const generation = ++searchGeneration
  if (!query.trim()) {
    searchResults.value = []
    return
  }
  searching.value = true
  const results = await client.search(query)
  if (generation === searchGeneration) searchResults.value = results
  searching.value = false
})

/** 从主进程读取分层合并词典并重建索引。 */
async function loadDictionary(): Promise<void> {
  loading.value = true
  try {
    const snapshot = await window.electronApi.dictionary.load()
    dictionary.value = snapshot.entries
    status.value = snapshot.status
    await client.initialize(snapshot.entries)
  } catch (error) {
    message.error(`加载 SD 词典失败：${formatError(error)}`)
  } finally {
    loading.value = false
  }
}

/** 解析批量提示词并去除重复标签。 */
function parseInput(): void {
  const parsed = parsePromptTags(promptInput.value)
  for (const tag of parsed) addTag(tag)
  promptInput.value = ''
}

/** 不区分大小写追加一个非空标签。 */
function addTag(tag: string): void {
  const normalized = tag.trim()
  if (!normalized || tags.value.some((item) => item.toLowerCase() === normalized.toLowerCase())) return
  tags.value.push(normalized)
}

/** 从搜索结果添加英文标签。 */
function addSearchResult(result: DictionarySearchResult): void {
  addTag(result.key)
  searchText.value = ''
  searchResults.value = []
}

/** 搜索框回车时优先添加首条匹配，没有匹配则在线翻译为新词条。 */
async function submitSearch(): Promise<void> {
  const source = searchText.value.trim()
  if (!source) return
  if (searchResults.value.length > 0) {
    addSearchResult(searchResults.value[0])
    return
  }
  try {
    const translated = await window.electronApi.dictionary.translateAndSave(source)
    if (translated) {
      dictionary.value[translated.key] = translated.value
      await client.initialize(dictionary.value)
      addTag(translated.key)
      searchText.value = ''
    } else {
      addTag(source)
      message.warning('在线翻译没有返回有效结果，已按原文加入')
    }
  } catch (error) {
    addTag(source)
    message.error(`在线翻译失败，已按原文加入：${formatError(error)}`)
  }
}

/** 为标签生成英文和中文对照显示。 */
function displayTag(tag: string): string {
  const translation = dictionary.value[normalizeTagForLookup(tag)]
  return translation ? `${tag} (${translation})` : tag
}

/** 打开标签编辑弹窗。 */
function openEdit(index: number): void {
  editingIndex.value = index
  editingValue.value = tags.value[index]
  editVisible.value = true
}

/** 保存标签编辑。 */
function saveEdit(): void {
  const value = editingValue.value.trim()
  if (value) tags.value[editingIndex.value] = value
  editVisible.value = false
}

/** 在当前标签前后插入一个空白占位并立即编辑。 */
function insertNear(offset: number): void {
  const index = editingIndex.value + offset
  tags.value.splice(index, 0, '新标签')
  editingIndex.value = index
  editingValue.value = '新标签'
}

/** 删除当前编辑标签。 */
function deleteEditingTag(): void {
  tags.value.splice(editingIndex.value, 1)
  editVisible.value = false
}

/** 依次翻译未识别词条，并允许中途取消。 */
async function translateUnknownTags(): Promise<void> {
  if (translating.value) return
  const unknown = tags.value.filter((tag) => !dictionary.value[normalizeTagForLookup(tag)])
  if (unknown.length === 0) {
    message.info('当前没有未识别标签')
    return
  }
  translating.value = true
  cancelTranslation.value = false
  translateDone.value = 0
  translateFailed.value = 0
  for (const tag of unknown) {
    if (cancelTranslation.value) break
    try {
      const translated = await window.electronApi.dictionary.translateAndSave(normalizeTagForLookup(tag))
      if (translated) {
        dictionary.value[translated.key] = translated.value
        if (/[\u3400-\u9fff]/.test(tag)) {
          const index = tags.value.indexOf(tag)
          if (index >= 0) tags.value[index] = translated.key
        }
        translateDone.value += 1
      } else translateFailed.value += 1
    } catch {
      translateFailed.value += 1
    }
  }
  await client.initialize(dictionary.value)
  translating.value = false
  message.info(`翻译结束：成功 ${translateDone.value}，失败 ${translateFailed.value}`)
}

/** 检查 GitHub 并在成功后替换内存索引。 */
async function updateDictionary(): Promise<void> {
  status.value.updating = true
  try {
    const snapshot = await window.electronApi.dictionary.checkAndUpdate()
    dictionary.value = snapshot.entries
    status.value = snapshot.status
    await client.initialize(snapshot.entries)
    message.success(updateProgress.value?.message ?? '词典更新完成')
  } catch (error) {
    message.error(`词典更新失败：${formatError(error)}`)
  } finally {
    status.value.updating = false
  }
}

/** 取消正在进行的 GitHub 更新。 */
async function cancelUpdate(): Promise<void> {
  await window.electronApi.dictionary.cancelUpdate()
}

/** 导出用户增量词典。 */
async function exportDictionary(): Promise<void> {
  if (await window.electronApi.dictionary.exportIncremental()) message.success('新增词典已导出')
}

/** 复制保持原顺序的英文提示词。 */
async function copyResult(): Promise<void> {
  await window.electronApi.clipboard.writeText(tags.value.join(', '))
  message.success('提示词已复制')
}

/** 把更新时间格式化为本地时间。 */
function formatUpdatedAt(value?: string): string {
  return value ? new Date(value).toLocaleString() : '尚未在线更新'
}

/** 把未知异常转换成人可读文字。 */
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
</script>

<template>
  <ToolPage title="SD 提示词">
    <template #actions>
      <div class="sd-search">
        <NInput v-model:value="searchText" clearable placeholder="搜索中文或英文标签，回车新增" @keyup.enter="submitSearch"><template #prefix><NIcon :component="Search" /></template></NInput>
        <div v-if="searchText" class="sd-search-results">
          <NSpin v-if="searching" size="small" />
          <button v-for="result in searchResults" :key="result.key" @click="addSearchResult(result)"><span>{{ result.key }}</span><b>{{ result.value }}</b></button>
          <div v-if="!searching && searchResults.length === 0">没有本地匹配，解析后可在线翻译</div>
        </div>
      </div>
      <NButton :loading="status.updating" @click="updateDictionary"><template #icon><NIcon :component="RefreshCw" /></template>检查/更新词典</NButton>
      <NButton v-if="status.updating" type="error" secondary @click="cancelUpdate">取消更新</NButton>
      <NButton @click="exportDictionary"><template #icon><NIcon :component="Download" /></template>导出新增词典</NButton>
    </template>
    <template #status><span class="status-text">{{ status.totalCount.toLocaleString() }} 词条</span></template>

    <NSpin :show="loading">
      <div class="sd-layout">
        <section class="sd-input-panel">
          <NInput v-model:value="promptInput" type="textarea" :rows="5" placeholder="例如：masterpiece, 1girl, (white background:1.2)" />
          <div class="sd-input-actions">
            <NButton type="primary" @click="parseInput">解析并加入</NButton>
            <NButton :loading="translating" :disabled="unknownCount === 0" @click="translateUnknownTags"><template #icon><NIcon :component="Languages" /></template>翻译未识别（{{ unknownCount }}）</NButton>
            <NButton v-if="translating" type="error" secondary @click="cancelTranslation = true">取消翻译</NButton>
            <NButton secondary type="error" @click="tags = []"><template #icon><NIcon :component="Trash2" /></template>清空</NButton>
          </div>
          <div v-if="translating" class="translation-status">已完成 {{ translateDone }}，失败 {{ translateFailed }}</div>
          <div class="dictionary-status">
            <span>内置 {{ status.builtInCount.toLocaleString() }} 条</span>
            <span>当前 {{ status.totalCount.toLocaleString() }} 条</span>
            <span>上次更新：{{ formatUpdatedAt(status.updatedAt) }}</span>
          </div>
          <div v-if="updateProgress" class="update-status">
            <NProgress v-if="updateProgress.percent !== null" type="line" :percentage="updatePercent" :height="8" :show-indicator="false" />
            <span>{{ updateProgress.message }}</span>
          </div>
        </section>

        <section class="sd-tags-panel">
          <div v-if="tags.length === 0" class="sd-empty">暂无标签</div>
          <draggable v-else v-model="tags" item-key="tag" class="tag-list" :animation="150">
            <template #item="{ element, index }">
              <button class="tag-chip" :class="{ unknown: !dictionary[normalizeTagForLookup(element)] }" @click="openEdit(index)">
                <span>{{ displayTag(element) }}</span>
                <NIcon :component="X" @click.stop="tags.splice(index, 1)" />
              </button>
            </template>
          </draggable>
        </section>

        <footer class="sd-footer"><strong>标签总数：{{ tags.length }}</strong><NButton type="primary" :disabled="tags.length === 0" @click="copyResult"><template #icon><NIcon :component="Copy" /></template>复制结果</NButton></footer>
      </div>
    </NSpin>
  </ToolPage>

  <NModal v-model:show="editVisible" preset="card" title="编辑标签" class="tag-edit-modal">
    <NInput v-model:value="editingValue" autofocus @keyup.enter="saveEdit" />
    <div class="tag-edit-actions"><NButton @click="insertNear(0)">在前插入</NButton><NButton @click="insertNear(1)">在后插入</NButton><NButton type="error" secondary @click="deleteEditingTag">删除</NButton><NButton type="primary" @click="saveEdit">保存</NButton></div>
  </NModal>
</template>

<style scoped>
.sd-search { position: relative; width: min(360px, 35vw); }
.sd-search-results { position: absolute; z-index: 20; top: calc(100% + 5px); left: 0; width: 100%; max-height: 330px; overflow: auto; border: var(--panel-border); border-radius: 5px; background: var(--surface-color); box-shadow: var(--panel-shadow); }
.sd-search-results button { display: flex; flex-direction: column; width: 100%; padding: 8px 10px; color: var(--text-color); border: 0; border-bottom: 1px solid var(--row-divider); background: transparent; text-align: left; cursor: pointer; }
.sd-search-results button:hover { background: var(--active-background); }
.sd-search-results b { color: var(--text-muted); font-size: var(--ui-font-xs); }
.sd-search-results > div { padding: 10px; color: var(--text-muted); font-size: var(--ui-font-sm); }
.sd-layout { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; height: 100%; min-height: 0; gap: 12px; }
.sd-input-panel { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 12px; }
.sd-input-actions { display: flex; flex-direction: column; gap: 7px; }
.translation-status, .dictionary-status, .update-status { color: var(--text-muted); font-size: var(--ui-font-sm); }
.dictionary-status { display: flex; gap: 16px; flex-wrap: wrap; }
.update-status { display: flex; flex-direction: column; gap: 4px; }
.sd-tags-panel { min-height: 0; overflow: auto; padding: 10px; border: 1px solid var(--border-color); border-radius: 5px; background: var(--surface-muted); }
.tag-list { display: flex; flex-wrap: wrap; align-content: flex-start; gap: 8px; min-height: 100%; }
.tag-chip { display: inline-flex; align-items: center; gap: 7px; max-width: 100%; min-height: 34px; padding: 5px 9px; color: var(--chip-text); border: 1px solid var(--success-color); border-radius: 5px; background: var(--chip-background); cursor: grab; }
.tag-chip span { overflow-wrap: anywhere; }
.tag-chip.unknown { color: var(--unknown-chip-text); border-color: var(--accent-color); background: var(--unknown-chip-background); }
.sd-empty { display: grid; place-items: center; height: 100%; color: var(--text-muted); }
.sd-footer { display: flex; align-items: center; justify-content: space-between; min-height: 48px; padding: 0 12px; border-top: 1px solid var(--border-color); }
.tag-edit-modal { width: min(520px, 92vw); }
.tag-edit-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
@media (max-width: 1050px) { .sd-input-panel { grid-template-columns: 1fr; } .sd-input-actions { flex-direction: row; flex-wrap: wrap; } }
</style>
