import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { commandContracts } from '../scenarios/split-commands.mjs'
import { splitProbeInstruction } from '../scenarios/split-cases.mjs'
import { awaitProbeAudit, readProbeAudit } from '../scenarios/split-audit.mjs'
import { startSplitNetwork } from '../scenarios/split-network.mjs'
import { serializeGrid } from '../scenarios/grid.mjs'
import { compareSplitReference, normalizeSplitGrid, redactSplitOutput, SPLIT_REFERENCE, verifyReferenceTarball } from '../scenarios/split-reference.mjs'
import { splitProfileEnvironment } from '../scenarios/split-profile.mjs'
import { seedSplitNativeWorkspace, splitNativeInstruction } from '../scenarios/split-native-fixture.mjs'

const grid = serializeGrid({ cols: 20, lines: ['hello', ''], styles: [[{ from: 0, to: 4, style: 'fg:#112233 b' }], []], cursor: [0, 5] })

function fixture(t) {
  const dir = join(tmpdir(), `mayfly-reference-test-${randomUUID()}`)
  mkdirSync(dir)
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const filename = 'startup-20x2.grid'
  writeFileSync(join(dir, filename), grid)
  const manifest = { ...SPLIT_REFERENCE, checkpoints: { [filename]: createHash('sha256').update(grid).digest('hex') } }
  writeFileSync(join(dir, 'reference.json'), JSON.stringify(manifest))
  return { dir, manifest }
}

