/** Actual native descendant activations and a local external process for isolated /agents captures. @module */
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'

export const name = 'mayfly-split-agents-fixture'
export const inject = ['tools', 'subagents', 'agents']

/** Admit one real native fixture tool; never supply a replacement descendant catalog or renderer state. */
export function apply(ctx) {
  const record = entry => appendFileSync(process.env.MAYFLY_SPLIT_PROBE_LOG, `${JSON.stringify(entry)}\n`)
  ctx.subagents.registerProvider({
    name: 'agents-fixture-external',
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    inheritsParentContext: false,
    async start(request) {
      const child = spawn(process.execPath, ['-e', 'process.stdout.write("Native external fixture complete")'], { cwd: request.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      const exited = Promise.withResolvers()
      let output = ''
      child.stdout.on('data', bytes => { output += bytes.toString() })
      child.once('error', exited.reject)
      child.once('exit', code => { exited.resolve(code) })
      const stop = () => { child.kill('SIGTERM') }
      request.signal.addEventListener('abort', stop, { once: true })
      const result = exited.promise.then(code => {
        record({ event: 'agents-external-exit', label: 'tree', code, output })
        return { output: [{ type: 'text', text: output }], stopReason: code === 0 ? 'completed' : 'interrupted' }
      }).finally(() => { request.signal.removeEventListener('abort', stop) })
      return {
        id: 'agents-external', result,
        async dispose() {
          if (child.exitCode === null && child.signalCode === null) stop()
          await exited.promise
        },
      }
    },
  })
  ctx.tools.register({
    name: 'agents_fixture',
    description: 'Create isolated native descendant rows for terminal acceptance.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: value.text }] },
    async execute(_args, exec) {
      const start = (parent, childId, label, text) => ctx.subagents.startActivation({
        provider: 'fork', childId, label, delivery: 'caller', signal: exec.signal,
        request: { parent, maxDepth: 4, prompt: [{ type: 'text', text }] },
      })
      const branch = await start(exec.agent, 'agents-branch', 'Branch parent', 'hold:600000 Branch fixture is waiting')
      const branchAgent = ctx.agents.get(branch.childId)
      if (branchAgent === undefined) throw new Error('Native branch did not publish its exact live Agent')
      const nested = await start(branchAgent, 'agents-nested', 'Nested leaf', 'Answer the nested fixture with one line')
      await nested.result
      await branch.dispose()
      await branch.result
      const cold = await start(exec.agent, 'agents-cold', 'Cold leaf', 'Answer the cold fixture with one line')
      await cold.result
      const external = await ctx.subagents.startActivation({
        provider: 'agents-fixture-external', label: 'External leaf', delivery: 'parent', signal: exec.signal,
        request: { parent: exec.agent, prompt: [{ type: 'text', text: 'Run the isolated external fixture' }] },
      })
      await external.result
      const live = await start(exec.agent, 'agents-live', 'Live leaf', 'hold:600000 Live fixture is waiting for an explicit stop')
      void live.result.then(result => { record({ event: 'agents-live-settled', label: 'tree', stopReason: result.stopReason }) }, error => { record({ event: 'agents-live-failed', label: 'tree', message: String(error) }) })
      record({ event: 'agents-fixture-ready', label: 'tree', parentId: exec.agent.id, entries: await ctx.subagents.listDescendants(exec.agent.id) })
      return { text: 'Agents fixture ready' }
    },
  })
}

/** Select the fixture tool once through a real model request and native tool admission. */
export function splitAgentsInstruction(body) {
  const messages = body.messages ?? []
  const index = messages.findLastIndex(message => message.role === 'user' && JSON.stringify(message).includes('native:agents:tree'))
  if (index < 0) return undefined
  const completed = messages.slice(index + 1).some(message => /"type":"tool_(?:use|result)"/u.test(JSON.stringify(message)))
  return completed ? { completed: true, reply: 'Native agents fixture admitted' } : { completed: false, name: 'agents_fixture', input: {}, id: 'native_agents_fixture' }
}
