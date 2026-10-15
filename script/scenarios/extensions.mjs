/**
 * Editor extensions for the completion scenario: a Cordis plugin loaded into a running `dsh` through a `--patch` overlay
 * when a scenario names `extensions`. Three plugins stand for the ways an extension answers a `#` list: one is
 * quick, and marks one of its rows with a problem (`issue-tracker`), one is slow (`wiki`, two seconds, only for a query that starts with `wi`), and one throws
 * (`flaky`, only for a query that starts with `fl`), so the list shows a source tag, a wait with a name, and a failure
 * that is a row of its own while the other rows stay. Nothing is registered for `/` or `@`.
 * @module script/scenarios/extensions
 */

import { setTimeout as sleep } from 'node:timers/promises'

export const name = 'mayfly-scenario-extensions'
export const inject = ['mayflyEditorExtensions']

const ISSUES = [
  { id: 'issue-123', label: '#123', insertText: '#123', detail: 'Fix flaky cache test' },
  { id: 'issue-124', label: '#124', insertText: '#124', detail: 'Add retry to the upload' },
  { id: 'issue-130', label: '#bug-triage', insertText: '#bug-triage', detail: 'Triage the open bug reports', problem: 'the tracker is offline; this issue is from the cache' },
  { id: 'issue-131', label: '#flaky-tests', insertText: '#flaky-tests', detail: 'Quarantine the flaky tests' },
]

export function apply(ctx) {
  if (process.env.MAYFLY_SCENARIO_EXTENSIONS !== '1') return
  ctx.mayflyEditorExtensions.register({
    id: 'issue-tracker',
    complete: request => request.trigger === '#' ? ISSUES.filter(issue => issue.label.slice(1).startsWith(request.query)) : [],
  })
  ctx.mayflyEditorExtensions.register({
    id: 'wiki',
    complete: async (request, context) => {
      if (request.trigger !== '#' || !request.query.startsWith('wi')) return []
      await sleep(2000, undefined, { signal: context.signal }).catch(() => {})
      return [{ id: 'wiki-home', label: '#wiki-home', insertText: '#wiki-home', detail: 'The team wiki start page' }]
    },
  })
  ctx.mayflyEditorExtensions.register({
    id: 'flaky',
    complete: request => {
      if (request.trigger === '#' && request.query.startsWith('fl')) throw new Error('upstream refused the request')
      return []
    },
  })
}
