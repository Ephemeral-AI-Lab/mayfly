/** Binary confirmation behavior, focus, and localization.
 * @module @ephemeral-ai/mayfly/interaction/tests/confirmation-panel
 */

import { describe, expect, it, vi } from 'vitest'
import type { MayflyUiEvent } from '@ephemeral-ai/mayfly-ui'
import { createConfirmationPanel } from '../../src/interaction/confirmation-panel.ts'
import { fakeMayflyContext, KEY } from './fakes.ts'

function mount(detail?: string) {
  const display = fakeMayflyContext()
  const onConfirm = vi.fn()
  const onCancel = vi.fn()
  const panel = createConfirmationPanel({
    ...display, title: 'Confirm', question: 'Continue?',
    ...(detail === undefined ? {} : { detail }),
    onConfirm, onCancel,
  })
  panel.focused = true
  panel.render(80)
  return { panel, onConfirm, onCancel }
}

describe('canonical confirmation', () => {
  it('shows both actions, starts on No, and ignores fixed-token typing', () => {
    const { panel, onConfirm, onCancel } = mount('This changes permissions.')
    expect(panel.currentFocusIdentity()).toEqual({ controlId: 'confirmation-no' })
    const rows = panel.render(80).join('\n')
    expect(rows).toContain('Yes')
    expect(rows).toContain('No')
    expect(rows).toContain('Continue?')
    panel.handleInput('yes')
    expect(onConfirm).not.toHaveBeenCalled()
    panel.handleInput(KEY.enter)
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('confirms only a selected Yes and ignores duplicate activation', () => {
    const { panel, onConfirm, onCancel } = mount()
    panel.handleInput(KEY.left)
    panel.invalidate()
    panel.render(40)
    expect(panel.currentFocusIdentity()).toEqual({ controlId: 'confirmation-yes' })
    panel.handleInput(KEY.enter)
    panel.handleInput(KEY.enter)
    panel.handleInput(KEY.escape)
    expect(onConfirm).toHaveBeenCalledOnce()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('lets Escape cancel even while Yes is selected', () => {
    const { panel, onConfirm, onCancel } = mount()
    panel.handleInput(KEY.left)
    panel.handleInput(KEY.escape)
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('ignores unrelated or forged events', () => {
    const { panel, onConfirm, onCancel } = mount()
    const emit = (panel as unknown as { options: { onEvent(event: MayflyUiEvent): void } }).options.onEvent
    emit({ kind: 'dismiss' })
    emit({ kind: 'activate', controlId: 'unknown' })
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('translates the question, details, and both buttons', () => {
    const display = fakeMayflyContext()
    const panel = createConfirmationPanel({
      ...display, title: 'Confirm', question: 'Continue?', detail: 'Details',
      t: key => `translated(${key})`, onConfirm: vi.fn(), onCancel: vi.fn(),
    })
    expect(panel.render(100).join('\n')).toContain('translated(Yes)')
    expect(panel.render(100).join('\n')).toContain('translated(No)')
  })
})
