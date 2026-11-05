import { formatTokens } from './status-context-model.ts'

/** The `↓` estimated-output counter for streamed characters; '' below one token. */
export function outputCounter(chars: number): string {
  const tokens = Math.floor(chars / 4)
  return tokens > 0 ? `↓${formatTokens(tokens)}` : ''
}

