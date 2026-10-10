import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { breaches, compareRuns, parsePerfArgs } from '../perf.mjs'
import { selfTimes, topFunctions } from '../scenarios/cpuprofile.mjs'
import { percentile, spanMetrics } from '../scenarios/metrics.mjs'
import { mad, mannWhitneyP, median, verdict } from '../scenarios/stats.mjs'

test('medians, the noise band, and the rank test', () => {
  assert.deepEqual([median([3, 1, 2]), median([4, 1, 2, 3]), median([])], [2, 2.5, null])
  assert.equal(mad([1, 2, 3, 4, 100]), 1)
  assert.ok(mannWhitneyP([1, 2, 3, 4, 5, 6, 7, 8], [11, 12, 13, 14, 15, 16, 17, 18]) < 0.01)
  assert.ok(mannWhitneyP([1, 2, 3, 4], [1, 2, 3, 4]) > 0.9)
  assert.equal(mannWhitneyP([1], [2, 3]), null)
})

test('a verdict needs a change beyond the threshold and the noise, confirmed by the rank test, or says it cannot tell', () => {
  assert.equal(verdict([10, 11, 10, 12, 11], [5, 6, 5, 5, 6]).verdict, 'regressed')
  assert.equal(verdict([5, 6, 5, 5, 6], [10, 11, 10, 12, 11]).verdict, 'improved')
  assert.equal(verdict([10, 11, 10], [5, 6, 5]).verdict, 'inconclusive')
  assert.equal(verdict([10, 10.5, 11, 10, 10.4], [10, 10.2, 10.8, 10.1, 10.6]).verdict, 'same')
  assert.equal(verdict([], [1]).verdict, 'unmeasured')
  assert.deepEqual(verdict([12, 12, 12, 12, 12], [10, 10, 10, 10, 10]).delta, 20)
})

test('a span reports CPU share, key quantiles, CPU per key, and its samples', () => {
  const span = spanMetrics({ name: 'type', wallMs: 1000, cpuMs: 50, frames: 10, bytes: 400, keys: [1, 2, 3, 4], memory: { rssKb: 1, hwmKb: 2 } })
  assert.deepEqual([span.cpuPct, span.keyP50Ms, span.keyP95Ms, span.cpuPerKeyMs, span.keySamples], [5, 3, 4, 12.5, [1, 2, 3, 4]])
  assert.equal(spanMetrics({ name: 'idle', wallMs: 4000, cpuMs: null, frames: 0, bytes: 0, keys: [], memory: { rssKb: null, hwmKb: null } }).keys, undefined)
  assert.equal(percentile([], 0.5), null)
})

test('ceilings match spans by name or prefix and scale with the slack', () => {
  const spans = [{ name: 'idle', cpuPct: 12 }, { name: 'nav /help', cpuPerKeyMs: 30 }, { name: 'type', keyP50Ms: null }]
  const ceilings = { 'idle': { cpuPct: 10 }, 'nav *': { cpuPerKeyMs: 12 }, 'type': { keyP50Ms: 10 } }
  assert.deepEqual(breaches(ceilings, spans), [{ span: 'idle', metric: 'cpuPct', value: 12, ceiling: 10 }, { span: 'nav /help', metric: 'cpuPerKeyMs', value: 30, ceiling: 12 }])
  assert.deepEqual(breaches(ceilings, spans, 3), [])
})

test('runs of two builds compare span by span, pooling every key of every run', () => {
  const run = (keySamples, cpuPerKeyMs) => ({ metrics: [{ name: 'type', keySamples, cpuPerKeyMs, cpuPct: 5, frames: 10, hwmKb: 1 }] })
  const fast = Array.from({ length: 20 }, (_, index) => 1 + index / 100)
  const slow = fast.map(value => value * 3)
  const [type] = compareRuns([run(slow, 6), run(slow, 6)], [run(fast, 2), run(fast, 2)])
  assert.equal(type.span, 'type')
  assert.equal(type.metrics.keyP50Ms.verdict, 'regressed')
  assert.equal(type.metrics.cpuPerKeyMs.verdict, 'inconclusive')
  assert.equal(type.metrics.frames.verdict, 'same')
})

test('the command line names perf scenarios, runs, a baseline, the ceilings, or profiles', () => {
  assert.deepEqual(parsePerfArgs(['--', 'perf-focus', '--runs', '5', '--against', 'HEAD~1', '--prof']).options, { names: ['perf-focus'], runs: 5, against: 'HEAD~1', assert: false, prof: true })
  assert.match(parsePerfArgs(['tour']).error, /not a perf scenario/u)
  assert.match(parsePerfArgs(['--runs', '0']).error, /--runs/u)
})

test('a CPU profile adds up self time per function, leaving idle time out', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mayfly-prof-'))
  try {
    writeFileSync(join(dir, 'a.cpuprofile'), JSON.stringify({
      nodes: [
        { id: 1, callFrame: { functionName: '(idle)', url: '', lineNumber: -1 } },
        { id: 2, callFrame: { functionName: 'paint', url: 'file:///x/core.js', lineNumber: 9 } },
        { id: 3, callFrame: { functionName: '', url: 'file:///x/a.js', lineNumber: 0 } },
      ],
      samples: [1, 2, 2, 3],
      timeDeltas: [0, 1000, 2000, 3000],
    }))
    const times = selfTimes(dir)
    assert.deepEqual([...times.entries()], [['paint core.js:10', 5], ['(anonymous) a.js:1', 3]])
    assert.deepEqual(topFunctions(times, new Map([['paint core.js:10', 1]]), 1), [{ fn: 'paint core.js:10', headMs: 5, baseMs: 1 }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
