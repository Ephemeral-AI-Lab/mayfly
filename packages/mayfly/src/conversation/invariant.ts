/**
 * Invariant companion for the domain-only conversation projection.
 *
 * @module @ephemeral-ai/mayfly/conversation/invariant
 */

import type { Context } from '@deepseek-ai/cordis'

/** Stable invariant plugin name. */
export const name = 'mayfly-conversation-invariant'

/** The projection relies on the official registry's own invariant checks. */
export function apply(_ctx: Context): void {}
