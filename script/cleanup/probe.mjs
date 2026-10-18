#!/usr/bin/env node
/**
 * Temporary differential probe for the cleanup branch: dumps the key tables and
 * every locale catalog as sorted JSON so the same script can run against the
 * baseline and the integration tip. Delete with the cleanup runbook.
 */

import { writeFileSync } from 'node:fs'
import { DEFAULT_ACTION_KEYS } from '../../packages/mayfly/src/core/key-actions.ts'
import { INTERACTION_KEY_ACTIONS } from '../../packages/mayfly/src/interaction/keys.ts'
import { SHARED_KEY_REFERENCE } from '../../packages/mayfly/src/core/ui-key-grammar.ts'
import { COMMON_LOCALE } from '../../packages/mayfly/src/frontend/common-locale.ts'
import { INTERACTION_LOCALE } from '../../packages/mayfly/src/interaction/locale.ts'
import { CORE_CONTEXT_HINT_LOCALE } from '../../packages/mayfly/src/core/context-hint-locale.ts'
import { TRANSCRIPT_LOCALE } from '../../packages/mayfly/src/transcript/locale.ts'

/** Sort object keys recursively so the dump has no incidental order. */
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]))
  }
  return value
}

const output = {
  keys: sorted({
    defaults: DEFAULT_ACTION_KEYS,
    interaction: INTERACTION_KEY_ACTIONS,
    sharedReference: SHARED_KEY_REFERENCE,
  }),
  locales: sorted({
    common: COMMON_LOCALE,
    interaction: INTERACTION_LOCALE,
    contextHint: CORE_CONTEXT_HINT_LOCALE,
    transcript: TRANSCRIPT_LOCALE,
  }),
}

const target = process.argv[2]
if (target === undefined) {
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
} else {
  writeFileSync(target, `${JSON.stringify(output, null, 2)}\n`)
  process.stdout.write(`wrote ${target}\n`)
}
