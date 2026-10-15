/**
 * Decisions of the editor's token state (the adapter over pi-tui): a token the caret is on is selected by the first
 * Backspace and removed by the second; a token right after the caret is not active until selected; an active token
 * can be replaced; a draft's pasted blocks fold back in as text.
 * @module @ephemeral-ai/mayfly/tests/core/editor-token-state
 */
import { describe, expect, it } from 'vitest'
import { TuiMainScreen, setCapabilities } from '@earendil-works/pi-tui'
import { Context } from '@deepseek-ai/cordis'
import { MayflyComponentsService } from '../../src/core/components.ts'
import type { MayflyEditorTokenSpan, MayflyEditorToken } from '../../src/core/types.ts'
import { FakeTerminal } from './fake-terminal.ts'
import { identity } from '../helpers.ts'

const MENTION = '@src/a.ts'

function editorWithToken() {
  setCapabilities({ images: null, trueColor: false, hyperlinks: false })
  const terminal = new FakeTerminal()
  const tui = new TuiMainScreen(terminal)
  tui.start()
  const theme = { colors: new Proxy({}, { get: () => identity }) as never }
  const components = new MayflyComponentsService(new Context(), { theme, tui })
  const editor = components.createEditor()
  editor.setTokenSource(line => {
    const spans: MayflyEditorTokenSpan[] = []
    const at = line.indexOf(MENTION)
    if (at >= 0) spans.push({ start: at, end: at + MENTION.length, kind: 'mention' })
    return spans
  })
  return { editor, stop: () => tui.stop() }
}

describe('editor token state', () => {
  it('selects a token with the first Backspace from the caret and removes it with the second', () => {
    const { editor, stop } = editorWithToken()
    try {
      editor.setText(`see ${MENTION}`)
      // The caret rests right after the token, which is not active until Backspace selects it.
      expect(editor.activeToken()).toBeUndefined()
      expect(editor.tokenBackspace()).toBe(true)
      expect(editor.activeToken()).toMatchObject({ kind: 'mention', text: MENTION, selected: true })
      expect(editor.tokenBackspace()).toBe(true)
      expect(editor.getText()).toBe('see ')
    } finally {
      stop()
    }
  })

  it('reports no token when the caret is not on one, and Backspace then passes through', () => {
    const { editor, stop } = editorWithToken()
    try {
      editor.setText('plain words')
      expect(editor.tokenBackspace()).toBe(false)
      expect(editor.activeToken()).toBeUndefined()
    } finally {
      stop()
    }
  })

  it('notifies the host of the token the selection holds, and of none once it is gone', () => {
    const { editor, stop } = editorWithToken()
    try {
      const seen: Array<MayflyEditorToken | undefined> = []
      editor.focused = true
      editor.onTokenChange = token => { seen.push(token) }
      editor.setText(`see ${MENTION}`)
      editor.tokenBackspace()
      expect(seen.at(-1)).toMatchObject({ kind: 'mention', selected: true })
      editor.tokenBackspace()
      expect(seen.at(-1)).toBeUndefined()
    } finally {
      stop()
    }
  })

  it('replaces the active token with text in its place', () => {
    const { editor, stop } = editorWithToken()
    try {
      editor.setText(`see ${MENTION}`)
      editor.tokenBackspace()
      editor.replaceActiveToken('@src/b.ts')
      expect(editor.getText()).toBe('see @src/b.ts')
    } finally {
      stop()
    }
  })

  it('leaves the text alone when no token is active to replace', () => {
    const { editor, stop } = editorWithToken()
    try {
      editor.setText('no token')
      editor.replaceActiveToken('x')
      expect(editor.getText()).toBe('no token')
    } finally {
      stop()
    }
  })

  it('folds an external edit back into text, and keeps the buffer as the text it was given', () => {
    const { editor, stop } = editorWithToken()
    try {
      editor.setText('old text')
      editor.setTextFolding('a line\nand a second one', ['old text'])
      expect(editor.getText()).toBe('a line\nand a second one')
      expect(editor.getHistoryPastes()).toEqual([])
    } finally {
      stop()
    }
  })
})

