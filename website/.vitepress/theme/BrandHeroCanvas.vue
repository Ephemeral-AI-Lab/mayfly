<script setup lang="ts">
/**
 * @module BrandHeroCanvas
 * 首页第一屏的粒子/星云背景。视觉正典为品牌素材 final/hero.html：
 * 近黑底色上漂移的加法混合星云与受流场驱动的尘埃粒子。SSR 安全
 * （仅在 onMounted 触碰 DOM），卸载时取消 rAF 并移除全部监听；
 * prefers-reduced-motion 下只绘制一帧静态画面，不启动动画循环。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'

const canvas = ref<HTMLCanvasElement | null>(null)
let stop: (() => void) | undefined

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
  const rnd = (a: number, b: number) => a + Math.random() * (b - a)
  const pick = <T,>(a: readonly T[]): T => a[(Math.random() * a.length) | 0]

  const NUCOL = ['43,58,84', '58,74,108', '70,66,122', '92,76,140', '50,104,118', '48,62,96', '74,70,120']
  const MOTECOL = ['#FFFFFF', '#E6EAF1', '#C2CBDB', '#94A8C4', '#6E86A6']

  let W = 0
  let H = 0
  let raf = 0
  let last = performance.now()

  const nebs: Neb[] = []
  const makeNeb = (): Neb => ({
    x: rnd(0, W),
    y: rnd(0, H),
    r: rnd(60, 230),
    base: rnd(0.06, 0.16),
    c: pick(NUCOL),
    vx: rnd(-0.05, 0.05),
    vy: rnd(-0.05, 0.05),
    age: 0,
    life: rnd(9, 24),
  })
  const rebuildNebs = () => {
    nebs.length = 0
    const count = Math.round(Math.min(60, Math.max(20, (W * H) / 46000)))
    for (let i = 0; i < count; i++) nebs.push(makeNeb())
  }

  const motes: Mote[] = []
  for (let i = 0; i < 150; i++) {
    motes.push({
      x: 0,
      y: 0,
      px: 0,
      py: 0,
      r: rnd(0.6, 1.6),
      c: pick(MOTECOL),
      tw: rnd(0, 6.28),
      vx: rnd(-0.2, 0.2),
      vy: rnd(-0.2, 0.2),
    })
  }

  const size = () => {
    W = cvs.clientWidth || window.innerWidth
    H = cvs.clientHeight || window.innerHeight
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    cvs.width = Math.round(W * dpr)
    cvs.height = Math.round(H * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    rebuildNebs()
    for (const m of motes) {
      m.x = rnd(0, W)
      m.y = rnd(0, H)
    }
    if (reduced.matches) draw(performance.now())
  }

  const draw = (now: number) => {
    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = '#0A0A0C'
    ctx.fillRect(0, 0, W, H)
    ctx.globalCompositeOperation = 'lighter'
    const a1 = Math.sin(now * 0.00016) * 90
    const a2 = Math.cos(now * 0.00013) * 80
    let g = ctx.createRadialGradient(W * 0.3 + a1, H * 0.25, 0, W * 0.3 + a1, H * 0.25, Math.max(W, H) * 0.7)
    g.addColorStop(0, 'rgba(40,60,90,.32)')
    g.addColorStop(1, 'rgba(40,60,90,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, W, H)
    g = ctx.createRadialGradient(W * 0.72 + a2, H * 0.62, 0, W * 0.72 + a2, H * 0.62, Math.max(W, H) * 0.66)
    g.addColorStop(0, 'rgba(52,52,88,.26)')
    g.addColorStop(1, 'rgba(52,52,88,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, W, H)
    for (const n of nebs) {
      const tt = Math.min(n.age / n.life, 1)
      const env = Math.sin(Math.PI * tt)
      const alp = n.base * env
      const cr = n.r * (0.55 + 0.45 * env)
      const rgb = `rgba(${n.c},`
      g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, cr)
      g.addColorStop(0, `${rgb}${alp.toFixed(3)})`)
      g.addColorStop(0.55, `${rgb}${(alp * 0.45).toFixed(3)})`)
      g.addColorStop(1, `${rgb}0)`)
      ctx.fillStyle = g
      ctx.fillRect(n.x - cr, n.y - cr, cr * 2, cr * 2)
    }
    for (const m of motes) {
      const tw = 0.6 + 0.4 * Math.sin(now * 0.002 + m.tw)
      const alpha = 0.42 * tw + 0.06
      const dx = m.x - m.px
      const dy = m.y - m.py
      if (dx * dx + dy * dy < 3600) {
        ctx.strokeStyle = m.c
        ctx.globalAlpha = alpha * 0.3
        ctx.lineWidth = m.r
        ctx.beginPath()
        ctx.moveTo(m.px, m.py)
        ctx.lineTo(m.x, m.y)
        ctx.stroke()
      }
      ctx.globalAlpha = alpha
      ctx.fillStyle = m.c
      ctx.shadowBlur = 6
      ctx.shadowColor = m.c
      ctx.beginPath()
      ctx.arc(m.x, m.y, m.r, 0, 7)
      ctx.fill()
    }
    ctx.shadowBlur = 0
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
  }

  const frame = (now: number) => {
    const dt = Math.min(40, now - last) / 1000
    last = now
    const t = now * 0.0001
    for (const n of nebs) {
      n.age += dt
      n.x += n.vx
      n.y += n.vy
      if (n.x < -n.r) n.x = W + n.r
      if (n.x > W + n.r) n.x = -n.r
      if (n.y < -n.r) n.y = H + n.r
      if (n.y > H + n.r) n.y = -n.r
      if (n.age > n.life) Object.assign(n, makeNeb())
    }
    for (const m of motes) {
      const px0 = m.x
      const py0 = m.y
      const ang =
        Math.sin(m.x * 0.0013 + m.y * 0.0011 + t) * 2.2 +
        Math.cos(m.x * 0.0017 - m.y * 0.0009 - t * 1.3) * 1.7 +
        Math.sin(m.x * 0.0005 - m.y * 0.0004 + t * 0.7)
      m.vx += Math.cos(ang) * 0.012 + rnd(-0.012, 0.012)
      m.vy += Math.sin(ang) * 0.012 + rnd(-0.012, 0.012)
      m.vx *= 0.988
      m.vy *= 0.988
      m.x += m.vx
      m.y += m.vy
      let wrap = false
      if (m.x < -10) { m.x = W + 10; wrap = true } else if (m.x > W + 10) { m.x = -10; wrap = true }
      if (m.y < -10) { m.y = H + 10; wrap = true } else if (m.y > H + 10) { m.y = -10; wrap = true }
      m.px = wrap ? m.x : px0
      m.py = wrap ? m.y : py0
    }
    draw(now)
    raf = requestAnimationFrame(frame)
  }

  const startLoop = () => {
    cancelAnimationFrame(raf)
    last = performance.now()
    raf = requestAnimationFrame(frame)
  }
  const stopLoop = () => {
    cancelAnimationFrame(raf)
    raf = 0
    draw(performance.now())
  }
  const onMotionChange = () => (reduced.matches ? stopLoop() : startLoop())
  const onResize = () => size()
  const onPointer = () => {
    for (const n of nebs) Object.assign(n, makeNeb())
    if (reduced.matches) draw(performance.now())
  }

  window.addEventListener('resize', onResize)
  window.addEventListener('pointerdown', onPointer)
  const legacyMotionQuery = typeof reduced.addEventListener !== 'function'
  if (legacyMotionQuery) reduced.addListener(onMotionChange)
  else reduced.addEventListener('change', onMotionChange)

  size()
  if (reduced.matches) draw(performance.now())
  else raf = requestAnimationFrame(frame)

  return () => {
    cancelAnimationFrame(raf)
    window.removeEventListener('resize', onResize)
    window.removeEventListener('pointerdown', onPointer)
    if (legacyMotionQuery) reduced.removeListener(onMotionChange)
    else reduced.removeEventListener('change', onMotionChange)
  }
}
</script>

<template>
  <canvas ref="canvas" class="brand-hero-canvas" aria-hidden="true" />
</template>
