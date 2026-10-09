/** The prompt's draft model: edits, the two-step token removal, the recall walk, completions, submit, and republish. */
import { describe, expect, it } from 'vitest'
import { ui, type MayflyPromptNode } from '../../../ui/src/index.ts'
import {
  PROMPT_COMPLETION_ROWS,
  createPromptModel,
  promptCompletionStart,
  promptCompletionsOpen,
  promptRecallActive,
  reconcilePrompt,
  reducePrompt,
  type UiPromptIntent,
  type UiPromptModel,
} from '../../src/core/ui-interaction-prompt.ts'
import { validateMayflyUiNode } from '../../src/core/ui-validator.ts'

const address = { pagePath: [], controlId: 'prompt' }
const admit = (node: MayflyPromptNode): MayflyPromptNode => {
  const result = validateMayflyUiNode(ui.prompt(node))
  if (!result.ok) throw new Error(result.message)
  return result.value as MayflyPromptNode
}
const model = (node: Omit<MayflyPromptNode, 'kind'> = { id: 'prompt' }) => createPromptModel(address, admit({ kind: 'prompt', ...node }))
const run = (start: UiPromptModel, ...intents: UiPromptIntent[]) => {
  let current = start
  const effects = []
  for (const intent of intents) {
    const reduction = reducePrompt(current, intent)
    current = reduction.model
    effects.push(...reduction.effects)
  }
  return { model: current, effects }
}
const TOKENS = [{ id: 't1', label: 'Image #1', size: '84 KB' }, { id: 't2', label: 'notes.md' }]
const RECALL = [
  { kind: 'queued', text: 'also update the footer' },
  { kind: 'history', text: 'run the width scan again' },
  { kind: 'history', text: 'bump the changelog too' },
] as const
const ITEMS = Array.from({ length: 9 }, (_, index) => ({ id: `c${String(index)}`, label: `/c${String(index)}` }))

describe('creating a prompt model', () => {
  it('starts from the reset, else the value, else nothing', () => {
    expect(model().text).toBe('')
    expect(model({ id: 'prompt', value: 'draft' })).toMatchObject({ text: 'draft', resetRev: undefined, revision: 0 })
    expect(model({ id: 'prompt', value: 'draft', reset: { rev: 3, value: 'again' } })).toMatchObject({ text: 'again', resetRev: 3 })
  })
})

describe('editing the draft', () => {
  it('records an edit once, clears a selection and a recall, and reports the value', () => {
    const start = run(model({ id: 'prompt', tokens: TOKENS, recall: RECALL }), { kind: 'backspace' }, { kind: 'recall', direction: 'older' }).model
    expect(start.recall).toBeDefined()
    const edited = reducePrompt(start, { kind: 'edit', value: 'x' })
    expect(edited.model).toMatchObject({ text: 'x', recall: undefined, selectedToken: undefined, revision: start.revision + 1 })
    expect(edited.effects).toEqual([{ kind: 'value-change', value: 'x', draftRevision: edited.model.revision }])
    expect(reducePrompt(edited.model, { kind: 'edit', value: 'x' })).toEqual({ model: edited.model, effects: [] })
    expect(reducePrompt(edited.model, { kind: 'edit', value: 'x' }).model).toBe(edited.model)
  })

  it('shows the completion cursor from the top again after an edit', () => {
    const moved = run(model({ id: 'prompt', completions: { items: ITEMS } }), { kind: 'complete-move', delta: 1 }, { kind: 'complete-dismiss' }).model
    expect(moved.completion).toMatchObject({ index: 1, hidden: true })
    expect(run(moved, { kind: 'edit', value: '/c' }).model.completion).toMatchObject({ index: 0, hidden: false })
  })
})

