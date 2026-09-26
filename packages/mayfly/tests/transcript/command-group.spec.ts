/**
 * The command-group card: the settled/pending/failed header states, the
 * per-command tree, the collapsed row cap, the expanded output tail, the
 * compact header-plus-failures mode, and width truncation — measured with
 * pi-tui's own counters (D48 real-semantics).
 */

import { describe, expect, it } from 'vitest'
import type { MayflyComponents, MayflySemanticColors } from '../../src/core/index.ts'
import type { CommandCallModel, TranscriptCommandGroupModel } from '../../src/frontend/index.ts'
import {
  COMMAND_GROUP_ROW_LIMIT,
  CommandGroupComponent,
} from '../../src/transcript/command-group.ts'
import { fakeMayflyComponents } from './helpers.ts'

/** Identity colors: assertions see structure, not escape codes. */
const id = (text: string): string => text
const IDENTITY: MayflySemanticColors = {
  text: id, textStrong: id, muted: id, textMuted: id, accent: id, primary: id, border: id,
  borderFocus: id, success: id, error: id, warning: id, selectedBg: id, roleUser: id, shellMode: id,
  mdHeading: id, mdLink: id, mdLinkUrl: id, mdCode: id, mdCodeBlock: id, mdCodeBlockBorder: id,
  mdQuote: id, mdQuoteBorder: id, mdHr: id, mdListBullet: id,
  diffAdded: id, diffRemoved: id, diffAddedStrong: id, diffRemovedStrong: id, diffGutter: id, diffMeta: id,
}
// Structurally satisfies MayflySemanticColors; declared where consumed.

/** Tagged colors for role assertions. */
function tagged(): MayflySemanticColors {
  const tag = (letter: string) => (text: string): string => `[${letter}]${text}[/${letter}]`
  return { ...IDENTITY, muted: tag('M'), textMuted: tag('T'), primary: tag('P'), success: tag('S'), error: tag('E'), warning: tag('W') }
}

const COMPONENTS: MayflyComponents = fakeMayflyComponents()

function command(partial: Partial<CommandCallModel> & { callId: string }): CommandCallModel {
  return { seq: 1, updatedSeq: 1, turn: 1, step: 0, command: partial.command ?? 'true', state: 'ok', ...partial }
}

function group(commands: readonly CommandCallModel[]): TranscriptCommandGroupModel {
  const first = commands[0]!
  return { kind: 'transcript-command-group', id: `command-group:${String(first.callId)}`, seq: first.seq, turn: first.turn, step: first.step, commands }
}

