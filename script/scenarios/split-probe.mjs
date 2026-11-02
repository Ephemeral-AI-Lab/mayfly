/** Deterministic native tool and approval fixture, installed only into isolated verification Hosts. @module script/scenarios/split-probe */

import { appendFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

export const name = 'mayfly-split-parity-probe'
export const inject = ['tools', 'approval']

/** Register a real native tool. It asks the real approval service and records its returned outcome for assertions. */
export function apply(ctx) {
  const record = entry => appendFileSync(process.env.MAYFLY_SPLIT_PROBE_LOG, `${JSON.stringify(entry)}\n`)
  ctx.tools.register({
    name: 'parity_probe',
    description: 'Isolated parity fixture. Return deterministic text or request user approval; never access files or run commands.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { mode: { type: 'string', enum: ['tool', 'approval', 'hold'] }, label: { type: 'string' } },
      required: ['mode', 'label'],
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    presentCall: args => ({ card: 'generic', title: 'Parity probe', kind: 'other', rawInput: args.label }),
    presentResult: (_args, result) => ({ card: 'generic', content: result.content }),
    async execute(args, exec) {
      record({ event: 'tool-start', mode: args.mode, label: args.label })
      let text = `parity tool completed: ${args.label}`
      if (args.mode === 'approval') {
        record({ event: 'approval-pending', label: args.label })
        // Test native request withdrawal independently from card dismissal: rc.2
        // deliberately treats Ctrl+C on this card as rejection, not turn abort.
        const signal = args.label === 'abort-case' ? AbortSignal.any([exec.signal, AbortSignal.timeout(5000)]) : exec.signal
        const outcome = await ctx.approval.request({ agent: exec.agent, callId: exec.callId, toolName: 'parity_probe', reason: 'Approve this isolated deterministic parity probe.', signal })
        record({ event: 'approval-decided', label: args.label, outcome })
        text = `parity approval ${outcome}: ${args.label}`
      } else if (args.mode === 'hold') {
        try { await sleep(args.label === 'abort-turn' ? 30_000 : 2000, undefined, { signal: exec.signal }) } catch {
          record({ event: 'tool-aborted', label: args.label })
          text = `parity tool cancelled: ${args.label}`
        }
      }
      record({ event: 'tool-complete', label: args.label, text })
      return { text }
    },
  })
}
