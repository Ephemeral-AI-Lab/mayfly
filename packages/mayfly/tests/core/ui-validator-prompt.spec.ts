/** The `prompt` node's admission: the wire shape, every field's bounds, and the places the node is refused. */
import { describe, expect, it } from 'vitest'
import { ui } from '../../../ui/src/index.ts'
import {
  validateMayflyEditorShellNode,
  validateMayflyStatusNode,
  validateMayflyUiNode,
  createAdmissionCache,
} from '../../src/core/ui-validator.ts'
import {
  MAYFLY_UI_MAX_PROMPT_LABEL,
  MAYFLY_UI_MAX_PROMPT_PLACEHOLDERS,
  MAYFLY_UI_MAX_PROMPT_PLACEHOLDER_TEXT,
  MAYFLY_UI_MAX_PROMPT_SYMBOL,
  MAYFLY_UI_MAX_PROMPT_TEXT,
  MAYFLY_UI_MAX_PROMPT_TOKENS,
  MAYFLY_UI_MAX_PROMPT_TOKEN_TEXT,
} from '../../src/core/ui-validator-prompt.ts'

const admitted = (value: unknown) => {
  const result = validateMayflyUiNode(value)
  if (!result.ok) throw new Error(result.message)
  return result.value
}
const refused = (value: unknown) => {
  const result = validateMayflyUiNode(value)
  if (result.ok) throw new Error('admitted')
  return result
}

