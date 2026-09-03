/**
 * @module brand-pager
 * 首页第一屏 → 第二屏的分页式滚动：在 hero 区段内向下滚一下滚轮直接
 * 翻到第二屏顶，在第二屏顶向上滚直接翻回 hero——一次翻页一整屏，而不
 * 是原生平滑滑行。只作用于首页（.brand-home 存在时）；第二屏内部与
 * 其后的滚动保持原生。触屏、键盘与 `prefers-reduced-motion` 不拦截。
 */
import { onBeforeUnmount, onMounted } from 'vue'

/** 翻页动画时长（ms）：足够短，读起来是"翻页"而非"滑行"。 */
const PAGE_DURATION = 380

/**
 * 在首页挂载滚轮分页。返回清理由组件卸载钩子接管。
 */
export function useBrandPager(): void {
  if (typeof window === 'undefined') return
  let raf = 0
  let animating = false

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)')

  const featuresTop = (): number =>
    document.querySelector<HTMLElement>('.brand-features')?.offsetTop ?? 0

  function animateTo(target: number): void {
    const start = window.scrollY
    const delta = target - start
    if (delta === 0) return
    animating = true
    const t0 = performance.now()
    const step = (now: number): void => {
      const k = Math.min(1, (now - t0) / PAGE_DURATION)
      // easeInOutCubic：起步快、收尾稳的整页翻动感。
      const e = k < 0.5 ? 4 * k * k * k : 1 - ((-2 * k + 2) ** 3) / 2
      window.scrollTo(0, start + delta * e)
      if (k < 1 && animating) raf = requestAnimationFrame(step)
      else animating = false
    }
    raf = requestAnimationFrame(step)
  }

  function onWheel(event: WheelEvent): void {
    if (document.querySelector('.brand-home') === null) return
    if (animating) {
      event.preventDefault()
      return
    }
    if (reduce.matches) return
    const top = featuresTop()
    if (top <= 0) return
    const y = window.scrollY
    if (event.deltaY > 0 && y < top - 2) {
      // hero 区段内的向下滚动：整页翻到第二屏顶。
      event.preventDefault()
      animateTo(top)
    } else if (event.deltaY < 0 && y > 0 && y <= top + 2) {
      // 第二屏顶（含 hero 区段内）的向上滚动：整页翻回 hero。
      event.preventDefault()
      animateTo(0)
    }
  }

  onMounted(() => {
    window.addEventListener('wheel', onWheel, { passive: false })
  })
  onBeforeUnmount(() => {
    window.removeEventListener('wheel', onWheel)
    animating = false
    if (raf !== 0) cancelAnimationFrame(raf)
  })
}
