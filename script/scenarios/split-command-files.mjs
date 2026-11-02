/** Real official Client uploads and command-file admission against an isolated dsh Host. @module script/scenarios/split-command-files */

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { launchSplitHost } from './split-profile.mjs'
import { startStubModel } from './stub-model.mjs'
import { builtSplitRuntime, persistedSplitEvidence } from './split-evidence.mjs'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC'

function value(result) {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/** Exercise generated codecs, real HTTP file upload, native receipt scope, and the authoritative journal. */
export async function runSplitCommandFiles({ root, dshBin = 'dsh', artifacts }) {
  mkdirSync(artifacts, { recursive: true })
  const runtimeBefore = builtSplitRuntime(root)
  const stub = await startStubModel()
  let host, client
  const report = { status: 'failed', runtimeBefore, cases: {}, failures: [] }
  try {
    host = await launchSplitHost({ root, dshBin, artifacts, baseURL: stub.baseURL })
    report.harness = host.version
    const { createHostClient, HostKey } = await import(pathToFileURL(join(root, 'packages/remote/lib/client.js')).href)
    client = await createHostClient({ key: HostKey('native-command-files'), startupUrl: host.startupUrl })
    const sessionId = await client.sessions.create({ cwd: host.cwd })
    const otherSessionId = await client.sessions.create({ cwd: host.cwd })
    report.sessionId = sessionId
    const catalog = value(await client.remote.commands.list(sessionId))
    const plan = catalog.find(command => command.name === 'plan')
    assert.equal(plan?.input?.attachments, true)
    report.command = plan
    const uploads = []
    for (const [name, text] of [['first.txt', 'first native file'], ['second.txt', 'second native file']]) {
      uploads.push(value(await client.fileUpload.upload(sessionId, new TextEncoder().encode(text), name)))
    }
    report.uploads = uploads
    const attachments = [
      { type: 'file', receiptId: uploads[1].receiptId },
      { type: 'image', mediaType: 'image/png', data: png, name: 'diagram.png' },
      { type: 'file', receiptId: uploads[0].receiptId },
    ]
    const journal = async id => value(await client.remote.session.events({ address: { kind: 'session', sessionId: id }, maxMessages: 100 })).records.map(record => record.event)
    const before = await journal(sessionId)
    const refusal = value(await client.remote.commands.execute(sessionId, '/plan off', attachments))
    assert.equal(refusal.result.kind, 'error')
    assert.equal(refusal.result.text, 'Attachments cannot accompany /plan off.')
    const afterRefusal = await journal(sessionId)
    assert.equal(afterRefusal.filter(event => event.type === 'user/message').length, before.filter(event => event.type === 'user/message').length)
    report.cases.offWithFiles = refusal

    const admitted = value(await client.remote.commands.execute(sessionId, '/plan Inspect ordered native attachments', attachments))
    assert.equal(admitted.result.kind, 'success')
    value(await client.remote.session.wait({ sessionId, timeoutMs: 10_000 }))
    const afterMessage = await journal(sessionId)
    report.events = afterMessage
    const message = afterMessage.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user').data
    assert.deepEqual(message.content.map(part => part.type), ['file', 'image', 'file', 'text'])
    assert.deepEqual(message.content[0].attachment, uploads[1].file)
    assert.equal(message.content[1].attachment.name, 'diagram.png')
    assert.deepEqual(message.content[2].attachment, uploads[0].file)
    assert.equal(message.content[3].text, 'Inspect ordered native attachments')
    report.cases.orderedFilesAndImage = { execution: admitted, message }

    const attachmentOnly = value(await client.remote.commands.execute(sessionId, '/plan', [attachments[0]]))
    assert.equal(attachmentOnly.result.kind, 'success')
    value(await client.remote.session.wait({ sessionId, timeoutMs: 10_000 }))
    const afterOnly = await journal(sessionId)
    const onlyMessage = afterOnly.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user').data
    assert.deepEqual(onlyMessage.content, [{ type: 'file', attachment: uploads[1].file }])
    report.cases.attachmentOnly = { execution: attachmentOnly, message: onlyMessage }

    const wrongSession = value(await client.remote.commands.execute(otherSessionId, '/plan Wrong Session', [attachments[0]]))
    assert.equal(wrongSession.result.kind, 'error')
    assert.equal(wrongSession.result.text, 'File upload receipt is unknown for this session.')
    assert.equal((await journal(otherSessionId)).some(event => event.type === 'user/message'), false)
    report.cases.exactSession = wrongSession
    report.events = afterOnly
    report.status = 'passed'
  } catch (error) {
    report.failures.push(error instanceof Error ? error.stack ?? error.message : String(error))
  } finally {
    await client?.detach()
    if (host !== undefined) writeFileSync(join(artifacts, 'host.log'), host.diagnostics())
    await host?.stop()
    await stub.close()
    report.nativeEvidence = persistedSplitEvidence(host?.runDir)
    report.runtimeAfter = builtSplitRuntime(root)
    if (runtimeBefore.sha256 !== report.runtimeAfter.sha256) {
      report.status = 'failed'
      report.failures.push('Built runtime changed during native command-file verification')
    }
    writeFileSync(join(artifacts, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  }
  return report
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { root: { type: 'string' }, artifacts: { type: 'string' }, 'dsh-bin': { type: 'string' } } })
  const root = resolve(values.root ?? fileURLToPath(new URL('../..', import.meta.url)))
  const artifacts = resolve(values.artifacts ?? join(root, '.artifacts/native-command-files'))
  const report = await runSplitCommandFiles({ root, artifacts, dshBin: values['dsh-bin'] ?? process.env.DSH_BIN ?? 'dsh' })
  console.log(`${report.status}: ${join(artifacts, 'report.json')}`)
  if (report.status !== 'passed') process.exitCode = 1
}
