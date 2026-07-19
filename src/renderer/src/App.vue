<script setup lang="ts">
import { computed, ref, watchEffect } from 'vue'
import { Boxes, Code2, Palette } from '@lucide/vue'
import { NButton, NConfigProvider, NIcon, NMessageProvider, NTooltip } from 'naive-ui'
import { groupTools, tools } from './tools/registry'
import { useThemeStore } from './stores/theme'

const themeStore = useThemeStore()
const activeToolId = ref(tools[0].id)
const activeTool = computed(() => tools.find((tool) => tool.id === activeToolId.value) ?? tools[0])
const toolGroups = groupTools()

/**
 * 把当前风格同步到根节点，供全局 CSS 变量使用。
 */
watchEffect(() => {
  document.documentElement.dataset.style = themeStore.style
})
</script>

<template>
  <NConfigProvider abstract :theme-overrides="themeStore.themeOverrides">
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
          </footer>
        </aside>

        <section class="app-content">
          <KeepAlive :max="tools.length">
            <component :is="activeTool.component" :key="activeTool.id" />
          </KeepAlive>
        </section>
      </div>
    </NMessageProvider>
  </NConfigProvider>
</template>
