#!/usr/bin/env node
/**
 * The demo of the tool display: a real dsh Host in an isolated profile and the real TUI, driven by the stub model through
 * real tools and stub MCP servers in a throwaway workspace. No provider is reached and nothing is billed. Quitting the TUI
 * ends it. @module script/scenarios/tool-display-demo
 */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchSplitHost } from './split-profile.mjs'
import { startStubModel } from './stub-model.mjs'
import { seedToolDisplayWorkspace } from './tool-display-fixture.mjs'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const dshBin = process.env.MAYFLY_DSH_BIN ?? process.env.DSH_BIN ?? createRequire(resolve(root, 'packages/cli/package.json')).resolve('@deepseek-ai/dsh/lib/bin.js')
const artifacts = join(root, '.artifacts/tool-display')
const mcpClient = createRequire(resolve(root, 'packages/cli/package.json')).resolve('@deepseek-ai/dsh/package.json')
const mcpEntry = createRequire(mcpClient).resolve('@deepseek-ai/dsh-mcp-client')
const mcpServer = fileURLToPath(new URL('./tool-display-mcp.mjs', import.meta.url))

// The presets leave `apply_patch` off, and their rows cannot be addressed from here, so a row of its own offers it. `TOOL_DISPLAY_PTC` swaps the tool executor, which is what offers `run_code`.
const model = await startStubModel()
const overlay = [`- id: web-search-deepseek\n  config:\n    apiKeyEnv: DEEPSEEK_API_KEY\n    baseURL: ${JSON.stringify(`${model.baseURL}/v1`)}`, "- insert:\n    - id: demo-tool-patch\n      name: '@deepseek-ai/dsh-tool-fs'\n      config:\n        read: false\n        readImage: false\n        write: false\n        edit: false\n        applyPatch: true", ...process.env.TOOL_DISPLAY_PTC === undefined ? [] : ['- id: tool-executor-native\n  disabled: true', '- id: tool-executor-ptc\n  disabled: false'], ...['github', 'linear', 'browser'].map(server => `- insert:\n    - id: demo-mcp-${server}\n      name: ${JSON.stringify(`file://${mcpEntry}`)}\n      config:\n        transport: stdio\n        serverName: ${server}\n        command: ${JSON.stringify(process.execPath)}\n        args: [${JSON.stringify(mcpServer)}, ${server}]`)]
// A level to start at, so all four can be judged without going through the settings.
if (process.env.TOOL_DISPLAY_LEVEL !== undefined) overlay.push(`- id: mayfly\n  config:\n    transcriptView: ${process.env.TOOL_DISPLAY_LEVEL}`)

mkdirSync(artifacts, { recursive: true })
const workspace = mkdtempSync(join(artifacts, 'workspace-'))
seedToolDisplayWorkspace(workspace)
const host = await launchSplitHost({ root, dshBin, artifacts, baseURL: model.baseURL, workspace, overlay, realtime: true })

process.stdout.write(`Send these prompts in the TUI. Each plays one session:

  demo:session   tools, MCP, a background job, subagents, a workflow
  demo:goal      a goal, its rounds, and a failed MCP call
  demo:background  a background workflow that x stops in its view

Quitting the TUI stops the Host and removes the workspace.
`)
await new Promise(resolve => { setTimeout(resolve, 1500) })

// The TUI's working directory is the Session's, so it must be the throwaway workspace: the script writes files.
const tui = spawn(process.execPath, [join(root, 'packages/mayfly/lib/bin.js')], { cwd: workspace, stdio: 'inherit', env: { ...process.env, MAYFLY_DSH_STARTUP_URL: host.startupUrl } })
const finished = new Promise(resolve => { tui.once('exit', resolve) })
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { tui.kill(signal) })
await finished
await host.stop()
await model.close()
rmSync(workspace, { recursive: true, force: true })
process.exit(0)
