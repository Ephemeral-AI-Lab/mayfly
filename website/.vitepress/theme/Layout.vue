<script setup lang="ts">
/**
 * @module Layout
 * 站点布局：在默认主题之上为首页挂载品牌化第一屏（BrandHero，
 * home-hero-before 插槽）与能力列表（BrandFeatures，home-features-before
 * 插槽）。滚动完全交给浏览器处理，文档页不受影响。
 */
import DefaultTheme from 'vitepress/theme'
import BrandHero from './BrandHero.vue'
import BrandFeatures from './BrandFeatures.vue'

const { Layout } = DefaultTheme
</script>

<template>
  <Layout>
    <template #home-hero-before>
      <BrandHero />
    </template>
    <template #home-features-before>
      <BrandFeatures />
    </template>
  </Layout>
</template>