test('both capture profiles stop real Git discovery at the isolated fixture home', t => {
  const { dir } = fixture(t)
  execFileSync('git', ['init', '--quiet', dir])
  for (const homeDir of [join(dir, 'candidate-home'), join(dir, 'published-reference', 'profile-home')]) {
    const workspace = join(homeDir, 'workspace')
    mkdirSync(workspace, { recursive: true })
    assert.equal(spawnSync('git', ['-C', workspace, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).status, 0)
    const env = splitProfileEnvironment(homeDir)
    assert.equal(env.GIT_CEILING_DIRECTORIES, homeDir)
    const isolated = spawnSync('git', ['-C', workspace, 'rev-parse', '--show-toplevel'], { env, encoding: 'utf8' })
    assert.notEqual(isolated.status, 0)
    assert.match(isolated.stderr, /not a git repository/u)
  }
})

test('strict comparison preserves text, colors, styles, dimensions and visible cursor', t => {
  const { dir } = fixture(t)
  const compare = actual => compareSplitReference(dir, [{ name: 'startup', grid: actual }], { cols: 20, rows: 2 })
  assert.deepEqual(compare(grid), [])
  for (const changed of [grid.replace('hello', 'hallo'), grid.replace('#112233', '#112234'), grid.replace(' b', ' i'), grid.replace('cursor 0,5', 'cursor none'), grid.replace('20x2', '21x2')]) assert.ok(compare(changed).length > 0)
})

test('comparison refuses missing checkpoints and tampered provenance or reference bytes', t => {
  const { dir, manifest } = fixture(t)
  assert.match(compareSplitReference(dir, [{ name: 'missing', grid }], { cols: 20, rows: 2 })[0], /no frozen reference/u)
  assert.deepEqual(compareSplitReference(dir, [], { cols: 20, rows: 2 }), ['No candidate checkpoints were captured'])
  writeFileSync(join(dir, 'startup-20x2.grid'), `${grid}\n`)
  assert.throws(() => compareSplitReference(dir, [{ name: 'startup', grid }], { cols: 20, rows: 2 }), /checksum mismatch/u)
  writeFileSync(join(dir, 'reference.json'), JSON.stringify({ ...manifest, version: 'candidate' }))
  assert.throws(() => compareSplitReference(dir, [{ name: 'startup', grid }], { cols: 20, rows: 2 }), /frozen published/u)
  assert.throws(() => verifyReferenceTarball(Buffer.from('candidate tarball')), /frozen npm integrity/u)
  writeFileSync(join(dir, 'reference.json'), JSON.stringify({ ...manifest, stepsSha256: 'different' }))
  assert.throws(() => compareSplitReference(dir, [{ name: 'startup', grid }], { cols: 20, rows: 2, steps: [] }), /semantic steps/u)
})

test('comparison refuses a different native startup preference before inspecting frames', t => {
  const { dir, manifest } = fixture(t)
  assert.throws(() => compareSplitReference(dir, [{ name: 'startup', grid }], { cols: 20, rows: 2, startup: 'splash' }), /startup preference/u)
  writeFileSync(join(dir, 'reference.json'), JSON.stringify({ ...manifest, startup: 'splash' }))
  assert.deepEqual(compareSplitReference(dir, [{ name: 'startup', grid }], { cols: 20, rows: 2, startup: 'splash' }), [])
  assert.throws(() => compareSplitReference(dir, [{ name: 'startup', grid }], { cols: 20, rows: 2 }), /startup preference/u)
})

test('only named volatile fields normalize, without removing spacing or style differences', () => {
  assert.equal(normalizeSplitGrid('cmd-0123abcd-1 12345678-1234-1234-1234-123456789abc'), 'cmd-xxxxxxxx-1 xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx')
  assert.equal(normalizeSplitGrid(grid), grid)
  assert.equal(normalizeSplitGrid('|  Trace · session-01234567-1234-5678-9a…'), '|  Trace · session-xxxxxxxx-xxxx-xxxx-xx…')
  assert.equal(normalizeSplitGrid('|  Trace · session-01234567-1234-5678-9a…').length, '|  Trace · session-01234567-1234-5678-9a…'.length)
  assert.equal(normalizeSplitGrid('|  ordinary text 01234567-1234-5678-9a…'), '|  ordinary text 01234567-1234-5678-9a…')
  assert.notEqual(normalizeSplitGrid('|  Trace · session-01234567-1234-5678-9a…'), normalizeSplitGrid('| Trace · session-01234567-1234-5678-9a…'))
})

test('diagnostics redact URLs and raw, encoded, form-encoded and unknown startup tokens', () => {
  const url = 'http://127.0.0.1:3080/?token=a%20b%2Bc'
  const redacted = redactSplitOutput(`${url} a b+c a%20b%2Bc a+b%2Bc http://host/?token=other-secret`, url)
  for (const token of [url, 'a b+c', 'a%20b%2Bc', 'a+b%2Bc', 'other-secret']) assert.ok(!redacted.includes(token))
})

test('command inventory reads canonical names, aliases and loop registrations without renderer names', () => {
  const result = commandContracts(`
    ctx.commands.register({ name: 'model', handler() {} })
    registerOwnedCommand(ctx, { name: 'new' })
    aliasRegistry.register('new', ['clear'])
    for (const command of ['version', 'changelog'] as const) ctx.commands.register({ name: command })
    panes.register({ name: 'not-a-command' })
  `, 'fixture.ts')
  assert.deepEqual(result.commands.map(command => command.name), ['model', 'new', 'version', 'changelog'])
  assert.deepEqual(result.aliases, [{ canonical: 'new', aliases: ['clear'] }])
})

test('capture clock stays frozen for frames but releases before Date-based input drain deadlines', t => {
  const { dir } = fixture(t)
  const release = join(dir, 'release-clock')
  const clock = fileURLToPath(new URL('../scenarios/split-clock.mjs', import.meta.url))
  const output = execFileSync(process.execPath, ['--import', clock, '--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    import { writeFileSync } from 'node:fs'
    import { setTimeout as sleep } from 'node:timers/promises'
    const frozen = Date.now()
    await sleep(30)
    assert.equal(Date.now(), frozen)
    writeFileSync(process.env.MAYFLY_SPLIT_CLOCK_RELEASE, 'release')
    await sleep(40)
    assert.ok(Date.now() > frozen)
    const end = Date.now() + 30
    while (Date.now() < end) await sleep(5)
    console.log('drained')
  `], { encoding: 'utf8', env: { ...process.env, MAYFLY_SPLIT_CLOCK_RELEASE: release }, timeout: 3000 })
  assert.equal(output.trim(), 'drained')
})

test('probe model follows only the latest user instruction and invokes a native tool once', () => {
  assert.equal(splitProbeInstruction({ messages: [] }), undefined)
  const first = { role: 'user', content: [{ type: 'text', text: 'parity:tool:first' }] }
  assert.deepEqual(splitProbeInstruction({ messages: [first] }), { mode: 'tool', label: 'first', completed: false })
  const done = { role: 'assistant', content: [{ type: 'tool_use', name: 'parity_probe' }] }
  assert.deepEqual(splitProbeInstruction({ messages: [first, done] }), { mode: 'tool', label: 'first', completed: true })
  assert.deepEqual(splitProbeInstruction({ messages: [first, done, { role: 'user', content: 'parity:approval:reject-case' }] }), { mode: 'approval', label: 'reject-case', completed: false })
})

test('native question fixture traverses actual builtin calls and resets on the next user prompt', () => {
  assert.equal(splitNativeInstruction({}), undefined)
  const single = { role: 'user', content: 'native:question:one' }
  const one = splitNativeInstruction({ messages: [single] })
  assert.equal(one.name, 'ask_user_question')
  assert.equal(one.input.questions.length, 1)
  const done = { role: 'assistant', content: [{ type: 'tool_use', name: one.name }] }
  assert.deepEqual(splitNativeInstruction({ messages: [single, done, { role: 'tool', content: null }] }), { completed: true, reply: 'Native question finished: one' })
  const wizard = splitNativeInstruction({ messages: [single, done, { role: 'user', content: [{ type: 'text', text: 'native:question:wizard' }] }] })
  assert.equal(wizard.input.questions.length, 3)
  assert.equal(wizard.input.questions[1].multi_select, true)
})

test('native files fixture uses the real read, edit, write and present input DTOs once in order', () => {
  const messages = [{ role: 'user', content: 'native:files:delivered' }]
  const calls = []
  for (const name of ['read', 'edit', 'write', 'present']) {
    const call = splitNativeInstruction({ messages })
    assert.equal(call.name, name)
    assert.equal(call.completed, false)
    calls.push(call)
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', name, input: call.input }] }, { role: 'user', content: [{ type: 'tool_result', content: 'native result' }] })
  }
  assert.deepEqual(calls.map(call => call.input), [
    { file_path: 'parity-change.txt' },
    { file_path: 'parity-change.txt', old_string: 'before parity change', new_string: 'after parity change' },
    { file_path: 'parity-deliverable.txt', content: 'Native delivered file\nExact preview 你好 🪰\n' },
    { files: [{ path: 'parity-deliverable.txt', description: 'Deterministic native delivery' }] },
  ])
  assert.deepEqual(splitNativeInstruction({ messages }), { completed: true, reply: 'Native files finished: delivered' })
})

test('native files reference and candidate reuse an identical committed workspace and literal absolute paths', t => {
  const { dir } = fixture(t)
  seedSplitNativeWorkspace(dir, undefined)
  assert.equal(existsSync(join(dir, 'parity-change.txt')), false)
  seedSplitNativeWorkspace(dir, 'native-files')
  const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
  const revision = git(['rev-parse', 'HEAD'])
  assert.equal(readFileSync(join(dir, 'parity-change.txt'), 'utf8'), 'before parity change\nunchanged line\n')
  writeFileSync(join(dir, 'parity-change.txt'), 'after parity change\nunchanged line\n')
  writeFileSync(join(dir, 'parity-deliverable.txt'), 'Native delivered file\n')
  seedSplitNativeWorkspace(dir, 'native-files')
  assert.equal(git(['rev-parse', 'HEAD']), revision)
  assert.equal(readFileSync(join(dir, 'parity-change.txt'), 'utf8'), 'before parity change\nunchanged line\n')
  assert.equal(existsSync(join(dir, 'parity-deliverable.txt')), false)
  assert.equal(git(['diff', '--stat', 'HEAD']), '')
})

test('native audit asserts outcomes and refuses duplicate tool execution independently of UI text', async t => {
  const { dir } = fixture(t)
  const file = join(dir, 'audit.jsonl')
  assert.deepEqual(readProbeAudit(file), [])
  writeFileSync(file, JSON.stringify({ event: 'tool-start', label: 'test' }) + '\n')
  appendFileSync(file, JSON.stringify({ event: 'approval-decided', label: 'test', outcome: 'rejected' }) + '\n')
  await awaitProbeAudit(file, { event: 'approval-decided', label: 'test', outcome: 'rejected' })
  appendFileSync(file, JSON.stringify({ event: 'tool-start', label: 'test' }) + '\n')
  await assert.rejects(awaitProbeAudit(file, { event: 'tool-start', label: 'test' }), /more than once/u)
})

test('outage fixture forwards real HTTP and WebSocket bytes, drops them and recovers without stopping Host', { timeout: 5000 }, async t => {
  const server = createServer((_req, res) => res.end('Host is alive'))
  server.on('upgrade', (req, socket) => {
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.write(Buffer.from([0x81, 5, ...Buffer.from('probe')]))
    socket.on('error', () => {})
    socket.on('end', () => socket.destroy())
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const target = `http://127.0.0.1:${server.address().port}/?token=fixture`
  const proxy = await startSplitNetwork(target)
  t.after(async () => { await proxy.close(); await new Promise(resolve => server.close(resolve)) })
  assert.equal(await (await fetch(proxy.startupUrl)).text(), 'Host is alive')
  const socket = new WebSocket(proxy.startupUrl.replace('http:', 'ws:'))
  const firstMessage = new Promise((resolve, reject) => { socket.onmessage = event => resolve(event.data); socket.onerror = reject })
  assert.equal(await firstMessage, 'probe')
  const closed = new Promise(resolve => { socket.onclose = resolve })
  proxy.drop()
  await closed
  assert.equal((await fetch(proxy.startupUrl)).status, 503)
  assert.equal(await (await fetch(target)).text(), 'Host is alive')
  proxy.restore()
  assert.equal(await (await fetch(proxy.startupUrl)).text(), 'Host is alive')
  await assert.rejects(startSplitNetwork('https://external.invalid'), /loopback/u)
})
