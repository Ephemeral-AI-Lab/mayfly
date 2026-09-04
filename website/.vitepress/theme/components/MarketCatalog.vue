<script setup>
import { computed, ref } from 'vue'
import { useData, withBase } from 'vitepress'
import catalog from '../../../market/catalog.json'

const query = ref('')
const surface = ref('all')
const source = ref('all')

const surfaces = [
  { id: 'all', label: '全部 / all' },
  { id: 'tui', label: 'TUI' },
  { id: 'web', label: 'Web' },
  { id: 'server', label: 'Server' },
]
const sources = [
  { id: 'all', label: '全部 / all' },
  { id: 'official', label: 'official' },
  { id: 'dsh', label: 'dsh' },
  { id: 'community', label: 'community' },
]

const { lang } = useData()
const english = computed(() => lang.value.toLowerCase().startsWith('en'))

const describe = entry => (!english.value && entry.descriptionZh) || entry.description
const entryLink = entry => withBase(`${english.value ? '/en' : ''}/market/p/${entry.id}/`)

const surfaceBadge = entry =>
  ['tui', 'web', 'server'].filter(key => entry.surfaces[key]).map(key => key.toUpperCase()).join('+') || '—'

const filtered = computed(() =>
  catalog.filter(entry => {
    if (surface.value !== 'all' && !entry.surfaces[surface.value]) return false
    if (source.value !== 'all' && entry.source !== source.value) return false
    const q = query.value.trim().toLowerCase()
    if (q === '') return true
    const corpus = [
      entry.id,
      entry.displayName,
      entry.description,
      entry.descriptionZh,
      ...(entry.provides.tools ?? []),
      ...(entry.provides.commands ?? []),
      entry.category,
      entry.author,
    ].filter(Boolean).join(' ').toLowerCase()
    return q.split(/\s+/).every(token => corpus.includes(token))
  }),
)
</script>

<template>
  <div class="market-catalog">
    <div class="filters">
      <input v-model="query" type="search" placeholder="搜索 id / 描述 / 工具 · search" aria-label="search plugins" />
      <select v-model="surface" aria-label="filter by surface">
        <option v-for="option in surfaces" :key="option.id" :value="option.id">{{ option.label }}</option>
      </select>
      <select v-model="source" aria-label="filter by source">
        <option v-for="option in sources" :key="option.id" :value="option.id">{{ option.label }}</option>
      </select>
    </div>
    <p class="count">{{ filtered.length }} / {{ catalog.length }}</p>
    <div class="cards">
      <a v-for="entry in filtered" :key="entry.id" :href="entryLink(entry)" class="card">
        <div class="head">
          <strong>{{ entry.displayName }}</strong>
          <span class="badges">
            <span class="badge" :data-source="entry.source">{{ entry.source }}</span>
            <span class="badge surface">{{ surfaceBadge(entry) }}</span>
            <span v-if="entry.status !== 'stable'" class="badge status">{{ entry.status }}</span>
          </span>
        </div>
        <p class="desc">{{ describe(entry) }}</p>
      </a>
    </div>
    <p v-if="filtered.length === 0" class="empty">没有匹配的插件 · no matching plugins</p>
  </div>
</template>

<style scoped>
.filters { display: flex; gap: 0.75rem; flex-wrap: wrap; margin: 0.5rem 0 0.25rem; }
.filters input { flex: 1 1 14rem; }
.count { color: var(--vp-c-text-2, #888); font-size: 0.85rem; margin: 0.25rem 0; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr)); gap: 0.75rem; margin-top: 0.5rem; }
.card { display: block; border: 1px solid var(--vp-c-border, #ddd); border-radius: 8px; padding: 0.75rem 0.9rem; text-decoration: none; color: inherit; transition: border-color 0.15s; }
.card:hover { border-color: var(--vp-c-brand, #3e8e7e); }
.head { display: flex; justify-content: space-between; gap: 0.5rem; align-items: baseline; flex-wrap: wrap; }
.badges { display: inline-flex; gap: 0.35rem; }
.badge { font-size: 0.7rem; border-radius: 999px; padding: 0.05rem 0.5rem; border: 1px solid var(--vp-c-border, #ddd); color: var(--vp-c-text-2, #888); }
.badge[data-source='official'] { color: var(--vp-c-brand, #3e8e7e); border-color: var(--vp-c-brand, #3e8e7e); }
.badge.surface { letter-spacing: 0; }
.badge.status { color: var(--vp-c-warning, #b8860b); border-color: var(--vp-c-warning, #b8860b); }
.desc { margin: 0.45rem 0 0; font-size: 0.86rem; color: var(--vp-c-text-2, #666); }
.empty { color: var(--vp-c-text-2, #888); }
</style>
