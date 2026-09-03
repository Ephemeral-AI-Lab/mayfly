<script setup lang="ts">
/**
 * @module BrandFeatures
 * 首页第二屏：hero.html 正典的悬停切换式能力列表——左栏 Cormorant 标题行
 * （激活行转白，白→品牌紫下划线扫过），右栏 sticky 预览以统一终端相框
 * 展示该行对应的真实产品截图与描述。悬停/聚焦即切换预览；点击标题行在
 * 未激活时先激活（触屏首点不跳页），已激活时跳转到对应文档页。文案与
 * 截图全部来自 frontmatter 的 `brandFeatures` 块。
 */
import { computed, ref } from 'vue'
import { useData, withBase } from 'vitepress'

interface BrandFeatureItem {
  title: string
  details: string
  image: string
  alt: string
  caption?: string
  link: string
  linkText?: string
}

interface BrandFeaturesData {
  kicker?: string
  title?: string
  items?: BrandFeatureItem[]
}

const { frontmatter } = useData()
const features = computed<BrandFeaturesData>(() => frontmatter.value.brandFeatures ?? {})
const items = computed(() => features.value.items ?? [])

const active = ref(0)
const current = computed<BrandFeatureItem | undefined>(() => items.value[active.value])

function activate(index: number) {
  active.value = index
}

/** 触屏首点只切换预览，第二次点击才跟随链接；桌面悬停已激活则直接跳。 */
function select(index: number, event: MouseEvent) {
  if (index !== active.value) {
    event.preventDefault()
    activate(index)
  }
}
</script>

<template>
  <section v-if="items.length && current" class="brand-features">
    <p v-if="features.kicker" class="bf-kicker">{{ features.kicker }}</p>
    <h2 v-if="features.title" class="bf-title">{{ features.title }}</h2>
    <div class="bf-cols">
      <div class="bf-list">
        <a
          v-for="(item, index) in items"
          :key="item.title"
          class="bf-feat"
          :class="{ 'is-active': index === active }"
          :href="withBase(item.link)"
          @mouseenter="activate(index)"
          @focus="activate(index)"
          @click="select(index, $event)"
        >
          {{ item.title }}<span class="bf-u" aria-hidden="true" />
        </a>
      </div>
      <div class="bf-preview">
        <Transition name="bf-fade" mode="out-in">
          <div :key="current.title" class="bf-pane">
            <figure class="bf-shot">
              <div class="bf-chrome" aria-hidden="true">
                <span v-if="current.caption" class="bf-caption">{{ current.caption }}</span>
                <span class="bf-live" />
              </div>
              <img :src="withBase(current.image)" :alt="current.alt" decoding="async" />
            </figure>
            <p class="bf-desc">{{ current.details }}</p>
            <a v-if="current.linkText" class="bf-more" :href="withBase(current.link)">{{ current.linkText }}</a>
          </div>
        </Transition>
      </div>
    </div>
  </section>
</template>