describe('prompt admission', () => {
  it('admits a bare prompt and a prompt that sets every field', () => {
    expect(admitted(ui.prompt({ id: 'p' }))).toEqual({ kind: 'prompt', id: 'p' })
    const full = ui.prompt({
      id: 'p', symbol: '! ', symbolTone: 'accent', value: 'draft\nsecond',
      tokens: [{ id: 't1', label: 'Image #1', size: '84 KB' }, { id: 't2', label: 'notes.md' }],
      recall: [{ kind: 'queued', text: 'also update the footer' }, { kind: 'history', text: 'run the width scan again' }],
      recallLabel: 'earlier', placeholder: ['Ask anything · / commands', 'Ask anything'],
      completions: { items: [{ id: 'c1', label: '/model', detail: 'switch model', right: 'Ctrl+M' }, { id: 'c2', label: '/trace' }] },
      reset: { rev: 2, value: 'again' }, submitLabel: 'queue', autofocus: true,
    })
    expect(admitted(full)).toEqual(full)
    expect(admitted(ui.prompt({ id: 'p', placeholder: 'Ask anything' }))).toMatchObject({ placeholder: 'Ask anything' })
  })

  it('strips terminal sequences from what a person typed, but keeps its line breaks', () => {
    const result = admitted({ kind: 'prompt', id: 'p', value: 'a\x1b[31mb\nc\td\x07e', recall: [{ kind: 'history', text: '\x1b]0;title\x07x' }], reset: { rev: 0, value: 'r\x1b[2Js' } })
    expect(result).toMatchObject({ value: 'ab\nc\tde', recall: [{ text: 'x' }], reset: { value: 'rs' } })
  })

  it.each([
    [{ kind: 'prompt' }, 'id is required'],
    [{ kind: 'prompt', id: ' ' }, 'must not be empty'],
    [{ kind: 'prompt', id: 'p', symbol: 1 }, 'symbol must be a string'],
    [{ kind: 'prompt', id: 'p', symbolTone: 'loud' }, 'symbolTone is invalid'],
    [{ kind: 'prompt', id: 'p', value: 1 }, 'value must be a string'],
    [{ kind: 'prompt', id: 'p', tokens: {} }, 'tokens must be an array'],
    [{ kind: 'prompt', id: 'p', tokens: [1] }, 'tokens[0] must be an object'],
    [{ kind: 'prompt', id: 'p', tokens: [{ label: 'x' }] }, 'tokens[0].id is required'],
    [{ kind: 'prompt', id: 'p', tokens: [{ id: ' ', label: 'x' }] }, 'tokens[0].id must not be empty'],
    [{ kind: 'prompt', id: 'p', tokens: [{ id: 't' }] }, 'tokens[0].label is required'],
    [{ kind: 'prompt', id: 'p', tokens: [{ id: 't', label: 'x', size: 1 }] }, 'tokens[0].size must be a string'],
    [{ kind: 'prompt', id: 'p', tokens: [{ id: 't', label: 'x' }, { id: 't', label: 'y' }] }, 'tokens contains duplicate ids'],
    [{ kind: 'prompt', id: 'p', recall: [{ kind: 'pinned', text: 'x' }] }, 'recall[0].kind is invalid'],
    [{ kind: 'prompt', id: 'p', recall: [{ kind: 'history' }] }, 'recall[0].text is required'],
    [{ kind: 'prompt', id: 'p', recall: [{ kind: 'history', text: 1 }] }, 'recall[0].text must be a string'],
    [{ kind: 'prompt', id: 'p', recallLabel: 1 }, 'recallLabel must be a string'],
    [{ kind: 'prompt', id: 'p', placeholder: [] }, 'placeholder must hold 1 to'],
    [{ kind: 'prompt', id: 'p', placeholder: 1 }, 'placeholder must be an array'],
    [{ kind: 'prompt', id: 'p', completions: 1 }, 'completions must be an object'],
    [{ kind: 'prompt', id: 'p', completions: {} }, 'completions.items is required'],
    [{ kind: 'prompt', id: 'p', completions: { items: [{ label: 'x' }] } }, 'items[0].id is required'],
    [{ kind: 'prompt', id: 'p', completions: { items: [{ id: 'c' }] } }, 'items[0].label is required'],
    [{ kind: 'prompt', id: 'p', completions: { items: [{ id: ' ', label: 'x' }] } }, 'items id must not be empty'],
    [{ kind: 'prompt', id: 'p', completions: { items: [{ id: 'c', label: 'x' }, { id: 'c', label: 'y' }] } }, 'items contains duplicate ids'],
    [{ kind: 'prompt', id: 'p', completions: { items: [{ id: 'c', label: 'x', detail: 1 }] } }, 'detail must be a string'],
    [{ kind: 'prompt', id: 'p', reset: { value: 'x' } }, 'reset.rev is required'],
    [{ kind: 'prompt', id: 'p', reset: { rev: -1, value: 'x' } }, 'reset.rev must be'],
    [{ kind: 'prompt', id: 'p', reset: { rev: 0 } }, 'reset.value is required'],
    [{ kind: 'prompt', id: 'p', reset: 1 }, 'reset must be an object'],
    [{ kind: 'prompt', id: 'p', submitLabel: 1 }, 'submitLabel must be a string'],
    [{ kind: 'prompt', id: 'p', autofocus: 'yes' }, 'autofocus must be a boolean'],
  ])('rejects %j', (value, message) => {
    const result = refused(value)
    expect(result.code).toBe('MAYFLY_INVALID_CONTRIBUTION')
    expect(result.message).toContain(message)
  })

  it('bounds the short fields', () => {
    const long = (length: number) => 'x'.repeat(length)
    expect(refused(ui.prompt({ id: 'p', symbol: long(MAYFLY_UI_MAX_PROMPT_SYMBOL + 1) })).message).toContain('symbol must be at most')
    expect(refused(ui.prompt({ id: 'p', recallLabel: long(MAYFLY_UI_MAX_PROMPT_LABEL + 1) })).message).toContain('recallLabel must be at most')
    expect(refused(ui.prompt({ id: 'p', submitLabel: long(MAYFLY_UI_MAX_PROMPT_LABEL + 1) })).message).toContain('submitLabel must be at most')
    expect(refused(ui.prompt({ id: 'p', tokens: [{ id: long(MAYFLY_UI_MAX_PROMPT_TOKEN_TEXT + 1), label: 'x' }] })).message).toContain('tokens[0].id must be at most')
    expect(refused(ui.prompt({ id: 'p', placeholder: long(MAYFLY_UI_MAX_PROMPT_PLACEHOLDER_TEXT + 1) })).message).toContain('placeholder must be at most')
    expect(refused(ui.prompt({ id: 'p', placeholder: Array.from({ length: MAYFLY_UI_MAX_PROMPT_PLACEHOLDERS + 1 }, () => 'x') })).message).toContain('placeholder must hold')
    expect(admitted(ui.prompt({ id: 'p', symbol: long(MAYFLY_UI_MAX_PROMPT_SYMBOL), recallLabel: long(MAYFLY_UI_MAX_PROMPT_LABEL) }))).toMatchObject({ kind: 'prompt' })
  })

  it('limits the tokens and the text a prompt carries, apart from the tree\'s own text budget', () => {
    const tokens = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `t${String(index)}`, label: 'x' }))
    expect(validateMayflyUiNode(ui.prompt({ id: 'p', tokens: tokens(MAYFLY_UI_MAX_PROMPT_TOKENS) }))).toMatchObject({ ok: true })
    expect(validateMayflyUiNode(ui.prompt({ id: 'p', tokens: tokens(MAYFLY_UI_MAX_PROMPT_TOKENS + 1) }))).toMatchObject({ ok: false, code: 'MAYFLY_INVALID_CONTRIBUTION' })
    // A draft larger than the tree's 20,000 characters is fine for a prompt: that is what a paste is.
    expect(validateMayflyUiNode(ui.prompt({ id: 'p', value: 'x'.repeat(50_000) }))).toMatchObject({ ok: true })
    const recall = (count: number, length: number) => Array.from({ length: count }, () => ({ kind: 'history' as const, text: 'y'.repeat(length) }))
    expect(validateMayflyUiNode(ui.prompt({ id: 'p', value: 'x'.repeat(10), recall: recall(10, MAYFLY_UI_MAX_PROMPT_TEXT / 10 - 1) }))).toMatchObject({ ok: true })
    expect(validateMayflyUiNode(ui.prompt({ id: 'p', value: 'x'.repeat(10), recall: recall(10, MAYFLY_UI_MAX_PROMPT_TEXT / 10) }))).toMatchObject({ ok: false, code: 'MAYFLY_LIMIT_EXCEEDED' })
    const two = ui.stack.column([ui.prompt({ id: 'a', value: 'x'.repeat(MAYFLY_UI_MAX_PROMPT_TEXT) }), ui.prompt({ id: 'b', value: 'y' })])
    expect(validateMayflyUiNode(two)).toMatchObject({ ok: false, code: 'MAYFLY_LIMIT_EXCEEDED' })
  })

  it('reserves the control id like any control', () => {
    expect(refused(ui.stack.column([ui.prompt({ id: 'p' }), ui.prompt({ id: 'p' })])).message).toContain('duplicated')
    expect(refused(ui.stack.column([ui.prompt({ id: 'p' }), ui.list({ id: 'p', role: 'browse', selectedIds: [], items: [] })])).message).toContain('duplicated')
  })

  it('is admitted inside a surface and refused in status nodes and editor decorations', () => {
    const framed = ui.surface({ title: 'Editor', titleAlign: 'right', chrome: 'surface', hint: 'completions', child: ui.prompt({ id: 'p' }) })
    expect(admitted(framed)).toMatchObject({ child: { kind: 'prompt' } })
    const status = validateMayflyStatusNode(ui.prompt({ id: 'p' }) as never)
    expect(status).toMatchObject({ ok: false })
    expect(status.ok ? '' : status.message).toContain('interactive or unsupported')
    const decoration = validateMayflyEditorShellNode(ui.prompt({ id: 'p' }) as never)
    expect(decoration).toMatchObject({ ok: false })
    expect(decoration.ok ? '' : decoration.message).toContain('would take focus from the editor')
  })

  it('is never replayed from the admission memo, so every publish counts its text again', () => {
    const cache = createAdmissionCache()
    const shared = ui.stack.column([ui.prompt({ id: 'p', value: 'x'.repeat(MAYFLY_UI_MAX_PROMPT_TEXT - 1) })])
    expect(validateMayflyUiNode(ui.stack.column([shared]), undefined, cache)).toMatchObject({ ok: true })
    expect(validateMayflyUiNode(ui.stack.column([shared]), undefined, cache)).toMatchObject({ ok: true })
    const second = ui.stack.column([shared, ui.prompt({ id: 'q', value: 'zz' })])
    expect(validateMayflyUiNode(second, undefined, cache)).toMatchObject({ ok: false, code: 'MAYFLY_LIMIT_EXCEEDED' })
  })
})
