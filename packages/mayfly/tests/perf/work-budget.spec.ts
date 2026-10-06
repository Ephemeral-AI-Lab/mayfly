/**
 * The work-budget gate. Each workload of docs/design/implementation-roadmap.md section 7.1 runs headless and its
 * counters must not exceed `budgets.json`. The budgets start at `baseline.json`, the work the pipeline did in slice 1.0,
 * and each engine part of slice 1.1 lowers its workloads' rows to the section 7.1 figure; a budget may never rise above the
 * baseline. W1-slot and W4-slot, the node-slot workloads of slice 1.10a, take their baseline rows from their first
 * measurement. `UPDATE_WORK_BASELINE=1` rewrites the baseline file after a deliberate change to the workloads.
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
