<script setup lang="ts">
/**
 * @module BrandHeroCanvas
 * 首页第一屏的粒子/星云背景。昂贵渐变预绘为离屏纹理，动画限制为 24 FPS；
 * Hero 离开视口、页面隐藏或系统要求减少动态效果时停止调度。SSR 安全，卸载
 * 时取消所有帧、观察器和监听器。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'

const canvas = ref<HTMLCanvasElement | null>(null)
let stop: (() => void) | undefined

interface GlowSprite {
  canvas: HTMLCanvasElement
  radius: number
}

interface Neb {
  x: number
  y: number
  r: number
  base: number
  c: string
  vx: number
  vy: number
  age: number
  life: number
  sprite: GlowSprite
}

interface Mote {
  x: number
  y: number
  px: number
  py: number
  r: number
  c: string
  tw: number
  vx: number
  vy: number
  sprite: GlowSprite
}

onMounted(() => {
  const cvs = canvas.value
  if (!cvs) return
  stop = start(cvs)
})

onBeforeUnmount(() => {
  stop?.()
  stop = undefined
})

function start(cvs: HTMLCanvasElement): () => void {
  const ctx = cvs.getContext('2d')
  if (!ctx) return () => {}

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
  const mobile = window.matchMedia('(max-width: 760px)')
  const rnd = (a: number, b: number) => a + Math.random() * (b - a)
  const pick = <T,>(a: readonly T[]): T => a[(Math.random() * a.length) | 0]
  const nebColors = ['43,58,84', '58,74,108', '70,66,122', '92,76,140', '50,104,118', '48,62,96', '74,70,120']
  const moteColors = ['255,255,255', '230,234,241', '194,203,219', '148,168,196', '110,134,166']
  const frameInterval = 1000 / 24

  let width = 1
  let height = 1
  let raf = 0
  let resizeRaf = 0
  let last = performance.now()
  let inViewport = true
  let pageVisible = !document.hidden
  let disposed = false
  let backdrop = document.createElement('canvas')
  const glowCache = new Map<string, GlowSprite>()
  const nebs: Neb[] = []
  const motes: Mote[] = []

  const glowSprite = (color: string, radius: number, middleAlpha: number): GlowSprite => {
    const bucket = Math.max(8, Math.round(radius / 12) * 12)
    const key = `${color}:${String(bucket)}:${String(middleAlpha)}`
    const cached = glowCache.get(key)
    if (cached) return cached

    const sprite = document.createElement('canvas')
    const size = bucket * 2
    sprite.width = size
    sprite.height = size
    const spriteCtx = sprite.getContext('2d')
    if (spriteCtx) {
      const gradient = spriteCtx.createRadialGradient(bucket, bucket, 0, bucket, bucket, bucket)
      gradient.addColorStop(0, `rgba(${color},1)`)
      gradient.addColorStop(0.55, `rgba(${color},${String(middleAlpha)})`)
      gradient.addColorStop(1, `rgba(${color},0)`)
      spriteCtx.fillStyle = gradient
      spriteCtx.fillRect(0, 0, size, size)
    }
    const value = { canvas: sprite, radius: bucket }
    glowCache.set(key, value)
    return value
  }

  const makeNeb = (initial = false): Neb => {
    const life = rnd(9, 24)
    const r = rnd(60, 210)
    const c = pick(nebColors)
    return {
      x: rnd(0, width),
      y: rnd(0, height),
      r,
      base: rnd(0.06, 0.16),
      c,
      vx: rnd(-0.05, 0.05),
      vy: rnd(-0.05, 0.05),
      age: initial ? rnd(0, life) : 0,
      life,
      sprite: glowSprite(c, r, 0.45),
    }
  }

  const makeMote = (): Mote => {
    const x = rnd(0, width)
    const y = rnd(0, height)
    const r = rnd(0.6, 1.5)
    const c = pick(moteColors)
    return {
      x,
      y,
      px: x,
      py: y,
      r,
      c,
      tw: rnd(0, Math.PI * 2),
      vx: rnd(-0.2, 0.2),
      vy: rnd(-0.2, 0.2),
      sprite: glowSprite(c, r + 5, 0.18),
    }
  }

  const rebuildBackdrop = () => {
    backdrop = document.createElement('canvas')
    backdrop.width = Math.ceil(width)
    backdrop.height = Math.ceil(height)
    const backdropCtx = backdrop.getContext('2d')
    if (!backdropCtx) return

    const radius = Math.max(width, height)
    backdropCtx.globalCompositeOperation = 'lighter'
    let gradient = backdropCtx.createRadialGradient(width * 0.3, height * 0.25, 0, width * 0.3, height * 0.25, radius * 0.7)
    gradient.addColorStop(0, 'rgba(40,60,90,.32)')
    gradient.addColorStop(1, 'rgba(40,60,90,0)')
    backdropCtx.fillStyle = gradient
    backdropCtx.fillRect(0, 0, width, height)
    gradient = backdropCtx.createRadialGradient(width * 0.72, height * 0.62, 0, width * 0.72, height * 0.62, radius * 0.66)
    gradient.addColorStop(0, 'rgba(52,52,88,.26)')
    gradient.addColorStop(1, 'rgba(52,52,88,0)')
    backdropCtx.fillStyle = gradient
    backdropCtx.fillRect(0, 0, width, height)
  }

  const rebuildParticles = () => {
    nebs.length = 0
    motes.length = 0
    const nebCount = Math.round(Math.min(24, Math.max(10, (width * height) / 70000)))
    const moteCount = Math.round(Math.min(90, Math.max(40, (width * height) / 14000)))
    for (let i = 0; i < nebCount; i++) nebs.push(makeNeb(true))
    for (let i = 0; i < moteCount; i++) motes.push(makeMote())
  }

  const draw = (now: number) => {
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = '#0A0A0C'
    ctx.fillRect(0, 0, width, height)
    ctx.globalCompositeOperation = 'lighter'
    ctx.drawImage(backdrop, 0, 0, width, height)

    for (const n of nebs) {
      const progress = Math.min(n.age / n.life, 1)
      const envelope = Math.sin(Math.PI * progress)
      const radius = n.r * (0.55 + 0.45 * envelope)
      ctx.globalAlpha = n.base * envelope
      ctx.drawImage(n.sprite.canvas, n.x - radius, n.y - radius, radius * 2, radius * 2)
    }

    for (const m of motes) {
      const twinkle = 0.6 + 0.4 * Math.sin(now * 0.002 + m.tw)
      const alpha = 0.42 * twinkle + 0.06
      const dx = m.x - m.px
      const dy = m.y - m.py
      if (dx * dx + dy * dy < 3600) {
        ctx.strokeStyle = `rgb(${m.c})`
        ctx.globalAlpha = alpha * 0.3
        ctx.lineWidth = m.r
        ctx.beginPath()
        ctx.moveTo(m.px, m.py)
        ctx.lineTo(m.x, m.y)
        ctx.stroke()
      }
      const glow = m.sprite.radius
      ctx.globalAlpha = alpha
      ctx.drawImage(m.sprite.canvas, m.x - glow, m.y - glow)
    }
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
  }

  const shouldAnimate = () => !disposed && inViewport && pageVisible && !reduced.matches

  const frame = (now: number) => {
    raf = 0
    if (!shouldAnimate()) return
    if (now - last < frameInterval) {
      raf = requestAnimationFrame(frame)
      return
    }

    const elapsed = Math.min(100, now - last)
    const dt = elapsed / 1000
    const step = elapsed / (1000 / 60)
    last = now
    const t = now * 0.0001
    for (const n of nebs) {
      n.age += dt
      n.x += n.vx * step
      n.y += n.vy * step
      if (n.x < -n.r) n.x = width + n.r
      if (n.x > width + n.r) n.x = -n.r
      if (n.y < -n.r) n.y = height + n.r
      if (n.y > height + n.r) n.y = -n.r
      if (n.age > n.life) Object.assign(n, makeNeb())
    }
    for (const m of motes) {
      const previousX = m.x
      const previousY = m.y
      const angle =
        Math.sin(m.x * 0.0013 + m.y * 0.0011 + t) * 2.2 +
        Math.cos(m.x * 0.0017 - m.y * 0.0009 - t * 1.3) * 1.7 +
        Math.sin(m.x * 0.0005 - m.y * 0.0004 + t * 0.7)
      m.vx += (Math.cos(angle) * 0.012 + rnd(-0.012, 0.012)) * step
      m.vy += (Math.sin(angle) * 0.012 + rnd(-0.012, 0.012)) * step
      m.vx *= Math.pow(0.988, step)
      m.vy *= Math.pow(0.988, step)
      m.x += m.vx * step
      m.y += m.vy * step
      let wrapped = false
      if (m.x < -10) { m.x = width + 10; wrapped = true } else if (m.x > width + 10) { m.x = -10; wrapped = true }
      if (m.y < -10) { m.y = height + 10; wrapped = true } else if (m.y > height + 10) { m.y = -10; wrapped = true }
      m.px = wrapped ? m.x : previousX
      m.py = wrapped ? m.y : previousY
    }
    draw(now)
    raf = requestAnimationFrame(frame)
  }

  const syncAnimation = () => {
    if (shouldAnimate()) {
      if (raf === 0) {
        last = performance.now() - frameInterval
        raf = requestAnimationFrame(frame)
      }
      return
    }
    cancelAnimationFrame(raf)
    raf = 0
  }

  const size = () => {
    width = Math.max(1, cvs.clientWidth || window.innerWidth)
    height = Math.max(1, cvs.clientHeight || window.innerHeight)
    const dprLimit = mobile.matches ? 1 : 1.5
    const dpr = Math.min(window.devicePixelRatio || 1, dprLimit)
    cvs.width = Math.round(width * dpr)
    cvs.height = Math.round(height * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    glowCache.clear()
    rebuildBackdrop()
    rebuildParticles()
    draw(performance.now())
    syncAnimation()
  }

  const onResize = () => {
    cancelAnimationFrame(resizeRaf)
    resizeRaf = requestAnimationFrame(size)
  }
  const onMotionChange = () => {
    if (inViewport && pageVisible) draw(performance.now())
    syncAnimation()
  }
  const onVisibilityChange = () => {
    pageVisible = !document.hidden
    if (pageVisible && inViewport) draw(performance.now())
    syncAnimation()
  }
  const onPointer = () => {
    for (const n of nebs) Object.assign(n, makeNeb(true))
    if (!shouldAnimate()) draw(performance.now())
  }

  const observer = typeof IntersectionObserver === 'undefined'
    ? undefined
    : new IntersectionObserver(([entry]) => {
        inViewport = entry?.isIntersecting ?? false
        if (inViewport && pageVisible) draw(performance.now())
        syncAnimation()
      })

  window.addEventListener('resize', onResize)
  document.addEventListener('visibilitychange', onVisibilityChange)
  cvs.addEventListener('pointerdown', onPointer)
  const legacyMotionQuery = typeof reduced.addEventListener !== 'function'
  if (legacyMotionQuery) reduced.addListener(onMotionChange)
  else reduced.addEventListener('change', onMotionChange)
  observer?.observe(cvs)

  size()

  return () => {
    disposed = true
    cancelAnimationFrame(raf)
    cancelAnimationFrame(resizeRaf)
    observer?.disconnect()
    window.removeEventListener('resize', onResize)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    cvs.removeEventListener('pointerdown', onPointer)
    if (legacyMotionQuery) reduced.removeListener(onMotionChange)
    else reduced.removeEventListener('change', onMotionChange)
  }
}
</script>

<template>
  <canvas ref="canvas" class="brand-hero-canvas" aria-hidden="true" />
</template>
