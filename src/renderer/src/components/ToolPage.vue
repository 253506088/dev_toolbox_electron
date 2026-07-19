<script setup lang="ts">
defineProps<{
  title: string
}>()
</script>

<template>
  <section class="tool-page">
    <header class="tool-header">
      <h1 class="tool-title">{{ title }}</h1>
      <div class="tool-actions">
        <slot name="actions" />
      </div>
      <slot name="status" />
    </header>
    <main class="tool-body">
      <slot />
    </main>
  </section>
</template>
