/** Shared status chip for the displayed conversation while another view is open. @module components/conversation-status */
import type { MayflyStatusNode, MayflyTranslate } from '@ephemeral-ai/mayfly-ui'

/** Build the reference inverse chip from renderer-neutral conversation facts. */
export function buildConversationStatus(kind: 'primary' | 'btw' | 'subagent' | undefined, t: MayflyTranslate): MayflyStatusNode | null {
  if (kind === undefined) return null
  return { kind: 'rich-text', spans: [{ text: ` ${t(kind === 'primary' ? 'main' : kind)} `, tone: 'primary', styles: ['strong', 'inverse'] }] }
}
