/** The shared title editor preserves the native form and admission contract. @module tests/interaction/rename-model */
import { describe, expect, it } from 'vitest'
import { renamePanelModel } from '../../src/interaction/rename-model.ts'

describe('renamePanelModel', () => {
  it('keeps the reference form, hidden Enter action and exact current title', () => {
    const node = renamePanelModel('Title 你好 🪰')
    expect(node).toMatchObject({
      title: 'Rename session', escapeLabel: 'cancel',
      child: { kind: 'form', id: 'session-rename', enterSubmits: 'save', fields: [{ kind: 'input', id: 'title', label: 'Session name', value: 'Title 你好 🪰' }] },
    })
    const json = JSON.stringify(node)
    expect(json).toContain('Title 你好 🪰')
    expect(json).toContain('session-rename')
    expect(json).toContain('"enterSubmits":"save"')
    expect(json).toContain('"hidden":true')
    expect(json).toContain('"formId":"session-rename"')
    expect(JSON.stringify(renamePanelModel('', key => `translated ${key}`))).toContain('translated Session name')
  })
})
