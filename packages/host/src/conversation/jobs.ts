/** Durable settled Job history owned by the native Session projection registry.
 * @module @ephemeral-ai/mayfly-host/conversation/jobs
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'

import type { MayflyJobHistory } from '../types.ts'

const jobSchema = z.object({
  id: z.string(), owner: z.string(), kind: z.string(), label: z.string(),
  startedAt: z.number(), finishedAt: z.number(),
  status: z.enum(['completed', 'killed', 'failed']), detail: z.string().optional(),
  output: z.object({ total: z.literal(0), earliest: z.literal(0) }),
})
const registrationSchema = z.object({ jobId: z.string(), owner: z.string(), kind: z.string(), label: z.string(), startedAt: z.number() })
const stateSchema = z.array(z.object({ registration: registrationSchema, job: jobSchema.optional() }))
type State = z.infer<typeof stateSchema>
const viewSchema: z.ZodType<MayflyJobHistory> = z.array(jobSchema)


interface Registration {
  readonly jobId: string
  readonly owner: string
  readonly kind: string
  readonly label: string
  readonly startedAt: number
}
interface Settlement extends Registration {
  readonly finishedAt: number
  readonly status: 'completed' | 'killed' | 'failed'
  readonly detail?: string
}

function fold(state: State, event: SessionEvent): State {
  const type: string = event.type
  if (type !== 'job/registered' && type !== 'job/settled') return state
  const data = event.data as unknown as Settlement
  const index = state.findIndex(row => row.registration.jobId === data.jobId)
  const source = type === 'job/registered' ? data : state[index]?.registration ?? data
  const registration = { jobId: source.jobId, owner: source.owner, kind: source.kind, label: source.label, startedAt: source.startedAt }
  const entry: State[number] = type === 'job/registered' ? { registration } : {
    registration,
    job: {
      id: registration.jobId, owner: registration.owner, kind: registration.kind, label: registration.label,
      startedAt: registration.startedAt, finishedAt: data.finishedAt, status: data.status,
      ...data.detail === undefined ? {} : { detail: data.detail },
      output: { total: 0, earliest: 0 },
    },
  }
  if (index < 0) return [...state, entry]
  const next = [...state]
  next[index] = entry
  return next
}

type JobsDefinition = Omit<ProjectionDefinition<'mayflyJobs', State>, 'wire'> & {
  wire: NonNullable<ProjectionDefinition<'mayflyJobs', State>['wire']>
}

const views = new WeakMap<State, MayflyJobHistory>()

/** Native immutable fold, replay/checkpoint schema and whole readonly Client snapshot. */
export const mayflyJobsProjectionDefinition: JobsDefinition = {
  key: 'mayflyJobs', stateVersion: 1, stateSchema,
  init: () => [], apply: fold,
  wire: { summary: false, viewSchema, view: state => {
    let view = views.get(state)
    if (view === undefined) {
      view = state.flatMap(row => row.job === undefined ? [] : [row.job])
      views.set(state, view)
    }
    return view
  } },
}