describe('CommandGroupComponent', () => {
  it('renders the settled header with the command tree and per-state marks', () => {
    const model = group([
      command({ callId: 'a', command: 'pnpm test', exitCode: 0 }),
      command({ callId: 'b', command: 'git status', exitCode: 0 }),
      command({ callId: 'c', command: 'rm -rf dist', state: 'error', exitCode: 1, error: 'rm: cannot remove' }),
    ])
    const lines = new CommandGroupComponent(model, tagged(), COMPONENTS).render(80)
    expect(lines).toEqual([
      '',
      '[W]◐ [/W]\x1b[1m[P]Ran 3 commands[/P]\x1b[22m[E] · 1 failed[/E]',
      '  ├─ pnpm test [S]✓[/S]',
      '  ├─ git status [S]✓[/S]',
      '  └─ rm -rf dist [E]✗[/E] [E]rm: cannot remove[/E]',
    ])
  })

  it('renders pending and all-failed headers', () => {
    const pending = new CommandGroupComponent(group([
      command({ callId: 'a', command: 'pnpm build', state: 'pending' }),
      command({ callId: 'b', command: 'pnpm test' }),
    ]), tagged(), COMPONENTS).render(80)
    expect(pending[1]).toBe('● \x1b[1m[P]Running 2 commands…[/P]\x1b[22m')
    expect(pending[2]).toBe('  ├─ pnpm build [T]…[/T]')

    const failed = new CommandGroupComponent(group([
      command({ callId: 'a', command: 'one', state: 'error', error: 'nope' }),
      command({ callId: 'b', command: 'two', state: 'error' }),
    ]), tagged(), COMPONENTS).render(80)
    expect(failed[1]).toBe('[E]✗ [/E]\x1b[1m[E]Ran 2 commands · failed[/E]\x1b[22m')
    expect(failed[3]).toBe('  └─ two [E]✗[/E]')
  })

  it('caps the collapsed tree at the row limit with an expand hint', () => {
    const many = Array.from({ length: COMMAND_GROUP_ROW_LIMIT + 3 }, (_, index) =>
      command({ callId: `c${String(index)}`, command: `step ${String(index)}` }))
    const lines = new CommandGroupComponent(group(many), IDENTITY, COMPONENTS).render(80)
    expect(lines).toHaveLength(2 + COMMAND_GROUP_ROW_LIMIT)
    expect(lines.at(-1)).toContain('more, ctrl+o to expand')
    const expanded = new CommandGroupComponent(group(many), IDENTITY, COMPONENTS)
    expanded.setExpanded(true)
    expect(expanded.render(80).at(-1)).toContain(`step ${String(many.length - 1)}`)
  })

  it('expands each command with its bounded output tail', () => {
    const model = group([
      command({ callId: 'a', command: 'pnpm test', previewLines: ['ok 1', 'ok 2'] }),
      command({ callId: 'b', command: 'pnpm build' }),
    ])
    const component = new CommandGroupComponent(model, IDENTITY, COMPONENTS)
    const collapsed = component.render(80)
    expect(collapsed.some(line => line.includes('ok 1'))).toBe(false)
    component.setExpanded(true)
    const expanded = component.render(80)
    expect(expanded).toEqual([
      '',
      '✓ \x1b[1mRan 2 commands\x1b[22m',
      '  ├─ pnpm test ✓',
      '  │  ok 1',
      '  │  ok 2',
      '  └─ pnpm build ✓',
    ])
  })

  it('reads unsettled commands as cancelled once the turn ends, and scopes its hint', () => {
    const model = group([
      command({ callId: 'a', command: 'pnpm test' }),
      command({ callId: 'b', command: 'pnpm build', state: 'pending' }),
    ])
    const component = new CommandGroupComponent(model, IDENTITY, COMPONENTS)
    expect(component.render(80)[1]).toBe('● \x1b[1mRunning 2 commands…\x1b[22m')
    component.setScope({ hint: true, turnClosed: true })
    expect(component.render(80)).toEqual([
      '',
      '✓ \x1b[1mRan 2 commands\x1b[22m · 1 cancelled',
      '  ├─ pnpm test ✓',
      '  └─ pnpm build ⊘',
    ])
    const many = new CommandGroupComponent(group(Array.from({ length: 12 }, (_, index) => command({ callId: `m${String(index)}`, command: `c${String(index)}` }))), IDENTITY, COMPONENTS)
    expect(many.render(80).at(-1)).toBe('  ... (5 more, ctrl+o to expand)')
    many.setScope({ hint: false, turnClosed: false })
    expect(many.render(80).at(-1)).toBe('  ... (5 more)')
  })

  it('renders a single-command group with the singular noun', () => {
    const running = new CommandGroupComponent(group([
      command({ callId: 'a', command: 'pnpm dev', state: 'pending' }),
    ]), IDENTITY, COMPONENTS)
    expect(running.render(80)).toEqual([
      '',
      '● \x1b[1mRunning 1 command…\x1b[22m',
      '  └─ pnpm dev …',
    ])
    const settled = new CommandGroupComponent(group([
      command({ callId: 'a', command: 'pnpm dev' }),
    ]), IDENTITY, COMPONENTS)
    const rows = settled.render(80)
    expect(rows[1]).toContain('Ran 1 command')
    // The width:expanded:detail cache returns the identical array.
    expect(settled.render(80)).toBe(rows)
  })

  it('swaps snapshots on update while preserving expansion state', () => {
    const component = new CommandGroupComponent(group([
      command({ callId: 'a', command: 'one', state: 'pending' }),
      command({ callId: 'b', command: 'two', state: 'pending' }),
    ]), IDENTITY, COMPONENTS)
    expect(component.render(80).join('\n')).toContain('Running 2 commands…')
    component.update(group([
      command({ callId: 'a', command: 'one' }),
      command({ callId: 'b', command: 'two' }),
    ]))
    expect(component.render(80).join('\n')).toContain('Ran 2 commands')
  })

  it('truncates rows and sanitizes control characters at narrow widths', () => {
    const model = group([
      command({ callId: 'a', command: `cat ${'x'.repeat(200)}`, previewLines: [`out ${'y'.repeat(200)}`] }),
      command({ callId: 'b', command: 'rm a\nb', state: 'error', error: `bad\x07${'z'.repeat(200)}` }),
    ])
    const component = new CommandGroupComponent(model, IDENTITY, COMPONENTS)
    component.setExpanded(true)
    for (const width of [6, 12, 24, 40]) {
      for (const row of component.render(width)) {
        expect(COMPONENTS.visibleWidth(row)).toBeLessThanOrEqual(width)
        expect(row).not.toContain('\x07')
      }
    }
    expect(component.render(80).join('\n')).toContain('rm a b')
  })
})
