<script setup lang="ts">
/**
 * @module Layout
 * 站点布局：在默认主题之上为首页挂载品牌化第一屏（BrandHero，
 * home-hero-before 插槽）与能力列表（BrandFeatures，home-features-before
 * 插槽），并启用 hero → 第二屏的滚轮分页（brand-pager）。文档页不受影响。
 */
import DefaultTheme from 'vitepress/theme'
import BrandHero from './BrandHero.vue'
import BrandFeatures from './BrandFeatures.vue'
import { useBrandPager } from './brand-pager.ts'

const { Layout } = DefaultTheme

useBrandPager()
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
