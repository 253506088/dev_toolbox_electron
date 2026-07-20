<script setup lang="ts">
import { computed, ref, watchEffect } from 'vue'
import { Boxes, Code2, Moon, Palette, Settings, Sun } from '@lucide/vue'
import { NButton, NConfigProvider, NIcon, NMessageProvider, NTooltip } from 'naive-ui'
import { groupTools, tools } from './tools/registry'
import { useThemeStore } from './stores/theme'
import { useSettingsStore } from './stores/settings'
import GlobalReminder from './components/GlobalReminder.vue'
import AppSettingsModal from './components/AppSettingsModal.vue'

const themeStore = useThemeStore()
const settingsStore = useSettingsStore()
const activeToolId = ref(tools[0].id)
const settingsVisible = ref(false)
const activeTool = computed(() => tools.find((tool) => tool.id === activeToolId.value) ?? tools[0])
const toolGroups = groupTools()
const themeOverrides = computed(() => ({
  ...themeStore.themeOverrides,
  common: { ...themeStore.themeOverrides.common, ...settingsStore.naiveThemeOverrides.common }
}))

/**
 * 把当前风格和明暗模式同步到根节点，供全局 CSS 变量使用。
 */
watchEffect(() => {
  const root = document.documentElement
  root.dataset.style = themeStore.style
  root.dataset.colorMode = themeStore.colorMode
  root.style.colorScheme = themeStore.colorMode
})

/** 把界面字号换算成全局 CSS 变量，供自定义组件和布局共同缩放。 */
watchEffect(() => {
  const root = document.documentElement
  for (const [name, value] of Object.entries(settingsStore.uiCssVariables)) root.style.setProperty(name, value)
})
</script>

<template>
  <NConfigProvider abstract :theme="themeStore.naiveTheme" :theme-overrides="themeOverrides">
    <NMessageProvider placement="bottom-right">
      <div class="app-shell">
        <aside class="app-sidebar">
          <div class="brand">
            <span class="brand-mark"><Boxes :size="18" /></span>
            <span class="brand-title">开发者工具箱</span>
          </div>

          <nav class="tool-nav" aria-label="工具导航">
            <section v-for="group in toolGroups" :key="group.name">
              <div class="tool-group-label">{{ group.name }}</div>
              <button
                v-for="tool in group.items"
                :key="tool.id"
                class="tool-nav-button"
                :class="{ active: activeToolId === tool.id }"
                :aria-current="activeToolId === tool.id ? 'page' : undefined"
                @click="activeToolId = tool.id"
              >
                <component :is="tool.icon" :size="17" />
                <span class="tool-nav-label">{{ tool.name }}</span>
              </button>
            </section>
          </nav>

          <footer class="sidebar-footer">
            <NTooltip>
              <template #trigger>
                <NButton
                  quaternary
                  circle
                  tag="a"
                  href="https://github.com/253506088/dev_toolbox"
                >
                  <template #icon><NIcon :component="Code2" /></template>
                </NButton>
              </template>
              GitHub
            </NTooltip>
            <NTooltip>
              <template #trigger>
                <NButton quaternary circle @click="themeStore.toggleStyle">
                  <template #icon><NIcon :component="Palette" /></template>
                </NButton>
              </template>
              切换为{{ themeStore.isNeo ? '标准' : 'Neo' }}风格
            </NTooltip>
            <NTooltip>
              <template #trigger>
                <NButton quaternary circle :aria-label="themeStore.isDark ? '切换为亮色主题' : '切换为暗色主题'" @click="themeStore.toggleColorMode">
                  <template #icon><NIcon :component="themeStore.isDark ? Sun : Moon" /></template>
                </NButton>
              </template>
              切换为{{ themeStore.isDark ? '亮色' : '暗色' }}主题
            </NTooltip>
            <NTooltip>
              <template #trigger>
                <NButton quaternary circle aria-label="打开设置" @click="settingsVisible = true">
                  <template #icon><NIcon :component="Settings" /></template>
                </NButton>
              </template>
              设置
            </NTooltip>
          </footer>
        </aside>

        <section class="app-content">
          <KeepAlive :max="tools.length">
            <component :is="activeTool.component" :key="activeTool.id" />
          </KeepAlive>
        </section>
        <GlobalReminder />
        <AppSettingsModal v-model:show="settingsVisible" />
      </div>
    </NMessageProvider>
  </NConfigProvider>
</template>
