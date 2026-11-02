/**
 * Presentation helpers for the `/trace` session timeline. The data remains
 * owned by the official session-query service; this module only labels and
 * serializes one observation for terminal display or clipboard text.
 *
 * @module @ephemeral-ai/mayfly/interaction/trace-format
 */

import { extractSessionEventText } from '@deepseek-ai/dsh-session-query'
import type { AssistantStreamRecord } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
export { formatTraceAll, formatTraceItem, traceTime, type TraceItem } from './trace-model.ts'

/** Convert an event type into a compact user-facing label. */
export function traceTitle(type: string): string {
  switch (type) {
    case 'user/message': return 'User request'
    case 'assistant/attempt': return 'Assistant attempt'
    case 'assistant/message': return 'Assistant answer'
    case 'tool/call': return 'Tool call'
    case 'tool/result': return 'Tool result'
    case 'turn/start': return 'Turn started'
    case 'turn/end': return 'Turn ended'
    case 'request/header': return 'Model configuration'
    case 'subagent/descriptor': return 'Subagent'
    default: return type
  }
}

/** Concatenate one embedded attempt stream's reasoning and answer texts. */
export function attemptStreamText(stream: readonly AssistantStreamRecord[]): { reasoning: string, text: string } {
  let reasoning = ''
  let text = ''
  for (const record of stream) {
    if (record.type === 'reasoning-chunks') reasoning += record.texts.join('')
    else if (record.type === 'text-chunks') text += record.texts.join('')
    else if (record.type === 'chunk') {
      const chunk = record.chunk
      if (chunk.type === 'reasoning-delta') reasoning += chunk.text
      else if (chunk.type === 'text-delta') text += chunk.text
    }
  }
  return { reasoning, text }
}

/** Build a one-line summary from the official semantic text extractor. */
export function traceSummary(event: SessionEvent): string {
  if (event.type === 'assistant/attempt') {
    const parts = attemptStreamText(event.data.stream)
    const joined = [parts.reasoning.trim(), parts.text.trim()].filter(part => part !== '').join(' · ')
    if (joined !== '') return joined
  }
  const text = extractSessionEventText(event).replaceAll(/\s+/g, ' ').trim()
  if (text.length > 0) return text
  const data = event.data
  if (data === undefined || data === null) return ''
  if (typeof data === 'string') return data
  try {
    return JSON.stringify(data)
  } catch {
    return '[unserializable event payload]'
  }
}

