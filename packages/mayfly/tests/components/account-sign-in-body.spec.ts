/** The account sign-in body at each moment: link, browser, countdown, paste-back, and end.
 * @module @ephemeral-ai/mayfly/tests/components/account-sign-in-body
 */
import { describe, expect, it } from 'vitest'
import {
  clock,
  signInBody,
  type SignInFacts,
  type SignInIds,
  type SignInLabels,
} from '../../src/components/account-sign-in.ts'

const labels: SignInLabels = {
  starting: 'Starting the sign-in',
  opening: 'Opening the browser',
  waiting: 'Waiting for the browser',
  noBrowser: 'No browser could be opened',
  otherMachine: 'Continue on the other machine',
  finishing: 'Finishing the sign-in',
  connected: 'Connected',
  expires: time => `expires in ${time}`,
  callbackLabel: 'Callback address',
  callbackPlaceholder: 'Paste the address here',
  retry: 'Try again',
  copyLink: 'Copy link',
  newLink: 'New link',
  otherMachineKey: 'Other machine',
  deliver: 'Deliver',
}

const ids: SignInIds = {
  pagePath: [],
  keys: 'sign-in-keys',
  form: 'sign-in-callback',
  field: 'sign-in-callback-field',
  copy: 'sign-in-copy',
  restart: 'sign-in-restart',
  other: 'sign-in-other',
  deliver: 'sign-in-deliver',
  retryList: 'sign-in-retry-list',
  retry: 'sign-in-retry',
}

function facts(over: Partial<SignInFacts> = {}): SignInFacts {
  return { stage: 'waiting', browser: 'opened', manual: false, ...over }
}

function body(over: Partial<SignInFacts> = {}): string {
  return JSON.stringify(signInBody(facts(over), labels, ids))
}

function expectHiddenForm(node: string): void {
  expect(node).toContain(`"id":"${ids.form}"`)
  expect(node).toContain('"when":{"minWidth":100000}')
  expect(node).not.toContain('"autofocus":true')
}

describe('clock', () => {
  it('writes whole minutes and seconds, clamping negatives', () => {
    expect(clock(0)).toBe('0:00')
    expect(clock(-5000)).toBe('0:00')
    expect(clock(1000)).toBe('0:01')
    expect(clock(59_001)).toBe('1:00')
    expect(clock(61_000)).toBe('1:01')
    expect(clock(10 * 60_000)).toBe('10:00')
    expect(clock(299_000)).toBe('4:59')
  })
})

describe('signInBody', () => {
  it('shows one loader for each of starting, finishing, and connected', () => {
    const starting = body({ stage: 'starting' })
    expect(starting).toContain(labels.starting)
    expect(starting).not.toContain(ids.form)

    const finishing = body({ stage: 'finishing', callbackPort: 4321 })
    expect(finishing).toContain(labels.finishing)
    expectHiddenForm(finishing)

    expect(body({ stage: 'finished' as never })).toContain(labels.waiting)

    const connected = body({ stage: 'connected' })
    expect(connected).toContain('✓')
    expect(connected).toContain(labels.connected)
    expect(connected).not.toContain(ids.form)
  })

  it('ends with the reason and the retry chooser', () => {
    const ended = body({ stage: 'ended', endedText: 'The link expired' })
    expect(ended).toContain('The link expired')
    expect(ended).toContain(`"id":"${ids.retryList}"`)
    expect(ended).toContain('"id":"retry"')
    expect(ended).toContain(`"acceptActionId":"${ids.retry}"`)
    expect(ended).toContain('"autofocus":true')
    expect(body({ stage: 'ended' })).toContain('"content":""')
  })

  it('waits with the link and its countdown while a browser is open', () => {
    const waiting = body({ remainingMs: 125_000, totalMs: 300_000 })
    expect(waiting).toContain(labels.waiting)
    expect(waiting).toContain('expires in 2:05')
    expect(waiting).toContain('"value":125000')
    expect(waiting).toContain('"max":300000')
    expect(waiting).toContain('"tone":"primary"')
    expect(waiting).toContain('"width":16')
    expect(waiting).toContain(`"id":"${ids.copy}"`)
    expect(waiting).toContain(`"id":"${ids.restart}"`)
    expect(waiting).not.toContain(`"id":"${ids.other}"`)
    expect(waiting).not.toContain(ids.form)
  })

  it('warns once the link has under a minute and falls back to the link life as the progress maximum', () => {
    const short = body({ remainingMs: 45_000 })
    expect(short).toContain('"tone":"warning"')
    expect(short).toContain('"max":45000')
    const zero = body({ remainingMs: 0 })
    expect(zero).toContain('"value":0')
    expect(zero).toContain('"max":1')
  })

  it('offers the other-machine paste while waiting and hides the acknowledged form', () => {
    const waiting = body({ callbackPort: 4321 })
    expect(waiting).toContain(`"id":"${ids.other}"`)
    expect(waiting).toContain('"key":"p"')
    expectHiddenForm(waiting)
  })

  it('reports the opening delay before a browser result, then the finishing swap after a paste', () => {
    const opening = body({ browser: 'pending', callbackPort: 4321 })
    expect(opening).toContain(labels.opening)
    expectHiddenForm(opening)
    const delivering = body({ delivering: true, callbackPort: 4321 })
    expect(delivering).toContain(labels.finishing)
    expectHiddenForm(delivering)
    expect(body({ delivering: true })).not.toContain(ids.form)
  })

  it('shows the link and the visible paste form when no browser could open', () => {
    const manual = body({
      browser: 'failed', url: 'https://example.test/auth', remainingMs: 30_000, totalMs: 60_000, callbackPort: 4321,
    })
    expect(manual).toContain(labels.noBrowser)
    expect(manual).not.toContain(labels.otherMachine)
    expect(manual).toContain('https://example.test/auth')
    expect(manual).toContain('"autofocus":true')
    expect(manual).toContain('expires in 0:30')
    expect(manual).toContain('"tone":"warning"')
    expect(manual).toContain(`"id":"${ids.deliver}"`)
    expect(manual).toContain('"submit":[{"pagePath":[],"formId":"sign-in-callback"}]')
    expect(manual).toContain(`"id":"${ids.copy}"`)
    expect(manual).toContain(`"id":"${ids.restart}"`)
    expect(manual).not.toContain(labels.otherMachine)
  })

  it('shows the other-machine words when the reader asked for them though a browser opened', () => {
    const manual = body({ manual: true, url: 'https://example.test/manual', remainingMs: 15_000, totalMs: 60_000 })
    expect(manual).toContain(labels.otherMachine)
    expect(manual).not.toContain(labels.noBrowser)
    expect(manual).toContain('https://example.test/manual')
    expect(manual).toContain('expires in 0:15')
    expect(manual).not.toContain(ids.form)
    expect(manual).not.toContain(`"id":"${ids.deliver}"`)
    expect(manual).not.toContain('"autofocus":true')
  })

  it('omits the link and the form when the sign-in has no paste-back to offer', () => {
    const manual = body({ browser: 'failed', manual: true })
    expect(manual).toContain('"content":""')
    expect(manual).not.toContain(ids.form)
    expect(manual).not.toContain(`"id":"${ids.deliver}"`)
    expect(manual).toContain(`"id":"${ids.copy}"`)
    expect(manual).toContain(`"id":"${ids.restart}"`)
  })
})
