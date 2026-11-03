/** Terminal input matching for semantic key actions. @module */
import { type KeyId, matchesKey } from '@earendil-works/pi-tui'
import type { MayflyKeymap } from './types.ts'
import { keyActionKeys } from './key-actions.ts'

/** The xterm function-key numbers of `CSI <n> ~`, by key. */
const FUNCTION_KEY_CODES: Readonly<Record<string, number>> = { 11: 1, 12: 2, 13: 3, 14: 4, 15: 5, 17: 6, 18: 7, 19: 8, 20: 9, 21: 10, 23: 11, 24: 12 }
/** The final bytes of `CSI 1;<mods> P` … `S`, F1-F4 with a modifier. */
const FUNCTION_KEY_FINALS: Readonly<Record<string, number>> = { P: 1, Q: 2, R: 3, S: 4 }
/** xterm's modifier parameter is one plus these bits; kitty adds lock bits above them. */
const MODIFIER_BITS: Readonly<Record<string, number>> = { shift: 1, alt: 2, ctrl: 4, meta: 8 }

/** A function key with an xterm or kitty modifier parameter, which pi-tui does not decode: its number and modifier bits. */
function modifiedFunctionKey(data: string): { readonly key: number, readonly modifiers: number } | undefined {
  const numbered = /^\x1b\[(\d+);(\d+)(?::[12])?~$/u.exec(data)
  const key = numbered === null ? undefined : FUNCTION_KEY_CODES[numbered[1]!]
  if (key !== undefined) return { key, modifiers: (Number(numbered![2]) - 1) & 15 }
  const lettered = /^\x1b\[1;(\d+)(?::[12])?([PQRS])$/u.exec(data)
  return lettered === null ? undefined : { key: FUNCTION_KEY_FINALS[lettered[2]!]!, modifiers: (Number(lettered[1]) - 1) & 15 }
}

/**
 * Match an input sequence against a key id: pi-tui's matcher, plus the modified function keys it does not decode
 * (`CSI 17;2~` is Shift+F6, `CSI 1;3Q` Alt+F2; spec §3.5).
 * @param data - one decoded input sequence.
 * @param key - a pi-tui key id.
 * @returns whether the sequence is that key.
 */
export function matchesKeyId(data: string, key: string): boolean {
  if (matchesKey(data, key as KeyId)) return true
  const wanted = functionKeyId(key)
  const decoded = wanted === null ? undefined : modifiedFunctionKey(data)
  return decoded !== undefined && decoded.key === wanted!.key && decoded.modifiers === wanted!.modifiers
}

/** Key ids parsed as function keys: every key press asks about the same few dozen ids. */
const functionKeyIds = new Map<string, { readonly key: number, readonly modifiers: number } | null>()

/** The function key a key id names, with its modifier bits, or null for any other key. */
function functionKeyId(key: string): { readonly key: number, readonly modifiers: number } | null {
  const known = functionKeyIds.get(key)
  if (known !== undefined) return known
  const wanted = /^((?:(?:ctrl|alt|shift|meta)\+)*)f(\d{1,2})$/u.exec(key)
  const parsed = wanted === null ? null : {
    key: Number(wanted[2]),
    modifiers: wanted[1]!.split('+').filter(part => part.length > 0).reduce((bits, part) => bits | MODIFIER_BITS[part]!, 0),
  }
  functionKeyIds.set(key, parsed)
  return parsed
}


/** Match one semantic action through the live keymap or deterministic fixture defaults. */
export function matchesKeyAction(keymap: MayflyKeymap | undefined, data: string, actionId: string): boolean {
  if (keymap !== undefined && typeof keymap.matches === 'function' && typeof keymap.getKeys === 'function') return keymap.matches(data, actionId)
  return keyActionKeys(undefined, actionId).some(key => matchesKeyId(data, key))
}
