/** Headless guide defaults when the Host has no current permission selection. @module components-onboarding-wizard */

import { expect, it } from 'vitest'
import { onboardingWizard, type OnboardingFacts, type OnboardingLabels } from '../../src/components/onboarding-wizard.ts'
import { UiSurfaceModel } from '../../src/core/ui-interaction-surface.ts'

const labels: OnboardingLabels = {
  title: 'Welcome', steps: { preferences: 'Preferences', connect: 'Connect', ready: 'Ready' },
  preferencesIntro: 'Choose your preferences', language: 'Language', permissions: 'Permissions', theme: 'Theme', startup: 'Startup',
  connectIntro: 'Connect a provider', account: 'Account', accountDetail: 'Use your account', key: 'API key', keyDetail: 'Use an API key',
  keyNote: 'Your key stays on the Host', keyField: 'Key', keyPlaceholder: 'Paste key', skip: 'Skip', skipDetail: 'Set up later', recommended: 'Recommended',
  readyIntro: 'Ready', tryHeading: 'Try these', tryItems: [], start: 'Start chatting',
  signIn: {
    starting: 'Starting', opening: 'Opening browser', waiting: 'Waiting', noBrowser: 'No browser', otherMachine: 'Other machine', finishing: 'Finishing', connected: 'Connected',
    expires: time => `expires in ${time}`, callbackLabel: 'Callback', callbackPlaceholder: 'Paste callback', retry: 'Retry', copyLink: 'Copy', newLink: 'New link', otherMachineKey: 'Other machine', deliver: 'Deliver',
  },
}

it('starts on Preferences without a driven step and never selects a permission the Host did not mark current', () => {
  const facts: OnboardingFacts = {
    preferences: {
      language: { value: 'en', theme: 'dark', languages: [{ id: 'en', label: 'English' }], themes: [{ id: 'dark', label: 'Dark' }] },
      startup: { value: 'conversation', options: [{ id: 'conversation', label: 'Conversation' }] },
      permissions: [{ id: 'read-only', label: 'Read only', current: false }, { id: 'workspace', label: 'Workspace', current: false }],
    },
    connect: { canSignIn: false, keyEntry: false }, summary: [],
  }
  const model = new UiSurfaceModel('first-run', {
    id: 'first-run', revision: 1, node: onboardingWizard(facts, labels), source: [],
    scope: { kind: 'app', targetId: 'first-run' }, update: { reason: 'replace' }, definition: {},
    events: { prepare: async () => ({ reply: undefined, publish: () => false }) },
  })
  const address = { pagePath: [{ controlId: 'onboarding', itemId: 'preferences' }], formId: 'preferences-form' }
  expect(model.activeTab({ pagePath: [], controlId: 'onboarding' })).toBe('preferences')
  expect(model.form(address)?.fields.permission?.value).toBeNull()
  expect(model.form(address)?.fields.language?.value).toBe('en')
  model.edit({ ...address, fieldId: 'permission' }, 'read-only')
  expect(model.form(address)?.fields.permission?.value).toBe('read-only')
  model.dispose()
})

it('omits permission selection when the Host has not supplied a permission catalog', () => {
  const facts: OnboardingFacts = { preferences: {
    language: { value: 'en', theme: 'dark', languages: [{ id: 'en', label: 'English' }], themes: [{ id: 'dark', label: 'Dark' }] },
    startup: { value: 'conversation', options: [{ id: 'conversation', label: 'Conversation' }] },
  }, connect: { canSignIn: false, keyEntry: false }, summary: [] }
  expect(JSON.stringify(onboardingWizard(facts, labels))).not.toContain('"id":"permission"')
})
