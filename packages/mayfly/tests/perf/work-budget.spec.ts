/**
 * The work-budget gate. Each workload of docs/design/implementation-roadmap.md section 7.1 runs headless and its
 * counters must not exceed `budgets.json`. The budgets started at `baseline.json`, the work the pipeline did in slice 1.0,
 * and slice 1.1 lowered its workloads' rows to the section 7.1 figures; a budget may never rise above the baseline, and
 * the Phase 1 freeze (slice 1.11) fixed the final values. W1-slot and W4-slot, the node-slot workloads of slice 1.10a,
 * take their baseline rows from their first measurement; they gate with the same figures as W1 and W4, because the
 * footer and the conversation reach the screen through the node slot. `UPDATE_WORK_BASELINE=1` rewrites the baseline file after a deliberate change to the workloads.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MayflyWorkCounters } from '../../src/core/ui-work-counters.ts'
import { WORKLOADS, measureWorkload, swarmWorkload } from './workloads.ts'

const BASELINE = new URL('./baseline.json', import.meta.url)
const BUDGETS = new URL('./budgets.json', import.meta.url)
const COUNTERS = ['nodesValidated', 'unitsCompiled', 'rowsPainted', 'stringsMeasured'] as const
const read = (url: URL): Record<string, MayflyWorkCounters> => JSON.parse(readFileSync(url, 'utf8')) as Record<string, MayflyWorkCounters>
const environment = { advance: (milliseconds: number): void => { vi.advanceTimersByTime(milliseconds) } }
const measured: Record<string, MayflyWorkCounters> = {}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('work budgets', () => {
  it.each(WORKLOADS.map(workload => [workload.id, workload] as const))('%s stays within its budget', (id, workload) => {
    const counters = measureWorkload(workload, environment)
    measured[id] = counters
    if (process.env.UPDATE_WORK_BASELINE === '1') return
    const budget = read(BUDGETS)[id]!
    for (const counter of COUNTERS) expect(counters[counter], `${id} ${counter}`).toBeLessThanOrEqual(budget[counter])
  })

  it('never budgets more than the slice 1.0 baseline', () => {
    const baseline = read(BASELINE)
    const budgets = read(BUDGETS)
    expect(Object.keys(budgets)).toEqual(Object.keys(baseline))
    for (const id of Object.keys(baseline)) for (const counter of COUNTERS) expect(budgets[id]![counter], `${id} ${counter}`).toBeLessThanOrEqual(baseline[id]![counter])
  })

  it('gates W1 and W4 through the node slot with the figures of the direct path', () => {
    const budgets = read(BUDGETS)
    expect(WORKLOADS.map(workload => workload.id)).toEqual(expect.arrayContaining(['W1', 'W1-slot', 'W4', 'W4-slot']))
    for (const [direct, slot] of [['W1', 'W1-slot'], ['W4', 'W4-slot']] as const) {
      for (const counter of ['nodesValidated', 'unitsCompiled'] as const) expect(budgets[slot]![counter], `${slot} ${counter}`).toBeLessThanOrEqual(budgets[direct]![counter])
    }
    // Section 7.1: W1 validates and compiles one subtree (the entry and the row that holds it); W4 admits at most one item.
    expect(budgets.W1).toMatchObject({ nodesValidated: 2, unitsCompiled: 2, rowsPainted: 2 })
    expect(budgets.W4).toMatchObject({ nodesValidated: 1, unitsCompiled: 1, rowsPainted: 1 })
  })

  it('W6 does work in proportion to the panes that changed, not to the 32', () => {
    const one = measureWorkload(swarmWorkload(1), environment)
    for (const changed of [2, 4]) {
      const counters = measureWorkload(swarmWorkload(changed), environment)
      for (const counter of ['nodesValidated', 'unitsCompiled', 'rowsPainted'] as const) expect(counters[counter], `${String(changed)} panes ${counter}`).toBeLessThanOrEqual(one[counter] * changed)
    }
  })

  it('is deterministic', () => {
    for (const workload of WORKLOADS) expect(measureWorkload(workload, environment), workload.id).toEqual(measureWorkload(workload, environment))
  })

  it('rewrites the baseline on request', () => {
    if (process.env.UPDATE_WORK_BASELINE !== '1') return
    writeFileSync(BASELINE, `${JSON.stringify(Object.fromEntries(WORKLOADS.map(workload => [workload.id, measured[workload.id]])), null, 2)}\n`)
  })
})
