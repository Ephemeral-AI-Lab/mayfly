/**
 * Review the generated Mayfly Host capability and conversation projection against an owner-supplied dsh Host.
 * Credentials stay in the environment and are redacted from diagnostics.
 * @module script/scenarios/host-conversation
 */

import { createHostClient } from '../../packages/remote/lib/client.js'
import { TYPERT_REMOTE } from '../../packages/host/lib/typert.remote-client.js'
import { endpoint } from './remote-lifecycle.mjs'

const PROJECTION_TIMEOUT_MS = 120_000

function isConversationProjection(value) {
  return value !== null && typeof value === 'object'
    && Array.isArray(value.entries) && Array.isArray(value.turns) && typeof value.streaming === 'boolean'
}

function projectionSummary(value) {
  if (!isConversationProjection(value)) throw new Error('The Host did not publish a mayflyConversation projection')
  const kinds = [...new Set(value.entries.map(entry => entry?.kind).filter(kind => typeof kind === 'string'))]
  return {
    entries: value.entries.length,
    kinds,
    streaming: value.streaming,
    turns: value.turns.length,
  }
}

async function waitForProjection(face, predicate) {
  return await new Promise((resolve, reject) => {
    let off = () => {}
    const timer = setTimeout(() => {
      off()
      reject(new Error('Timed out waiting for mayflyConversation'))
    }, PROJECTION_TIMEOUT_MS)
    const check = () => {
      const value = face.getSnapshot()
      if (!predicate(value)) return
      clearTimeout(timer)
      off()
      resolve(value)
    }
    off = face.subscribe(check)
    check()
  })
}

function errorText(error) {
  return error instanceof Error ? error.stack ?? error.message : String(error)
}

/**
 * Mount the generated Host Remote, inspect capabilities and one Session projection, then detach locally.
 * @param {object} options
 * @param {Record<string, string | undefined>} options.env - Host URL, optional Session id, and optional prompt.
 * @param {string} options.cwd - working directory for a newly created Session.
 * @returns {Promise<number>} scenario exit code.
 */
export async function runHostScenario({ env, cwd }) {
  const startupUrl = env.MAYFLY_DSH_STARTUP_URL
  if (startupUrl === undefined || startupUrl === '') {
    throw new Error('Set MAYFLY_DSH_STARTUP_URL to the dsh Host startup URL; do not put its token on the command line')
  }
  const { value, secrets } = endpoint(startupUrl)
  const redactions = [...new Set(secrets.filter(secret => secret !== ''))].sort((left, right) => right.length - left.length)
  const redact = text => redactions.reduce((current, secret) => current.replaceAll(secret, '<redacted>'), text)
  let client
  let unmount
  let code = 0
  try {
    client = await createHostClient({ key: value.id, startupUrl: value.url })
    unmount = await client.remote.$mount(TYPERT_REMOTE)
    const capabilities = await client.remote.mayflyHost.capabilities()
    if (!capabilities.ok) throw new Error(`mayflyHost/capabilities failed: ${capabilities.error.code}: ${capabilities.error.message}`)
    if (!capabilities.value.features.includes('mayflyConversation')) throw new Error('The Host does not advertise mayflyConversation')
    console.log(`capabilities: protocol=${capabilities.value.protocolVersion} host=${capabilities.value.hostVersion} dsh=${capabilities.value.requiredDshVersion} features=${capabilities.value.features.join(',')}`)

    const sessionId = env.MAYFLY_DSH_SESSION_ID ?? await client.sessions.create({ cwd })
    const prompt = env.MAYFLY_SCENARIO_PROMPT
    await client.sessions.using(sessionId, { source: 'controllerOperation' }, async reference => {
      const session = reference.binding.session
      const face = session.projections.faceOf('mayflyConversation')
      const initial = await waitForProjection(face, isConversationProjection)
      console.log(`conversation (initial): ${JSON.stringify(projectionSummary(initial))}`)
      if (prompt === undefined || prompt === '') return

      const submission = session.beginSubmission({ mode: 'queue', text: prompt, attachments: [] })
      try {
        const accepted = await session.prompt([{ type: 'text', text: prompt }], 'queue', undefined, submission.requestId)
        if (!accepted.ok) throw new Error(`prompt failed: ${accepted.error.code}: ${accepted.error.message}`)
      } catch (error) {
        submission.abandon()
        throw error
      }
      const settled = await waitForProjection(face, value => isConversationProjection(value)
        && value.streaming === false
        && value.entries.some(entry => entry?.kind === 'assistant' && entry.streaming === false))
      console.log(`conversation (settled): ${JSON.stringify(projectionSummary(settled))}`)
    })
  } catch (error) {
    code = 1
    console.error(redact(errorText(error)))
  }
  if (unmount !== undefined) {
    try {
      await unmount()
    } catch (error) {
      code = 1
      console.error(redact(errorText(error)))
    }
  }
  if (client !== undefined) {
    try {
      await client.detach()
    } catch (error) {
      code = 1
      console.error(redact(errorText(error)))
    }
  }
  return code
}
