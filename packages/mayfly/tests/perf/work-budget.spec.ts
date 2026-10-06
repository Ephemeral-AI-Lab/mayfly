/**
 * The work-budget gate. Each workload of docs/design/implementation-roadmap.md section 7.1 runs headless and its
 * counters are compared with `baseline.json`, the work the pipeline does today. Slice 1.1 turns these equalities into
 * the budgets of section 7.1; `UPDATE_WORK_BASELINE=1` rewrites the file after a deliberate change.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MayflyWorkCounters } from '../../src/core/ui-work-counters.ts'
import { WORKLOADS, measureWorkload } from './workloads.ts'

const BASELINE = new URL('./baseline.json', import.meta.url)
const environment = { advance: (milliseconds: number): void => { vi.advanceTimersByTime(milliseconds) } }
const measured: Record<string, MayflyWorkCounters> = {}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('work budgets', () => {
  it.each(WORKLOADS.map(workload => [workload.id, workload] as const))('%s counts the work of one step', (id, workload) => {
    const counters = measureWorkload(workload, environment)
    measured[id] = counters
    expect(counters.nodesValidated + counters.unitsCompiled + counters.rowsPainted).toBeGreaterThanOrEqual(0)
    if (process.env.UPDATE_WORK_BASELINE === '1') return
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, MayflyWorkCounters>
    expect(counters).toEqual(baseline[id])
  })

  it('is deterministic', () => {
    for (const workload of WORKLOADS) expect(measureWorkload(workload, environment), workload.id).toEqual(measureWorkload(workload, environment))
  })

  it('rewrites the baseline on request', () => {
    if (process.env.UPDATE_WORK_BASELINE !== '1') return
    writeFileSync(BASELINE, `${JSON.stringify(Object.fromEntries(WORKLOADS.map(workload => [workload.id, measured[workload.id]])), null, 2)}\n`)
  })
})
