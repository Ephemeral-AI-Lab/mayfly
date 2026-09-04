<script setup lang="ts">
/**
 * @module MermaidDiagram
 * Client-only Mermaid renderer. The heavy runtime is loaded only when a page
 * containing a Mermaid fence mounts; theme changes invalidate stale renders.
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useData } from 'vitepress'

const props = defineProps<{ code: string }>()
const host = ref<HTMLElement | null>(null)
const state = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
const { isDark } = useData()
const diagramId = `mayfly-diagram-${Math.random().toString(36).slice(2)}`
let generation = 0

async function renderDiagram() {
  const element = host.value
  if (!element) return

  const currentGeneration = ++generation
  state.value = 'loading'
  try {
    const source = decodeURIComponent(props.code)
    const { default: mermaid } = await import('mermaid')
    if (currentGeneration !== generation || !host.value) return

    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: isDark.value ? 'dark' : 'neutral',
    })
    const rendered = await mermaid.render(`${diagramId}-${String(currentGeneration)}`, source)
    if (currentGeneration !== generation || !host.value) return

    element.innerHTML = rendered.svg
    rendered.bindFunctions?.(element)
    state.value = 'ready'
  } catch (error) {
    if (currentGeneration !== generation || !host.value) return
    element.textContent = decodeURIComponent(props.code)
    state.value = 'error'
    console.error('Unable to render Mermaid diagram', error)
  }
}

onMounted(() => void renderDiagram())
watch(isDark, () => void renderDiagram())
onBeforeUnmount(() => {
  generation++
})
</script>

<template>
  <div
    ref="host"
    class="mermaid-diagram"
    :data-state="state"
    :aria-busy="state === 'loading'"
  />
</template>
