/** Shared semantic parity cases and explicitly split-only network cases. @module script/scenarios/split-cases */

export const SPLIT_PRESENTATION_STEPS = Object.freeze([
  { step: 'until', text: 'Ask anything' },
  { step: 'type', text: '/theme' }, { step: 'key', name: 'enter' },
  { step: 'until', text: 'Select a theme' }, { step: 'checkpoint', name: 'theme-picker' },
  { step: 'key', name: 'down' }, { step: 'key', name: 'enter' },
  { step: 'checkpoint', name: 'theme-tide' },
  { step: 'type', text: '主题 draft 🪰' }, { step: 'checkpoint', name: 'theme-draft' },
  { step: 'resize', cols: 40, rows: 16 }, { step: 'checkpoint', name: 'narrow-theme-draft' },
  { step: 'resize', cols: 120, rows: 40 }, { step: 'checkpoint', name: 'wide-theme-draft' },
  { step: 'key', name: 'ctrl+u' },
  { step: 'type', text: '/theme' }, { step: 'key', name: 'enter' },
  { step: 'until', text: 'Select a theme' },
  { step: 'key', name: 'up' }, { step: 'key', name: 'enter' },
  { step: 'checkpoint', name: 'theme-dark-restored' },
])

export const SPLIT_TOOL_STEPS = Object.freeze([
  { step: 'until', text: 'Ask anything' },
  { step: 'type', text: 'parity:tool:first' }, { step: 'key', name: 'enter' },
  { step: 'audit', event: 'tool-complete', label: 'first' },
  { step: 'until', text: 'Parity probe finished: first' },
  { step: 'checkpoint', name: 'real-tool-result' },
])

export const SPLIT_APPROVAL_STEPS = Object.freeze([
  { step: 'until', text: 'Ask anything' },
  { step: 'type', text: 'parity:approval:reject-case' }, { step: 'key', name: 'enter' },
  { step: 'audit', event: 'approval-pending', label: 'reject-case' },
  { step: 'until', text: 'Allow once' }, { step: 'checkpoint', name: 'approval-pending' },
  { step: 'key', name: 'esc' },
  { step: 'audit', event: 'approval-decided', label: 'reject-case', outcome: 'rejected' },
  { step: 'until', text: 'Parity probe finished: reject-case' }, { step: 'checkpoint', name: 'approval-rejected' },
  { step: 'type', text: 'parity:approval:abort-case' }, { step: 'key', name: 'enter' },
  { step: 'audit', event: 'approval-pending', label: 'abort-case' },
  { step: 'until', text: 'Allow once' }, { step: 'checkpoint', name: 'approval-before-abort' },
  { step: 'audit', event: 'approval-decided', label: 'abort-case', outcome: 'cancelled' },
  { step: 'until', text: 'Parity probe finished: abort-case' }, { step: 'checkpoint', name: 'approval-aborted' },
  { step: 'type', text: 'parity:hold:abort-turn' }, { step: 'key', name: 'enter' },
  { step: 'audit', event: 'tool-start', label: 'abort-turn' },
  { step: 'checkpoint', name: 'turn-before-abort' },
  { step: 'key', name: 'ctrl+c' },
  { step: 'audit', event: 'tool-aborted', label: 'abort-turn' },
  { step: 'until-gone', text: 'Calling tools' }, { step: 'checkpoint', name: 'turn-aborted' },
])

/** Network topology has no in-process rc.2 equivalent and never counts as visual parity evidence. */
export const SPLIT_NETWORK_STEPS = Object.freeze([
  { step: 'until', text: 'Ask anything' },
  { step: 'type', text: 'parity:hold:network-case' }, { step: 'key', name: 'enter' },
  { step: 'audit', event: 'tool-start', label: 'network-case' },
  { step: 'checkpoint', name: 'before-network-loss' },
  { step: 'network', action: 'drop' }, { step: 'wait', ms: 300 },
  { step: 'checkpoint', name: 'network-unavailable' },
  { step: 'network', action: 'restore' },
  { step: 'audit', event: 'tool-complete', label: 'network-case' },
  { step: 'until', text: 'Parity probe finished: network-case' },
  { step: 'checkpoint', name: 'network-recovered' },
])

/** Match only the fixture's latest plain-user instruction, never replay an earlier tool invocation. */
export function splitProbeInstruction(body) {
  const messages = body.messages ?? []
  const index = messages.findLastIndex(message => message.role === 'user' && /parity:(?:tool|approval|hold):[a-z-]+/u.test(JSON.stringify(message)))
  if (index < 0) return undefined
  const [, mode, label] = /parity:(tool|approval|hold):([a-z-]+)/u.exec(JSON.stringify(messages[index]))
  const completed = messages.slice(index + 1).some(message => /"type":"tool_(?:use|result)"/u.test(JSON.stringify(message)))
  return { mode, label, completed }
}

/** Explicit catalog: network recovery is behavioral evidence, never an rc.2 visual comparison. */
export const SPLIT_CASES = Object.freeze({
  presentation: { steps: SPLIT_PRESENTATION_STEPS },
  tools: { steps: SPLIT_TOOL_STEPS, probe: true },
  approval: { steps: SPLIT_APPROVAL_STEPS, probe: true },
  network: { steps: SPLIT_NETWORK_STEPS, probe: true, network: true, splitOnly: true },
})
