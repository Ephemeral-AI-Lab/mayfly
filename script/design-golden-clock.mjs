/**
 * @module script/design-golden-clock
 *
 * Preload for `docs/design/prototypes/ui-preview.mjs` that makes a run deterministic: `Date.now` is pinned, the
 * repaint interval never fires on its own, and the keys and clock steps in `GOLDEN_SCRIPT` are replayed as separate
 * stdin chunks right after the prototype has started. A `\x1e<index>\n` marker follows each step so the runner can
 * cut the output into one frame per step.
 *
 * `GOLDEN_SCRIPT` is a JSON array. A string is one key (sent alone, so a lone Esc is never merged with the next
 * key). A number advances the fake clock by that many milliseconds and runs one repaint tick, as the prototype's
 * 100 ms interval would.
 */

const base = Number(process.env.GOLDEN_BASE ?? 1700000000000)
let now = base
Date.now = () => now

let tick
globalThis.setInterval = callback => {
  tick = callback
  return 0
}

const steps = JSON.parse(process.env.GOLDEN_SCRIPT ?? '[]')
setImmediate(() => {
  steps.forEach((step, index) => {
    if (typeof step === 'number') {
      now += step
      tick?.()
    } else process.stdin.emit('data', Buffer.from(step))
    process.stdout.write(`\x1e${index}\n`)
  })
})
