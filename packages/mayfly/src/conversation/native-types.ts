/** Private native conversation projection registry declarations. @module */
import type {} from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-projection/types'
import type { ConversationProjection, ConversationFacts, ConversationProjectionState, ConversationFactsState } from './types.ts'

/** Load-order signal published only after `mayflyConversation` is registered. */
export interface MayflyConversationReady {
  readonly key: 'mayflyConversation'
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    mayflyConversation: ConversationProjection
    mayflyConversationFacts: ConversationFacts
  }

  interface SessionProjectionStateMap {
    mayflyConversation: ConversationProjectionState
    mayflyConversationFacts: ConversationFactsState
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    mayflyConversationReady: MayflyConversationReady
  }
}
