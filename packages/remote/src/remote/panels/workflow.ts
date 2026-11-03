/**
 * Host Workflow DTOs mapped into the published Mayfly workflow presentation.
 * @module @ephemeral-ai/mayfly/remote/panels/workflow
 */

import { workflowNode, type WorkflowRunState } from '@ephemeral-ai/mayfly/pane-workflow'
import type { MayflyTranslate, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyWorkflowRun, MayflyWorkflowSnapshot } from '../../frontend/host-contract.ts'

function presentation(run: MayflyWorkflowRun): WorkflowRunState {
  return {
    id: run.id,
    name: run.name,
    phases: run.phases?.map(phase => ({ title: phase.title })),
    phasesSeen: [...run.phasesSeen],
    currentPhase: run.currentPhase,
    agents: run.agents.map(agent => ({
      seq: agent.seq,
      label: agent.label,
      phase: agent.phase,
      childId: String(agent.childId),
      ...agent.outcome === undefined ? {} : { outcome: agent.outcome },
    })),
    startedAt: run.startedAt,
    stopReason: run.stopReason ?? (run.interrupted === true ? 'cancelled' : undefined),
    endedAt: run.endedAt,
    agentsStarted: run.agentsStarted,
    attributed: true,
  }
}

/** Build the current Mayfly run/phase/agent tree from one complete Host snapshot. */
export function remoteWorkflowNode(
  snapshot: MayflyWorkflowSnapshot | undefined,
  now: number,
  t: MayflyTranslate,
): MayflyUiNode | null {
  return workflowNode(snapshot?.runs.map(presentation) ?? [], now, t)
}
