/** Real Harness Team composition, projections, and live/cold conversation navigation.
 * @module script/smoke-native-team
 */
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const { startMockLlmServer } = require('@deepseek-ai/dsh-llm-mock-server')
const { Terminal } = require('@xterm/headless')
const pty = require('node-pty')
const root = resolve(import.meta.dirname, '..')
const sourceProfile = process.env.MAYFLY_TEAM_PROFILE_ROOT ?? join(homedir(), '.dsh/profiles/mayfly-native-harness')
const dsh = join(root, 'packages/mayfly/node_modules/@deepseek-ai/dsh/lib/bin.js')
const temp = mkdtempSync(join(tmpdir(), 'mayfly-native-team-'))
const profile = join(temp, 'profiles/mayfly-team-smoke')
mkdirSync(profile, { recursive: true })
writeFileSync(join(profile, 'package.json'), readFileSync(join(sourceProfile, 'package.json')))
symlinkSync(join(sourceProfile, 'node_modules'), join(profile, 'node_modules'), 'junction')
const fixture = join(temp, 'team-fixture.mjs')
writeFileSync(fixture, `export const name = 'native-team-smoke'
export const inject = ['agentPresets', 'agents', 'commands', 'agentTeams', 'mayflyCurrentAgent', 'tools', 'subagents']
export function apply(ctx) {
  let child
  ctx.commands.register({ name: 'native-presets', description: 'Verify built-in preset Team tools', handler: async invocation => {
    for (const preset of ['ptc', 'minimal', 'cordis', 'mayfly-cordis', 'standard']) {
      await ctx.agentPresets.select(invocation.agent, preset)
      for (const name of ['spawn_teammate', 'send_message', 'list_agents', 'team_task_create']) {
        if (ctx.tools.get(name, invocation.agent) === undefined) throw new Error(preset + ' lost Team tool ' + name)
      }
      for (const name of ['subagent', 'subagent_fork']) {
        if (ctx.tools.get(name, invocation.agent) !== undefined) throw new Error(preset + ' retains overlapping delegation ' + name)
      }
    }
    return { kind: 'success', text: 'NATIVE_PRESETS_READY' }
  } })
  ctx.commands.register({ name: 'native-seed', description: 'Seed native smoke fixtures', handler: async invocation => {
    const agent = ctx.mayflyCurrentAgent.current()
    const names = ctx.tools.schemas(agent).map(tool => tool.name)
    for (const name of ['spawn_teammate', 'send_message', 'list_agents', 'team_task_create']) {
      if (names.filter(item => item === name).length !== 1) throw new Error('Invalid Team tool composition: ' + name)
    }
    if (names.includes('subagent') || names.includes('subagent_fork')) throw new Error('Ordinary delegation leaked into Team')
    const task = await ctx.agentTeams.createTask(agent, { subject: 'Native task board', description: 'Projection acceptance', writeScopes: ['src'] })
    await ctx.agentTeams.updateTask(agent, { taskId: task.id, expectedRevision: task.revision, action: 'edit', description: 'Updated native task' })
    child = (await ctx.agentTeams.spawnTeammate(agent, { name: 'reviewer', description: 'Native reviewer', prompt: [{ type: 'text', text: 'Reply with the smoke completion marker.' }], context: 'fresh', provider: 'spawn', signal: invocation.signal })).member.id
    return { kind: 'success', text: 'NATIVE_TEAM_READY live=' + (ctx.agents.get(child)?.id ?? 'none') }
  } })
  ctx.commands.register({ name: 'native-who', description: 'Inspect native authority', handler: () => ({ kind: 'success', text: 'NATIVE_CURRENT_' + ctx.agentTeams.membership(ctx.mayflyCurrentAgent.current()).name }) })
  ctx.commands.register({ name: 'native-cold', description: 'Release the fixture child', handler: async () => {
    await ctx.subagents.drainContinuableChildren(ctx.mayflyCurrentAgent.primary(), [child])
    return { kind: 'success', text: 'NATIVE_CHILD_COLD' }
  } })
}
`)
writeFileSync(join(profile, 'cordis.patch.yml'), `\n- id: session-title-all-prompts-llm\n  disabled: true\n- id: mayfly\n  config:\n    updateCheck: false\n- insert:\n    - id: native-team-smoke\n      name: ${JSON.stringify(fixture)}\n`)
const server = await startMockLlmServer({ port: 0, sequence: ['stall', 'slow_success'], repeatLast: true, successText: 'NATIVE_TEAM_ANSWER', chunkSize: 1, chunkDelayMs: 150 })
const screen = new Terminal({ cols: 100, rows: 30, allowProposedApi: true })
const terminal = pty.spawn(process.execPath, [dsh, '--profile', 'mayfly-team-smoke'], {
  cwd: temp, name: 'xterm-256color', cols: 100, rows: 30,
  env: { ...process.env, DSH_HOME: temp, DEEPSEEK_BASE_URL: `${server.baseURL}/v1`, DEEPSEEK_API_KEY: 'smoke-key', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
})
let output = '', exited
terminal.onData(data => { output += data; screen.write(data) })
screen.onData(data => terminal.write(data))
terminal.onExit(event => { exited = event.exitCode })
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const view = () => Array.from({ length: screen.rows }, (_, index) => screen.buffer.active.getLine(index)?.translateToString(true) ?? '').join('\n')
const waitFor = async (check, label) => {
  const until = Date.now() + 30_000
  while (Date.now() < until && exited === undefined) { if (check()) return; await delay(100) }
  throw new Error(`${label}\n${view()}\n${output.slice(-1500)}`)
}
const command = async text => { terminal.write(text); await delay(100); terminal.write('\r') }
try {
  await waitFor(() => output.includes('\x1b[?2004h'), 'Default Mayfly profile boot')
  await delay(500)
  await command('/native-presets')
  await waitFor(() => output.includes('NATIVE_PRESETS_READY'), 'Built-in preset Team composition')
  await command('/native-seed')
  await waitFor(() => output.includes('NATIVE_TEAM_READY'), 'Native Team tool composition and creation')
  await command('/team')
  await waitFor(() => view().includes('reviewer') && view().includes('Native task board'), 'Native Team projection')
  terminal.write('reviewer'); await delay(100); terminal.write('\r')
  await waitFor(() => !view().includes('╭ Agent Team'), 'Live teammate selection')
  await command('/native-who')
  await waitFor(() => output.includes('NATIVE_CURRENT_reviewer'), 'Exact live teammate authority')
  terminal.write('\x1b[18~'); await delay(200)
  await command('/native-cold')
  await waitFor(() => output.includes('NATIVE_CHILD_COLD'), 'Native child release')
  await command('/team')
  await waitFor(() => view().includes('reviewer'), 'Cold member roster')
  terminal.write('reviewer'); await delay(100); terminal.write('\r')
  await waitFor(() => view().includes('i to reply'), 'Non-activating cold child history')
  terminal.write('i')
  await waitFor(() => view().includes('Reply to reviewer'), 'Cold child reply form')
  terminal.write('Human continuation'); terminal.write('\t'); await delay(100); terminal.write('\r')
  await waitFor(() => !view().includes('Reply to reviewer') && !view().includes('i to reply'), 'Native addressed continuation')
  const identityOffset = output.length
  await command('/native-who')
  await waitFor(() => output.slice(identityOffset).includes('NATIVE_CURRENT_reviewer'), 'Resumed exact Agent authority')
  terminal.resize(40, 16); screen.resize(40, 16); await delay(250)
  if (/exceeds terminal width|Uncaught/.test(output)) throw new Error('Terminal rendering failure')
  terminal.write('\x1b[19~'); await delay(150)
  await command('/quit')
  const until = Date.now() + 10_000
  while (exited === undefined && Date.now() < until) await delay(100)
  if (exited !== 0) throw new Error(`Team exit: ${exited}`)
  console.log('NATIVE_TEAM_PTY_PASS: default distribution, all shipped presets, native tools, task projection, live selection, cold history, continuation, narrow width, cleanup')
} finally {
  if (exited === undefined) terminal.kill()
  screen.dispose(); await server.close()
  const artifacts = join(root, '.artifacts/native-team')
  mkdirSync(artifacts, { recursive: true })
  writeFileSync(join(artifacts, 'terminal.log'), output)
  rmSync(temp, { recursive: true, force: true })
}