describe('the two-step Backspace on an empty buffer', () => {
  it('selects the last token, then removes it, and any other key deselects', () => {
    const start = model({ id: 'prompt', tokens: TOKENS })
    const first = reducePrompt(start, { kind: 'backspace' })
    expect(first.model.selectedToken).toBe('t2')
    expect(first.effects).toEqual([])
    const second = reducePrompt(first.model, { kind: 'backspace' })
    expect(second.model.selectedToken).toBeUndefined()
    expect(second.effects).toEqual([{ kind: 'token-remove', tokenId: 't2' }])
    expect(run(start, { kind: 'backspace' }, { kind: 'deselect' }, { kind: 'backspace' }).effects).toEqual([])
    expect(reducePrompt(start, { kind: 'deselect' }).model).toBe(start)
  })

  it('does nothing without tokens or while the buffer holds text', () => {
    expect(reducePrompt(model(), { kind: 'backspace' }).model.selectedToken).toBeUndefined()
    const typed = model({ id: 'prompt', tokens: TOKENS, value: 'a' })
    expect(reducePrompt(typed, { kind: 'backspace' })).toEqual({ model: typed, effects: [] })
  })

  it('selects the last token again when the selected one is gone', () => {
    const selected = run(model({ id: 'prompt', tokens: TOKENS }), { kind: 'backspace' }).model
    const republished = reconcilePrompt(selected, admit({ kind: 'prompt', id: 'prompt', tokens: [TOKENS[0]!] }))
    expect(republished.selectedToken).toBeUndefined()
    expect(run(republished, { kind: 'backspace' }).model.selectedToken).toBe('t1')
  })
})

describe('the recall walk', () => {
  const start = () => model({ id: 'prompt', recall: RECALL, value: '' })

  it('walks queued messages first, then history, and ↓ returns the draft', () => {
    const up = run(start(), { kind: 'recall', direction: 'older' })
    expect(up.model).toMatchObject({ text: 'also update the footer', recall: { index: 0, draft: '' } })
    expect(up.effects).toEqual([
      { kind: 'recall-change', source: 'queued', index: 0 },
      { kind: 'value-change', value: 'also update the footer', draftRevision: up.model.revision },
    ])
    const older = run(up.model, { kind: 'recall', direction: 'older' })
    expect(older.model.text).toBe('run the width scan again')
    expect(older.effects[0]).toEqual({ kind: 'recall-change', source: 'history', index: 1 })
    const newer = run(older.model, { kind: 'recall', direction: 'newer' })
    expect(newer.model.text).toBe('also update the footer')
    expect(newer.effects[0]).toEqual({ kind: 'recall-change', source: 'queued', index: 0 })
    const draft = run(newer.model, { kind: 'recall', direction: 'newer' })
    expect(draft.model).toMatchObject({ text: '', recall: undefined })
    expect(draft.effects).toEqual([
      { kind: 'recall-change', source: 'draft', index: -1 },
      { kind: 'value-change', value: '', draftRevision: draft.model.revision },
    ])
  })

  it('holds at the oldest entry, and ↓ without a walk is left to the editor', () => {
    const oldest = run(start(), { kind: 'recall', direction: 'older' }, { kind: 'recall', direction: 'older' }, { kind: 'recall', direction: 'older' }).model
    expect(oldest.recall?.index).toBe(2)
    expect(reducePrompt(oldest, { kind: 'recall', direction: 'older' })).toEqual({ model: oldest, effects: [] })
    expect(reducePrompt(start(), { kind: 'recall', direction: 'newer' })).toEqual({ model: start(), effects: [] })
  })

  it('does not start a walk from typed text', () => {
    const typed = model({ id: 'prompt', recall: [{ kind: 'history', text: 'same' }], value: 'x' })
    expect(promptRecallActive(typed)).toBe(false)
    expect(reducePrompt(typed, { kind: 'recall', direction: 'older' }).model).toBe(typed)
  })

  it('reports no value change when the draft that returns is the text on show', () => {
    const blank = [{ kind: 'history', text: '' }] as const
    const walking = run(model({ id: 'prompt', recall: blank }), { kind: 'recall', direction: 'older' })
    expect(walking.model.recall).toMatchObject({ index: 0, draft: '' })
    const back = run(walking.model, { kind: 'recall', direction: 'newer' })
    expect(back.effects).toEqual([{ kind: 'recall-change', source: 'draft', index: -1 }])
  })

  it('keeps the draft typed before the walk began', () => {
    const typed = run(model({ id: 'prompt', recall: RECALL }), { kind: 'edit', value: '' }).model
    expect(promptRecallActive(typed)).toBe(true)
    expect(promptRecallActive(model({ id: 'prompt' }))).toBe(false)
  })

  it('follows its entry when the host republishes the list', () => {
    const walking = run(start(), { kind: 'recall', direction: 'older' }, { kind: 'recall', direction: 'older' }).model
    expect(walking.recall).toMatchObject({ index: 1, entry: RECALL[1] })
    const same = reconcilePrompt(walking, admit({ kind: 'prompt', id: 'prompt', recall: [...RECALL] }))
    expect(same.recall?.index).toBe(1)
    const shifted = reconcilePrompt(walking, admit({ kind: 'prompt', id: 'prompt', recall: [{ kind: 'history', text: 'newer' }, ...RECALL] }))
    expect(shifted.recall?.index).toBe(2)
    expect(shifted.text).toBe('run the width scan again')
  })

  it('stands before the next entry when the entry on show was withdrawn, as a recalled queued message is', () => {
    const queued = run(start(), { kind: 'recall', direction: 'older' }).model
    const withdrawn = reconcilePrompt(queued, admit({ kind: 'prompt', id: 'prompt', recall: [RECALL[1], RECALL[2]] }))
    expect(withdrawn.recall).toEqual({ index: -1, draft: '' })
    expect(withdrawn.text).toBe('also update the footer')
    const next = run(withdrawn, { kind: 'recall', direction: 'older' })
    expect(next.model.text).toBe('run the width scan again')
    expect(next.model.recall?.index).toBe(0)
    const back = run(withdrawn, { kind: 'recall', direction: 'newer' })
    expect(back.model).toMatchObject({ text: '', recall: undefined })
    // A walk with no entry holds its place, or the end of a shorter list.
    const shorter = reconcilePrompt(withdrawn, admit({ kind: 'prompt', id: 'prompt', recall: [] }))
    expect(shorter.recall?.index).toBe(-1)
    const later = reconcilePrompt({ ...withdrawn, recall: { index: 5, draft: '' } }, admit({ kind: 'prompt', id: 'prompt', recall: [RECALL[1]] }))
    expect(later.recall?.index).toBe(0)
    expect(reconcilePrompt(withdrawn, admit({ kind: 'prompt', id: 'prompt', recall: [RECALL[1]] })).recall?.index).toBe(-1)
  })

  it('leaves the walk when the host removes every entry', () => {
    const walking = run(start(), { kind: 'recall', direction: 'older' }).model
    const emptied = reconcilePrompt(walking, admit({ kind: 'prompt', id: 'prompt' }))
    expect(emptied.recall).toEqual({ index: -1, draft: '' })
  })
})

