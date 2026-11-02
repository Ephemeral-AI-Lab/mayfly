/** Freeze presentation time during captures, then release it before real terminal input draining. @module script/scenarios/split-clock */

import { existsSync } from 'node:fs'
import './clock.mjs'

// pi-tui's drainInput uses Date.now for both idle and maximum drain deadlines.
// Leaving the capture clock frozen during teardown would make that loop infinite.
const releaseFile = process.env.MAYFLY_SPLIT_CLOCK_RELEASE
if (releaseFile !== undefined) {
  const timer = setInterval(() => {
    if (!existsSync(releaseFile)) return
    clearInterval(timer)
    globalThis.__mayflyClock.flow()
  }, 10)
  timer.unref()
}
