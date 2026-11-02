/** Assertions on the real native probe's outcomes, independent from UI text. @module script/scenarios/split-audit */

import { existsSync, readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

export function readProbeAudit(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

export async function awaitProbeAudit(file, step) {
  const begin = performance.now()
  for (;;) {
    const entries = readProbeAudit(file)
    const starts = entries.filter(entry => entry.event === 'tool-start' && entry.label === step.label)
    if (starts.length > 1) throw new Error(`Native tool was invoked more than once: ${step.label}`)
    if (entries.some(entry => entry.event === step.event && entry.label === step.label && (step.outcome === undefined || entry.outcome === step.outcome))) return
    if (performance.now() - begin > 30_000) throw new Error(`Native audit did not arrive: ${step.event} ${step.label}${step.outcome === undefined ? '' : ` ${step.outcome}`}; observed ${JSON.stringify(entries)}`)
    await sleep(25)
  }
}
