<script setup lang="ts">
/**
 * @module BrandHero
 * 首页第一屏：单色 logo、Cinzel 大名、Cormorant 斜体标语、可复制的安装命令
 * 与行动按钮。视觉正典为品牌素材 final/hero.html；文案全部来自 frontmatter
 * 的 `brandHero` 块，logo 经 withBase() 解析以兼容 Pages base。hero 区域
 * 恒为近黑底，因此固定使用白色（light）变体 logo。
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import { useData, withBase } from 'vitepress'
import BrandHeroCanvas from './BrandHeroCanvas.vue'

interface BrandHeroAction {
  theme?: 'brand' | 'alt'
  text: string
  link: string
}

interface BrandHeroData {
  eyebrow?: string
  name?: string
  tagline?: string
  versionNote?: string
  install?: string
  copyLabel?: string
  copiedLabel?: string
  actions?: BrandHeroAction[]
}

const { frontmatter } = useData()

const hero = computed<BrandHeroData>(() => frontmatter.value.brandHero ?? {})
const markSrc = withBase('/brand/logo-light.svg')

const href = (link: string) => (/^https?:\/\//u.test(link) ? link : withBase(link))

const copied = ref(false)
let copyTimer: ReturnType<typeof setTimeout> | undefined

onBeforeUnmount(() => {
  if (copyTimer !== undefined) clearTimeout(copyTimer)
})

async function copyInstall() {
  const cmd = hero.value.install ?? ''
  try {
    await navigator.clipboard.writeText(cmd)
    copied.value = true
  } catch {
    // 剪贴板 API 不可用（非安全上下文等）时退化为隐藏 textarea 复制。
    const ta = document.createElement('textarea')
    ta.value = cmd
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try {
      document.execCommand('copy')
      copied.value = true
    } catch {}
    ta.remove()
  }
  if (copyTimer !== undefined) clearTimeout(copyTimer)
  copyTimer = setTimeout(() => {
    copied.value = false
  }, 1600)
}
</script>

<template>
  <section v-if="hero.name" class="brand-hero">
    <BrandHeroCanvas />
    <div class="brand-hero-inner">
      <p v-if="hero.eyebrow" class="brand-hero-eyebrow">{{ hero.eyebrow }}</p>
      <img class="brand-hero-mark" :src="markSrc" alt="Mayfly" width="120" height="120" />
      <h1 class="brand-hero-name">{{ hero.name }}</h1>
      <p v-if="hero.tagline" class="brand-hero-tag">{{ hero.tagline }}</p>
      <p v-if="hero.versionNote" class="brand-hero-version">{{ hero.versionNote }}</p>
      <div v-if="hero.install" class="brand-hero-install">
        <span class="brand-hero-prompt" aria-hidden="true">›</span>
        <code class="brand-hero-cmd"><span class="brand-hero-dollar" aria-hidden="true">$</span>{{ hero.install }}</code>
        <button type="button" class="brand-hero-copy" @click.stop.prevent="copyInstall">
          {{ copied ? hero.copiedLabel : hero.copyLabel }}
        </button>
      </div>
      <div v-if="hero.actions?.length" class="brand-hero-actions">
        <a
          v-for="action in hero.actions"
          :key="action.text"
          class="brand-hero-btn"
          :class="action.theme === 'alt' ? 'ghost' : 'primary'"
          :href="href(action.link)"
        >{{ action.text }}</a>
      </div>
    </div>
  </section>
</template>
