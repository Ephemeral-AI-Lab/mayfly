/**
 * The decoder check of roadmap slice 1.7: every common encoding of the keys Mayfly binds (spec §3.5) reaches the key
 * matcher as that key. A chunk takes the real input path: pi-tui's stdin buffer splits it, the split-modifier joiner
 * rejoins what the buffer cut in two, and the core normalizers canonicalize navigation and function keys.
 */
import { StdinBuffer } from '@earendil-works/pi-tui/dist/stdin-buffer.js'
import { describe, expect, it, vi } from 'vitest'
import { matchesKeyId } from '../../src/core/key-actions.ts'
import { joinSplitModifiers, normalizeFunctionKeyInput, normalizeNavigationInput, startMayflyTerminal, withJoinedModifiers } from '../../src/core/terminal.ts'
import { FakeTerminal } from './fake-terminal.ts'

/** Feed one terminal read through the real input path and collect the sequences a listener would see. */
async function decode(...chunks: string[]): Promise<string[]> {
  const seen: string[] = []
  const join = joinSplitModifiers(data => seen.push(normalizeNavigationInput(data) ?? normalizeFunctionKeyInput(data) ?? data))
  const buffer = new StdinBuffer({ escapeTimeout: 5 })
  buffer.on('data', join)
  for (const chunk of chunks) {
    buffer.process(chunk)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  buffer.destroy()
  return seen
}

/** Each key Mayfly binds, with the encodings terminals and multiplexers send for it. */
const ENCODINGS: readonly (readonly [string, readonly [string, string][]])[] = [
  ['alt+up', [
    ['xterm', '\x1b[1;3A'], ['kitty press', '\x1b[1;3:1A'], ['kitty repeat', '\x1b[1;3:2A'], ['ESC prefix', '\x1b\x1b[A'],
    ['ESC prefix, SS3', '\x1b\x1bOA'], ['SS3 modifier', '\x1bO3A'], ['kitty CSI u keypad', '\x1b[57419;3u'],
  ]],
  ['alt+down', [['xterm', '\x1b[1;3B'], ['ESC prefix', '\x1b\x1b[B'], ['SS3 modifier', '\x1bO3B']]],
  ['alt+left', [['xterm', '\x1b[1;3D'], ['kitty press', '\x1b[1;3:1D'], ['ESC prefix', '\x1b\x1b[D'], ['emacs meta', '\x1bb']]],
  ['alt+right', [['xterm', '\x1b[1;3C'], ['ESC prefix, SS3', '\x1b\x1bOC'], ['SS3 modifier', '\x1bO3C']]],
  ['alt+enter', [['ESC prefix', '\x1b\r'], ['kitty CSI u', '\x1b[13;3u'], ['kitty press', '\x1b[13;3:1u'], ['modifyOtherKeys', '\x1b[27;3;13~']]],
  ['alt+m', [['ESC prefix', '\x1bm'], ['kitty CSI u', '\x1b[109;3u'], ['modifyOtherKeys', '\x1b[27;3;109~']]],
  ['ctrl+j', [['legacy', '\n'], ['kitty CSI u', '\x1b[106;5u'], ['modifyOtherKeys', '\x1b[27;5;106~']]],
  ['ctrl+s', [['legacy', '\x13'], ['kitty CSI u', '\x1b[115;5u'], ['modifyOtherKeys', '\x1b[27;5;115~']]],
  ['ctrl+f', [['legacy', '\x06'], ['kitty CSI u', '\x1b[102;5u']]],
  ['ctrl+g', [['legacy', '\x07'], ['modifyOtherKeys', '\x1b[27;5;103~']]],
  ['f2', [['SS3', '\x1bOQ'], ['vt220', '\x1b[12~'], ['kitty', '\x1b[Q'], ['kitty press', '\x1b[1;1:1Q'], ['kitty repeat', '\x1b[1;1:2Q']]],
  ['f3', [['SS3', '\x1bOR'], ['vt220', '\x1b[13~'], ['kitty repeat', '\x1b[13;1:2~']]],
  ['f4', [['SS3', '\x1bOS'], ['vt220', '\x1b[14~'], ['kitty', '\x1b[S']]],
  ['f5', [['vt220', '\x1b[15~'], ['kitty explicit', '\x1b[15;1~'], ['kitty repeat', '\x1b[15;1:2~']]],
  ['f6', [['vt220', '\x1b[17~']]],
  ['shift+f6', [['xterm', '\x1b[17;2~'], ['kitty press', '\x1b[17;2:1~']]],
  ['alt+f2', [['xterm', '\x1b[1;3Q'], ['SS3 modifier', '\x1bO3Q']]],
  ['ctrl+shift+f5', [['xterm', '\x1b[15;6~'], ['kitty with caps lock', '\x1b[15;70~']]],
  ['escape', [['legacy', '\x1b'], ['kitty CSI u', '\x1b[27u']]],
  ['/', [['legacy', '/'], ['kitty CSI u', '\x1b[47u']]],
]

describe('the decoder', () => {
  it.each(ENCODINGS.flatMap(([key, forms]) => forms.map(([form, chunk]) => [key, form, chunk] as const)))('reads %s in its %s form', async (key, _form, chunk) => {
    const decoded = await decode(chunk)
    expect(decoded).toHaveLength(1)
    expect(matchesKeyId(decoded[0]!, key), JSON.stringify(decoded[0])).toBe(true)
  })

  it('keeps a lone Escape, a prefix nothing completes, releases, and cursor reports as they are', async () => {
    expect(await decode('\x1b', '\x1b[A')).toEqual(['\x1b', '\x1b[A'])
    expect(await decode('\x1b\x1b[27;1:3u')).toEqual(['\x1b', '\x1b[27;1:3u'])
    expect(await decode('\x1bO3', 'z')).toEqual(['\x1bO3', 'z'])
    expect(normalizeFunctionKeyInput('\x1b[1;1:3Q')).toBeUndefined()
    expect(normalizeFunctionKeyInput('\x1b[15;1:3~')).toBeUndefined()
    expect(normalizeFunctionKeyInput('\x1b[R')).toBeUndefined()
    expect(normalizeFunctionKeyInput('\x1b[2;1~')).toBeUndefined()
    expect(normalizeFunctionKeyInput('\x1b[17;2~')).toBeUndefined()
  })

  it('matches a modified function key only with its own modifiers', () => {
    expect(matchesKeyId('\x1b[17;2~', 'f6')).toBe(false)
    expect(matchesKeyId('\x1b[17;3~', 'shift+f6')).toBe(false)
    expect(matchesKeyId('\x1b[1;5R', 'ctrl+f3')).toBe(true)
    expect(matchesKeyId('\x1b[16;2~', 'shift+f6')).toBe(false)
    expect(matchesKeyId('\x1b[1;3A', 'alt+f1')).toBe(false)
    expect(matchesKeyId('\x1b[17;2~', 'shift+x')).toBe(false)
  })

  it('joins a split modifier on the renderer\'s input and leaves the rest of the terminal alone', async () => {
    const terminal = new FakeTerminal()
    const wrapped = withJoinedModifiers(terminal)
    expect(wrapped.columns).toBe(terminal.columns)
    const received: string[] = []
    wrapped.start(data => received.push(data), () => {})
    terminal.sendInput('\x1b')
    terminal.sendInput('\x1b[B')
    expect(received).toEqual(['\x1b[1;3B'])

    const fake = new FakeTerminal()
    const runtime = await startMayflyTerminal(fake, async () => undefined)
    const input = vi.fn()
    const remove = runtime.tui.addInputListener(data => { input(data); return { consume: true } })
    fake.sendInput('\x1b')
    fake.sendInput('\x1bOA')
    fake.sendInput('\x1b[Q')
    expect(input.mock.calls).toEqual([['\x1b[1;3A'], ['\x1bOQ']])
    remove()
    await runtime.stop()
  })
})
