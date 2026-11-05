/** Shared workflow pane over readonly lifecycle facts. @module */
import type { MayflyInlineSpan, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { interpolateLocaleMessage, type MayflyTranslate } from '../frontend/locale.ts'
import { agentPhasePresentation, agentTreeBranch, compactElapsedSeconds, hiddenMembersText, selectVisibleMembers } from './agent-presentation.ts'
/** One workflow child call and its eventual outcome. */
interface WorkflowAgentRow {
  readonly seq: number
  readonly label: string
  readonly phase?: string | undefined
  readonly childId: string
  outcome?: 'completed' | 'failed' | 'cancelled'
}

/** Per-run state folded from native `workflow/*` lifecycle facts. */
export interface WorkflowRunState {
  readonly id: string
  readonly name: string
  readonly phases: readonly { readonly title: string }[] | undefined
  readonly phasesSeen: string[]
  currentPhase: string | undefined
  readonly agents: WorkflowAgentRow[]
  readonly startedAt: number
  stopReason: 'completed' | 'cancelled' | 'error' | undefined
  endedAt: number | undefined
  agentsStarted: number | undefined
  attributed: boolean
}

/** Compact workflow elapsed time. */
function formatWorkflowElapsed(seconds: number): string {
  return compactElapsedSeconds(seconds)
}

function phaseSegment(run: WorkflowRunState, t: MayflyTranslate): string | undefined {
  const phases = run.phases
  if (phases === undefined || phases.length === 0 || run.currentPhase === undefined) return undefined
  const index = phases.findIndex(phase => phase.title === run.currentPhase)
  const current = index >= 0
    ? index + 1
    : Math.max(1, run.phasesSeen.filter(title => phases.some(phase => phase.title === title)).length)
  return t('phase {current}/{total}', { current, total: phases.length })
}

function runningHeader(run: WorkflowRunState, now: number, t: MayflyTranslate): MayflyUiNode {
  const running = run.agents.filter(agent => agent.outcome === undefined).length
  const runningText = t('{count} running', { count: running })
  const parts = [
    phaseSegment(run, t),
    runningText,
    formatWorkflowElapsed(Math.max(0, Math.floor((now - run.startedAt) / 1000))),
  ].filter((value): value is string => value !== undefined)
  const spans: MayflyInlineSpan[] = [
    { text: `  ${t('Workflow {name}', { name: run.name })}`, tone: 'accent', styles: ['strong'] },
    { text: '  ', tone: 'muted' },
  ]
  parts.forEach((part, index) => {
    if (index > 0) spans.push({ text: ' · ', tone: 'muted' })
    if (part === runningText && running > 0) spans.push({ text: '● ', tone: 'accent', styles: ['strong'] })
    spans.push({ text: part, tone: 'muted' })
  })
  return { kind: 'rich-text', spans, overflow: 'truncate' }
}

function memberNode(agent: WorkflowAgentRow, last: boolean, t: MayflyTranslate): MayflyUiNode {
  const phase = agentPhasePresentation(agent.outcome ?? 'running')
  const marker = {
    text: `${phase.marker} `,
    tone: phase.tone,
    ...(agent.outcome === undefined ? { styles: ['strong'] as const } : {}),
  }
  return {
    kind: 'rich-text',
    spans: [
      { text: `  ${agentTreeBranch(last)} `, tone: 'muted' },
      marker,
      { text: agent.label },
      { text: ` — ${t('agent #{seq}', { seq: agent.seq })}`, tone: 'muted' },
      ...(agent.phase === undefined ? [] : [{ text: ` · ${agent.phase}`, tone: 'muted' as const }]),
    ],
    overflow: 'truncate',
  }
}

function settledNode(run: WorkflowRunState, t: MayflyTranslate): MayflyUiNode {
  const reason = run.stopReason!
  const marker = reason === 'completed'
    ? { text: '✓ ', tone: 'success' as const }
    : reason === 'cancelled'
      ? { text: '⊘ ', tone: 'muted' as const }
      : { text: '✗ ', tone: 'danger' as const }
  const count = run.agentsStarted ?? run.agents.length
  const elapsed = formatWorkflowElapsed(Math.max(0, Math.floor(((run.endedAt ?? run.startedAt) - run.startedAt) / 1000)))
  return {
    kind: 'rich-text',
    spans: [
      { text: '  ' },
      marker,
      { text: t('Workflow {name}', { name: run.name }), tone: 'accent', styles: ['strong'] },
      { text: ' — ', tone: 'muted' },
      { text: t(count === 1 ? '{reason} · {count} agent · {elapsed}' : '{reason} · {count} agents · {elapsed}', { reason, count, elapsed }), tone: 'muted' },
    ],
    overflow: 'truncate',
  }
}

/** Build the canonical pane tree for attributed runs. */
export function workflowNode(runs: readonly WorkflowRunState[], now: number, t: MayflyTranslate = interpolateLocaleMessage): MayflyUiNode | null {
  if (runs.length === 0) return null
  const children: { readonly node: MayflyUiNode }[] = []
  for (const run of runs) {
    children.push({ node: { kind: 'divider' } })
    if (run.stopReason !== undefined) {
      children.push({ node: settledNode(run, t) })
      continue
    }
    children.push({ node: runningHeader(run, now, t) })
    // A crowded run shows its running agents first, then the latest finished.
    const { shown, hidden } = selectVisibleMembers(run.agents.map(agent => ({
      agent, phaseLabel: agentPhasePresentation(agent.outcome ?? 'running').label,
    })))
    shown.forEach(({ agent }, index) => children.push({ node: memberNode(agent, hidden.length === 0 && index === shown.length - 1, t) }))
    if (hidden.length > 0) children.push({ node: { kind: 'text', content: hiddenMembersText(hidden), tone: 'muted', overflow: 'truncate' } })
  }
  return { kind: 'stack', direction: 'column', gap: 0, children }
}