describe('the completion list', () => {
  const open = () => model({ id: 'prompt', completions: { items: ITEMS } })

  it('moves a cursor within the list and accepts the row under it', () => {
    expect(promptCompletionsOpen(open())).toBe(true)
    const moved = run(open(), { kind: 'complete-move', delta: 1 }, { kind: 'complete-move', delta: 1 }, { kind: 'complete-move', delta: -1 })
    expect(moved.model.completion.index).toBe(1)
    expect(run(moved.model, { kind: 'complete-accept' }).effects).toEqual([{ kind: 'completion-accept', itemId: 'c1' }])
  })

  it('stops at both ends', () => {
    const start = open()
    expect(reducePrompt(start, { kind: 'complete-move', delta: -1 })).toEqual({ model: start, effects: [] })
    const end = run(start, ...Array.from({ length: 20 }, () => ({ kind: 'complete-move', delta: 1 }) as const)).model
    expect(end.completion.index).toBe(ITEMS.length - 1)
    expect(reducePrompt(end, { kind: 'complete-move', delta: 1 }).model).toBe(end)
  })

  it('scrolls a window of five rows to keep the cursor row in view', () => {
    const at = (steps: number) => promptCompletionStart(run(open(), ...Array.from({ length: steps }, () => ({ kind: 'complete-move', delta: 1 }) as const)).model)
    expect([0, 1, 4, 5, 8].map(at)).toEqual([0, 0, 0, 1, 4])
    expect(PROMPT_COMPLETION_ROWS).toBe(5)
  })

  it('hides on Esc until the offered rows change, and does nothing without a list', () => {
    const dismissed = run(open(), { kind: 'complete-dismiss' })
    expect(dismissed.effects).toEqual([{ kind: 'completion-dismiss' }])
    expect(promptCompletionsOpen(dismissed.model)).toBe(false)
    expect(run(dismissed.model, { kind: 'complete-accept' }).effects).toEqual([])
    expect(reducePrompt(dismissed.model, { kind: 'complete-move', delta: 1 }).model).toBe(dismissed.model)
    expect(reducePrompt(dismissed.model, { kind: 'complete-dismiss' }).model).toBe(dismissed.model)
    const same = reconcilePrompt(dismissed.model, admit({ kind: 'prompt', id: 'prompt', completions: { items: ITEMS }, placeholder: 'x' }))
    expect(promptCompletionsOpen(same)).toBe(false)
    const other = reconcilePrompt(dismissed.model, admit({ kind: 'prompt', id: 'prompt', completions: { items: ITEMS.slice(0, 2) } }))
    expect(promptCompletionsOpen(other)).toBe(true)
    expect(model().completion.signature).toBe('')
    expect(promptCompletionsOpen(model())).toBe(false)
    expect(reducePrompt(model(), { kind: 'complete-accept' }).effects).toEqual([])
  })

  it('keeps the cursor inside a list that shrinks', () => {
    const far = run(open(), ...Array.from({ length: 6 }, () => ({ kind: 'complete-move', delta: 1 }) as const)).model
    expect(far.completion.index).toBe(6)
    expect(reconcilePrompt(far, admit({ kind: 'prompt', id: 'prompt', completions: { items: ITEMS } })).completion.index).toBe(6)
    expect(reconcilePrompt(far, admit({ kind: 'prompt', id: 'prompt', completions: { items: ITEMS.slice(0, 7) }, value: 'z' })).completion.index).toBe(0)
  })
})