describe('editor token keys', () => {
  it('steps over a token as one unit: Left from its end lands on its start, Right from its start on its end', () => {
    const { editor, stop } = editorWithToken()
    try {
      editor.focused = true
      editor.setText(`a ${MENTION} b`)
      // Two Lefts from the end rest the caret right after the token; one more steps over it to the token's start.
      editor.handleInput?.('\x1b[D')
      editor.handleInput?.('\x1b[D')
      editor.handleInput?.('\x1b[D')
      editor.handleInput?.('X')
      expect(editor.getText()).toBe(`a X${MENTION} b`)
      // From the start, one Right steps over the whole token.
      editor.setText(`a ${MENTION} b`)
      editor.handleInput?.('\x1b[D')
      editor.handleInput?.('\x1b[D')
      editor.handleInput?.('\x1b[D')
      editor.handleInput?.('\x1b[C')
      editor.handleInput?.('Y')
      expect(editor.getText()).toBe(`a ${MENTION}Y b`)
    } finally {
      stop()
    }
  })

  it('removes a token the caret covers with one Backspace, and a selected token then types over nothing', () => {
    const { editor, stop } = editorWithToken()
    try {
      editor.focused = true
      editor.setText(`see ${MENTION}`)
      editor.handleInput?.('\x1b[D')
      expect(editor.activeToken()).toMatchObject({ kind: 'mention', selected: false })
      expect(editor.tokenBackspace()).toBe(true)
      expect(editor.getText()).toBe('see ')
    } finally {
      stop()
    }
  })

  it('paints a selected token inverse in the rows it draws', () => {
    const { editor, stop } = editorWithToken()
    try {
      editor.focused = true
      editor.setText(`see ${MENTION}`)
      editor.tokenBackspace()
      expect(editor.render(60).join('\n')).toContain('\x1b[7m')
    } finally {
      stop()
    }
  })

  it('takes a folded pasted block as one token, its content kept for Ctrl+G', () => {
    const { editor, stop } = editorWithToken()
    try {
      editor.focused = true
      editor.setText('')
      editor.handleInput?.(`\x1b[200~${Array.from({ length: 12 }, (_, index) => `line ${String(index)}`).join('\n')}\x1b[201~`)
      const paste = editor.getText()
      expect(paste).toMatch(/^\[paste #1 \+12 lines\]$/u)
      editor.tokenBackspace()
      const token = editor.activeToken()
      expect(token).toMatchObject({ kind: 'paste', text: paste, selected: true })
      expect(token?.content).toContain('line 11')
      expect(editor.tokenBackspace()).toBe(true)
      expect(editor.getText()).toBe('')
    } finally {
      stop()
    }
  })
})

describe('editor folding, history, and placeholder', () => {
  it('folds a matched pasted block back in as a paste and keeps the rest as text', () => {
    const { editor, stop } = editorWithToken()
    try {
      editor.focused = true
      editor.setText('')
      editor.setTextFolding('say big-block now', ['big-block'])
      expect(editor.getText()).toBe('say big-block now')
    } finally {
      stop()
    }
  })

  it('replaces an active pasted block with text, folding it again when it is still big', () => {
    const { editor, stop } = editorWithToken()
    try {
      editor.focused = true
      editor.setText('')
      editor.handleInput?.(`\x1b[200~${Array.from({ length: 12 }, (_, index) => `row ${String(index)}`).join('\n')}\x1b[201~`)
      editor.tokenBackspace()
      editor.replaceActiveToken('short')
      expect(editor.getText()).toBe('short')
    } finally {
      stop()
    }
  })

  it('paints a token the caret covers as selected, without any Backspace', () => {
    const { editor, stop } = editorWithToken()
    try {
      editor.focused = true
      editor.setText(`see ${MENTION}`)
      editor.handleInput?.('\x1b[D')
      expect(editor.render(60).join('\n')).toContain('\x1b[7m')
    } finally {
      stop()
    }
  })

  it('shows the placeholder ghost on an empty prompt', () => {
    const { editor, stop } = editorWithToken()
    try {
      editor.setPlaceholder(['Ask anything'])
      expect(editor.render(60).join('\n')).toContain('Ask anything')
    } finally {
      stop()
    }
  })

  it('walks the history with Up and Down, and reports where the prompt stands in it', () => {
    const { editor, stop } = editorWithToken()
    try {
      editor.focused = true
      editor.addToHistory('first')
      editor.addToHistory('second')
      // History opens from an empty prompt; Down past the newest entry brings the empty draft back.
      editor.setText('')
      expect(editor.getHistoryPosition?.()).toBeUndefined()
      editor.handleInput?.('\x1b[A')
      expect(editor.getText()).toBe('second')
      expect(editor.getHistoryPosition?.()).toEqual({ index: 1, total: 2 })
      editor.handleInput?.('\x1b[B')
      expect(editor.getText()).toBe('')
    } finally {
      stop()
    }
  })
})

describe('editor token selection, paste tokens, and steps around them', () => {
  const PASTED = Array.from({ length: 12 }, (_, index) => `row ${String(index)}`).join('\n')

  it('selects a pasted block with the first Backspace, and reports its content with the selection', () => {
    const { editor, stop } = editorWithToken()
    try {
      editor.focused = true
      editor.setText('')
      editor.handleInput?.(`\x1b[200~${PASTED}\x1b[201~`)
      expect(editor.getText()).toBe('[paste #1 +12 lines]')
      expect(editor.activeToken()).toBeUndefined()
      expect(editor.tokenBackspace()).toBe(true)
      expect(editor.activeToken()).toEqual({ kind: 'paste', text: '[paste #1 +12 lines]', selected: true, content: PASTED })
      // The second Backspace removes the block as one unit.
      expect(editor.tokenBackspace()).toBe(true)
      expect(editor.getText()).toBe('')
    } finally {
      stop()
    }
  })

  it('drops a selection once the caret moves off the token, so the next Backspace selects again', () => {
    const { editor, stop } = editorWithToken()
    try {
      editor.focused = true
      editor.setText(`a ${MENTION}`)
      expect(editor.tokenBackspace()).toBe(true)
      expect(editor.activeToken()).toMatchObject({ kind: 'mention', selected: true })
      editor.handleInput?.('\x1b[D')
      editor.handleInput?.('\x1b[D')
      expect(editor.activeToken()).toBeUndefined()
      expect(editor.getText()).toBe(`a ${MENTION}`)
    } finally {
      stop()
    }
  })

  it('removes a token the caret covers at its start, with one Backspace and no selection first', () => {
    const { editor, stop } = editorWithToken()
    try {
      editor.focused = true
      editor.setText(`see ${MENTION}`)
      // One Left steps over the whole token, landing on its start, which the block cursor covers.
      editor.handleInput?.('\x1b[D')
      expect(editor.tokenBackspace()).toBe(true)
      expect(editor.getText()).toBe('see ')
    } finally {
      stop()
    }
  })

  it('replaces a selected pasted block with text, folding a text that is still big into a block again', () => {
    const { editor, stop } = editorWithToken()
    try {
      editor.focused = true
      editor.setText('')
      editor.handleInput?.(`\x1b[200~${PASTED}\x1b[201~`)
      editor.tokenBackspace()
      editor.replaceActiveToken('short words')
      expect(editor.getText()).toBe('short words')
      editor.setText('')
      editor.handleInput?.(`\x1b[200~${PASTED}\x1b[201~`)
      editor.tokenBackspace()
      editor.replaceActiveToken(PASTED)
      expect(editor.getText()).toBe('[paste #1 +12 lines]')
    } finally {
      stop()
    }
  })

  it('steps Right into a token from before it, and leaves a Right elsewhere to the editor', () => {
    const { editor, stop } = editorWithToken()
    try {
      editor.focused = true
      editor.setText(`a ${MENTION} b`)
      editor.handleInput?.('\x1b[D')
      editor.handleInput?.('\x1b[D')
      editor.handleInput?.('\x1b[D')
      editor.handleInput?.('\x1b[D')
      editor.handleInput?.('\x1b[D')
      editor.handleInput?.('\x1b[D')
      editor.handleInput?.('\x1b[D')
      editor.handleInput?.('\x1b[D')
      editor.handleInput?.('\x1b[D')
      editor.handleInput?.('\x1b[D')
      expect(editor.activeToken()).toBeUndefined()
      editor.handleInput?.('\x1b[C')
      editor.handleInput?.('Z')
      expect(editor.getText()).toBe(`aZ ${MENTION} b`)
    } finally {
      stop()
    }
  })
})
