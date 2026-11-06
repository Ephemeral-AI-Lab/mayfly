/**
 * The base every tool block is drawn from. A kind is a descriptor: the base states what any tool does (a line named by the
 * tool, merged into a run with its neighbours of the same kind, a plain wait while it runs), and a category overrides the
 * parts that differ. Edit and Write stream their input and never merge; Read, Search, and the web tools name their target
 * in the head of a run. The blocks themselves (`tool-calls`) take every phrase, label, and rule from here, so a new tool
 * is a row in this table and a body builder. Pure data; callers pass their own translator.
 *
 * @module @ephemeral-ai/mayfly/transcript/tool-kinds
 */

import type { MayflyTranslate } from '../frontend/locale.ts'
import type { ProcessActivity } from '../frontend/models.ts'

/** The bottom view that owns what a call starts or changes, so the stream need not repeat it. */
export type ToolOwner = 'agents' | 'jobs' | 'workflow' | 'todo' | 'goal'

/**
 * Where a call is drawn: `full` is a record with a body; `line` is one line, its detail its view's; `quiet` is drawn only at
 * the Verbose tier; `hidden` is never drawn. A call that failed or waits on the user is drawn whatever its placement.
 */
export type ToolPlacement = 'full' | 'line' | 'quiet' | 'hidden'

/** What one category of tool does in the stream. */
interface ToolKind {
  /** Whether the head of a run names what the calls did, so a call's line in the run is just its target. */
  readonly headed: boolean
  /** The tool's own name, for the head of a group whose calls are not all of one tool (`Read`, `WebSearch`). */
  readonly title: string
  /** What a group counts of the category: one call, several calls (identity English keys). */
  readonly unit: readonly [one: string, many: string]
  /** The activity row's present-tense label while a call of the kind runs (an identity English key). */
  readonly running: string
  /** The same while the call's arguments still stream. */
  readonly preparing: string
  /** Whether consecutive calls of the kind share a run at the standard tier. */
  readonly mergeable: boolean
  /** Whether the call's input grows in its block while the model writes it (a file change). */
  readonly streams: boolean
  /** The view that owns the category's detail: its calls have no body, and no clock while they run. */
  readonly owner?: ToolOwner
  readonly placement: ToolPlacement
}

const BASE: ToolKind = {
  headed: false,
  title: 'Tools',
  unit: ['{count} call', '{count} calls'],
  running: 'Calling tools',
  preparing: 'Preparing tool calls',
  mergeable: true,
  streams: false,
  placement: 'full',
}

/** The plan's calls, which the todo and goal views and the durable goal rows say in full. */
const PLAN_KIND: Partial<ToolKind> = { placement: 'hidden', mergeable: false, title: 'Plan', unit: ['{count} update', '{count} updates'], running: 'Updating the plan', preparing: 'Preparing to update the plan' }

/** The categories that differ from the base. Searches, code runs, web searches, and plan updates name no object, so their phrase counts the times. */
const OVERRIDES: Readonly<Record<ProcessActivity, Partial<ToolKind>>> = {
  read: { headed: true, title: 'Read', unit: ['{count} file', '{count} files'], running: 'Reading files', preparing: 'Preparing to read files' },
  readImage: { headed: true, title: 'Read', unit: ['{count} image', '{count} images'], running: 'Reading images', preparing: 'Preparing to read images' },
  write: { mergeable: false, streams: true, title: 'Write', unit: ['{count} file', '{count} files'], running: 'Writing files', preparing: 'Preparing to write files' },
  search: { headed: true, title: 'Search', unit: ['{count} search', '{count} searches'], running: 'Searching code', preparing: 'Preparing to search code' },
  edit: { mergeable: false, streams: true, title: 'Edit', unit: ['{count} file', '{count} files'], running: 'Editing files', preparing: 'Preparing to edit files' },
  commands: { headed: true, title: 'Bash', unit: ['{count} call', '{count} calls'], running: 'Running commands', preparing: 'Preparing to run commands' },
  code: { headed: true, title: 'RunCode', unit: ['{count} run', '{count} runs'], running: 'Running code', preparing: 'Preparing to run code' },
  webSearch: { headed: true, title: 'WebSearch', unit: ['{count} search', '{count} searches'], running: 'Searching the web', preparing: 'Preparing to search the web' },
  webFetch: { headed: true, title: 'WebFetch', unit: ['{count} page', '{count} pages'], running: 'Visiting web pages', preparing: 'Preparing to visit web pages' },
  subagents: { owner: 'agents', placement: 'line', title: 'Subagent', unit: ['{count} subagent', '{count} subagents'], running: 'Coordinating subagents', preparing: 'Preparing to coordinate subagents' },
  workflow: { owner: 'workflow', placement: 'line', mergeable: false, title: 'Workflow', running: 'Running a workflow', preparing: 'Preparing a workflow' },
  jobs: { owner: 'jobs', placement: 'quiet', mergeable: false, title: 'Jobs', running: 'Checking jobs', preparing: 'Checking jobs' },
  todo: { ...PLAN_KIND, owner: 'todo' },
  goal: { ...PLAN_KIND, owner: 'goal' },
  questions: { title: 'Questions', unit: ['{count} question', '{count} questions'], running: 'Waiting for your action', preparing: 'Preparing questions' },
  tools: {},
}

const KINDS = Object.fromEntries((Object.keys(OVERRIDES) as ProcessActivity[]).map(activity => [activity, { ...BASE, ...OVERRIDES[activity] }])) as Readonly<Record<ProcessActivity, ToolKind>>

/**
 * The descriptor of one category.
 * @param activity - the category a call counts under.
 * @returns what the category does in the stream.
 */
export function kindOf(activity: ProcessActivity): ToolKind {
  return KINDS[activity]
}

/**
 * The view a line of the category moves to: Enter on a spawn or a workflow opens the view that has its detail.
 * @param activity - the category a call counts under.
 * @returns the view's id, or `undefined` when a line of the category opens in place.
 */
export function ownerViewOf(activity: ProcessActivity): string | undefined {
  const kind = KINDS[activity]
  return kind.placement === 'line' ? `mayfly.view.${kind.owner!}` : undefined
}

/**
 * What a group of calls of one category counts: `3 files`, `3 calls`.
 * @param activity - the calls' category.
 * @param count - how many calls.
 * @param t - translator for the transcript namespace.
 * @returns the translated phrase.
 */
export function unitPhrase(activity: ProcessActivity, count: number, t: MayflyTranslate): string {
  return t(KINDS[activity].unit[count === 1 ? 0 : 1], { count })
}