describe('submitting', () => {
  it('sends the text and the token ids, then clears the draft', () => {
    const start = model({ id: 'prompt', tokens: TOKENS, value: 'explain @notes', recall: RECALL })
    const sent = reducePrompt(start, { kind: 'submit' })
    expect(sent.effects).toEqual([{ kind: 'submit', text: 'explain @notes', tokens: ['t1', 't2'], draftRevision: sent.model.revision }])
    expect(sent.model).toMatchObject({ text: '', recall: undefined, selectedToken: undefined })
  })

  it('sends tokens alone, and nothing for an empty draft', () => {
    expect(run(model({ id: 'prompt', tokens: TOKENS }), { kind: 'submit' }).effects).toMatchObject([{ kind: 'submit', text: '', tokens: ['t1', 't2'] }])
    const empty = model({ id: 'prompt', value: '  \n ' })
    expect(reducePrompt(empty, { kind: 'submit' })).toEqual({ model: empty, effects: [] })
  })
})

describe('republishing', () => {
  it('keeps the draft, the selection, and the walk when the node is the same', () => {
    const start = model({ id: 'prompt', value: 'draft' })
    expect(reconcilePrompt(start, start.definition)).toBe(start)
    const typed = run(start, { kind: 'edit', value: 'draft more' }).model
    const next = reconcilePrompt(typed, admit({ kind: 'prompt', id: 'prompt', value: 'other', placeholder: 'a' }))
    expect(next.text).toBe('draft more')
    expect(next.revision).toBe(typed.revision)
  })

  it('keeps a selected token while it stays in the list', () => {
    const selected = run(model({ id: 'prompt', tokens: TOKENS }), { kind: 'backspace' }).model
    expect(reconcilePrompt(selected, admit({ kind: 'prompt', id: 'prompt', tokens: TOKENS, placeholder: 'x' })).selectedToken).toBe('t2')
    const reset = reconcilePrompt(selected, admit({ kind: 'prompt', id: 'prompt', tokens: TOKENS, reset: { rev: 4, value: '' } }))
    expect(reset.selectedToken).toBeUndefined()
    expect(reconcilePrompt(selected, admit({ kind: 'prompt', id: 'prompt' })).selectedToken).toBeUndefined()
  })

  it('replaces the draft once per reset revision', () => {
    const start = model({ id: 'prompt', tokens: TOKENS, reset: { rev: 1, value: '' } })
    const typed = run(start, { kind: 'edit', value: 'abc' }, { kind: 'backspace' }).model
    const same = reconcilePrompt(typed, admit({ kind: 'prompt', id: 'prompt', tokens: TOKENS, reset: { rev: 1, value: '' }, placeholder: 'a' }))
    expect(same.text).toBe('abc')
    const reset = reconcilePrompt(typed, admit({ kind: 'prompt', id: 'prompt', tokens: TOKENS, reset: { rev: 2, value: 'inserted ' } }))
    expect(reset).toMatchObject({ text: 'inserted ', resetRev: 2, selectedToken: undefined, recall: undefined, revision: typed.revision + 1 })
    expect(reset.completion).toMatchObject({ index: 0, hidden: false })
    const dismissed = run(model({ id: 'prompt', completions: { items: ITEMS } }), { kind: 'complete-dismiss' }).model
    const cleared = reconcilePrompt(dismissed, admit({ kind: 'prompt', id: 'prompt', completions: { items: ITEMS }, reset: { rev: 0, value: '' } }))
    expect(promptCompletionsOpen(cleared)).toBe(true)
  })
})
