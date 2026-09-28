/**
 * The five app-level shot scenes, driven over the real-service boot from
 * `./boot.ts`: scripted `SessionEvent`s appended to real store sessions (the
 * same shapes the agent loop commits), then the genuine interaction commands
 * (`/trace`, `/sessions`) or panel entry points (`openPermissionPanel`) a user
 * would reach. No renderer output is hand-built; every frame comes out of the
 * mounted plugin tree. All timestamps derive from `SHOT_EPOCH`, the pane clock
 * is pinned through `pinShotClock`, and child subagent sessions are real
 * store sessions with `origin: 'subagent'` lineage.
 *
 * @module @ephemeral-ai/mayfly/tests/app-shots/scenes
 */

import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { AssistantMessage, ContentBlock, ToolResultMessage, UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionHeader } from '@deepseek-ai/dsh-session'
import { waitForRender } from '../core/fake-terminal.ts'
import { sessionWorkspaceId } from '../../src/interaction/session-workspaces-model.ts'
import { openPermissionPanel } from '../../src/interaction/permission-panel.ts'
import { appendAt, pinShotClock, SHOT_CWD, SHOT_EPOCH, SHOT_MAIN_ID, withShotTime, type AppShotTree } from './boot.ts'

let messageSeq = 0

/** Reset the scripted message-id counter so each scene starts at 1. */
export function resetSceneSeq(): void {
  messageSeq = 0
}

function userMessage(text: string): UserMessage {
  return {
    id: MessageId(`shot-m-${String(++messageSeq)}`),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

function assistantMessage(content: ContentBlock[]): AssistantMessage {
  return {
    id: MessageId(`shot-m-${String(++messageSeq)}`),
    role: 'assistant',
    content,
    source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
  }
}

function toolResultMessage(callId: string, text: string): ToolResultMessage {
  return {
    id: MessageId(`shot-m-${String(++messageSeq)}`),
    role: 'tool',
    content: [{ type: 'text', text }],
    toolCallId: ToolCallId(callId),
    isError: false,
    source: { kind: 'tool', callId: ToolCallId(callId) },
  }
}

function requestHeader(session: Session, at: number): void {
  appendAt(session, at, 'request/header', {
    header: { config: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' } },
    reason: 'initial',
  })
  appendAt(session, at + 1, 'request/context', {
    provider: 'deepseek',
    model: 'deepseek-chat',
    contextWindow: 131_072,
  })
}

/**
 * The shared finished first turn: a user prompt, a thinking card, one read
 * and one bash tool card, and the closing assistant answer with usage — the
 * baseline behind `app-conversation`, `app-trace`, and `app-permission`.
 */
function scriptBaseConversation(session: Session): void {
  const t = SHOT_EPOCH
  requestHeader(session, t)
  appendAt(session, t + 10_000, 'turn/start', { turn: 1 })
  appendAt(session, t + 10_100, 'user/message', userMessage('Update the landing page hero copy and run the tests.'), { surfaceOp: 'append' })
  appendAt(session, t + 10_200, 'step/start', { turn: 1, step: 1 })
  appendAt(session, t + 11_300, 'assistant/message', {
    turn: 1,
    step: 1,
    message: assistantMessage([
      { type: 'reasoning', text: 'The hero lives in website/index.md; read it first, then edit, then run the suite.' },
      { type: 'text', text: 'I will update the hero copy first, then run the tests.' },
    ]),
    usage: { inputTokens: 12_410, outputTokens: 96, cacheReadTokens: 8_192 },
  }, { surfaceOp: 'append' })
  appendAt(session, t + 11_400, 'tool/call', {
    turn: 1, step: 1, callId: ToolCallId('call-read-1'), name: 'read',
    arguments: JSON.stringify({ file_path: 'website/index.md' }),
  })
  appendAt(session, t + 12_000, 'tool/result', {
    turn: 1, step: 1,
    message: toolResultMessage('call-read-1', '# Mayfly\n\nThe terminal UI for DeepSeek Harness.\n\nShip agent UI in a keystroke.'),
  }, { surfaceOp: 'append' })
  appendAt(session, t + 12_100, 'step/end', { turn: 1, step: 1 })
  appendAt(session, t + 12_300, 'step/start', { turn: 1, step: 2 })
  appendAt(session, t + 12_400, 'tool/call', {
    turn: 1, step: 2, callId: ToolCallId('call-bash-1'), name: 'bash',
    arguments: JSON.stringify({ command: 'pnpm run test' }),
  })
  appendAt(session, t + 15_800, 'tool/result', {
    turn: 1, step: 2,
    message: toolResultMessage('call-bash-1', '✓ 214 tests passed (12 suites)'),
  }, { surfaceOp: 'append' })
  appendAt(session, t + 16_400, 'assistant/message', {
    turn: 1,
    step: 2,
    message: assistantMessage([
      { type: 'text', text: 'Done — the hero now reads “Ship agent UI in a keystroke”, and all 214 tests pass.' },
    ]),
    usage: { inputTokens: 15_234, outputTokens: 128, cacheReadTokens: 8_192 },
  }, { surfaceOp: 'append' })
  appendAt(session, t + 16_500, 'step/end', { turn: 1, step: 2 })
  appendAt(session, t + 16_600, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
}

/** `app-conversation`: the finished turn above the editor dock and status bar. */
async function sceneConversation(tree: AppShotTree): Promise<void> {
  const agent = await tree.currentAgent()
  scriptBaseConversation(agent.session)
}

/** `app-trace`: `/trace` over the scripted log, with the selected item's raw detail open. */
async function sceneTrace(tree: AppShotTree): Promise<void> {
  const agent = await tree.currentAgent()
  scriptBaseConversation(agent.session)
  // The runtime logs the /trace execution itself into the session log, and
  // the timeline reads the log inside the handler — pin the clock so that
  // trailing `command/run` row carries a scripted time.
  const execution = await withShotTime(SHOT_EPOCH + 30_000, () =>
    tree.ctx.commands.execute(agent, '/trace', [], new AbortController().signal))
  if (execution === undefined || execution.result.kind === 'error') {
    throw new Error('app-trace: /trace did not open')
  }
  // Focus sits on the timeline panel; walk to the passing bash result and
  // open its raw detail over the timeline.
  for (let i = 0; i < 11; i += 1) tree.terminal.sendInput('\x1b[B')
  tree.terminal.sendInput('\r')
}

const AGENT_PROMPTS = {
  survey: 'Survey every website page that embeds component shots',
  readme: 'Rewrite the README hero section around the new brand',
  shots: 'Regenerate the component shot gallery',
} as const

/** One scripted child subagent session with `origin: 'subagent'` lineage. */
function scriptChildSession(tree: AppShotTree, id: string, prompt: string, at: number, outcome: 'waiting' | 'running' | 'done'): Session {
  const parent = tree.ctx.mayflyCurrentAgent.current()
  if (parent === null) throw new Error('app-agents: no current agent')
  const session = tree.ctx.sessions.create(SessionId(id), {
    meta: { cwd: SHOT_CWD, createdAt: at, origin: 'subagent', parentSession: parent.id, delegationDepth: 1 },
  })
  requestHeader(session, at + 1)
  appendAt(session, at + 100, 'user/message', userMessage(prompt), { surfaceOp: 'append' })
  appendAt(session, at + 200, 'turn/start', { turn: 1 })
  if (outcome === 'waiting') return session
  appendAt(session, at + 300, 'step/start', { turn: 1, step: 1 })
  if (outcome === 'running') {
    appendAt(session, at + 400, 'assistant/attempt', {
      turn: 1, step: 1,
      stream: [{ type: 'reasoning-chunks', time0: at + 400, index: 0, dt: [], texts: ['Mapping the hero copy against the brand tokens…'] }],
    })
    return session
  }
  appendAt(session, at + 400, 'tool/call', {
    turn: 1, step: 1, callId: ToolCallId(`${id}-call-1`), name: 'read',
    arguments: JSON.stringify({ file_path: 'website/features/index.md' }),
  })
  appendAt(session, at + 500, 'tool/result', {
    turn: 1, step: 1,
    message: toolResultMessage(`${id}-call-1`, 'three pages reference the gallery'),
  }, { surfaceOp: 'append' })
  appendAt(session, at + 600, 'step/end', { turn: 1, step: 1 })
  appendAt(session, at + 5_900, 'assistant/message', {
    turn: 1, step: 1,
    message: assistantMessage([{ type: 'text', text: 'Found three pages embedding shots.' }]),
    usage: { inputTokens: 4_812, outputTokens: 64 },
  }, { surfaceOp: 'append' })
  appendAt(session, at + 6_000, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session
}

/**
 * Pane-clock anchors for `app-agents`: the pane first renders at
 * {@link AGENTS_PANE_BASE} (arming the waiting-hold window), then the spec
 * steps the pinned clock to {@link AGENTS_PANE_FINAL} and waits for the
 * pane's own refresh timer — every elapsed label and the `waiting` phase
 * land on scripted values.
 */
export const AGENTS_PANE_BASE = SHOT_EPOCH + 3_600_000 + 21_000
export const AGENTS_PANE_FINAL = SHOT_EPOCH + 3_600_000 + 23_000

/** `app-agents`: one step spawning three subagents — done, running, waiting — in the dock pane. */
async function sceneAgents(tree: AppShotTree): Promise<void> {
  const agent = await tree.currentAgent()
  const t = SHOT_EPOCH + 3_600_000
  pinShotClock(AGENTS_PANE_BASE)

  appendAt(agent.session, t + 10_000, 'turn/start', { turn: 1 })
  appendAt(agent.session, t + 10_100, 'user/message', userMessage('Split the rebranding into parallel tracks.'), { surfaceOp: 'append' })
  appendAt(agent.session, t + 10_200, 'step/start', { turn: 1, step: 1 })
  appendAt(agent.session, t + 11_000, 'tool/call', {
    turn: 1, step: 1, callId: ToolCallId('call-agent-1'), name: 'subagent',
    arguments: JSON.stringify({ description: 'Survey shot embeds', prompt: AGENT_PROMPTS.survey }),
  })
  appendAt(agent.session, t + 11_100, 'tool/call', {
    turn: 1, step: 1, callId: ToolCallId('call-agent-2'), name: 'subagent',
    arguments: JSON.stringify({ description: 'Rewrite README hero', prompt: AGENT_PROMPTS.readme }),
  })
  appendAt(agent.session, t + 12_100, 'tool/call', {
    turn: 1, step: 1, callId: ToolCallId('call-agent-3'), name: 'subagent',
    arguments: JSON.stringify({ description: 'Regenerate shot gallery', prompt: AGENT_PROMPTS.shots }),
  })

  // Child sessions start once their spawn call exists; the done child's
  // turn/end (t+19s) lands before its acknowledgement (t+20s).
  const done = scriptChildSession(tree, 'a11ce000-a11a', AGENT_PROMPTS.survey, t + 13_000, 'done')
  const running = scriptChildSession(tree, 'b22df000-b22b', AGENT_PROMPTS.readme, t + 13_500, 'running')
  scriptChildSession(tree, 'c33ef000-c33c', AGENT_PROMPTS.shots, t + 14_500, 'waiting')

  appendAt(agent.session, t + 11_900, 'tool/result', {
    turn: 1, step: 1,
    message: toolResultMessage('call-agent-2', `started subagent ${String(running.id)}`),
  }, { surfaceOp: 'append' })
  appendAt(agent.session, t + 20_000, 'tool/result', {
    turn: 1, step: 1,
    message: toolResultMessage('call-agent-1', `started subagent ${String(done.id)}\nSurvey complete: three pages embed the gallery.`),
  }, { surfaceOp: 'append' })
}

/** Step the pinned pane clock past the waiting hold; called between the two renders. */
export function sceneAgentsAdvanceClock(): void {
  pinShotClock(AGENTS_PANE_FINAL)
}

/** `app-permission`: the bare-`/permission` preset picker in the editor slot. */
async function scenePermission(tree: AppShotTree): Promise<void> {
  const agent = await tree.currentAgent()
  scriptBaseConversation(agent.session)
  if (tree.ctx.mayflyCurrentAgent.current() === null) throw new Error('app-permission: no current agent')
  openPermissionPanel(tree.ctx)
}

/** Fabricated persisted headers for the `/sessions` lineage tree (fixed ids/times). */
function sessionHeader(
  id: string,
  createdAt: number,
  parentSession?: string,
  shot: { readonly updatedAt?: number, readonly usage?: { uncachedInputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number }, readonly stats?: { turns: number, steps: number, llmMs: number, toolMs: number, ttftMs: number, ttftSteps: number, decodeMs: number, decodeTokens: number } } = {},
): SessionHeader {
  return {
    version: 1,
    id: SessionId(id),
    createdAt,
    cwd: SHOT_CWD,
    ...(parentSession === undefined ? {} : { parentSession: SessionId(parentSession) }),
    ...(shot.updatedAt === undefined ? {} : { shotUpdatedAt: shot.updatedAt }),
    ...(shot.usage === undefined ? {} : { shotUsage: shot.usage }),
    ...(shot.stats === undefined ? {} : { shotStats: shot.stats }),
  } as SessionHeader
}

/** `/sessions` starts with cwd groups; the workspace scene shows its lineage list. */
async function sceneSessions(tree: AppShotTree): Promise<void> {
  const agent = await tree.currentAgent()
  const day = 86_400_000
  const hour = 3_600_000
  tree.setPersistedHeaders([
    sessionHeader('shot-root', SHOT_EPOCH - 3 * day, undefined, {
      updatedAt: SHOT_EPOCH - 3 * day + 2 * hour,
      usage: { uncachedInputTokens: 4_100, outputTokens: 1_900, cacheReadTokens: 28_000, cacheWriteTokens: 900 },
      stats: { turns: 6, steps: 14, llmMs: 74_000, toolMs: 9_000, ttftMs: 800, ttftSteps: 6, decodeMs: 60_000, decodeTokens: 1_900 },
    }),
    sessionHeader('shot-topic', SHOT_EPOCH - 2 * day, 'shot-root', {
      updatedAt: SHOT_EPOCH - 2 * day + 45 * 60_000,
      usage: { uncachedInputTokens: 1_300, outputTokens: 400, cacheReadTokens: 9_000, cacheWriteTokens: 0 },
    }),
    { ...agent.session.header, shotUpdatedAt: SHOT_EPOCH + 30_000 } as SessionHeader,
    sessionHeader('shot-side', SHOT_EPOCH - day, 'shot-root', {
      updatedAt: SHOT_EPOCH - day + 8 * hour,
      usage: { uncachedInputTokens: 64_000, outputTokens: 12_000, cacheReadTokens: 480_000, cacheWriteTokens: 3_000 },
      stats: { turns: 11, steps: 29, llmMs: 9 * 60_000, toolMs: 42_000, ttftMs: 1_100, ttftSteps: 11, decodeMs: 7 * 60_000, decodeTokens: 12_000 },
    }),
    sessionHeader('shot-hotfix', SHOT_EPOCH - 4 * day, undefined, { updatedAt: SHOT_EPOCH - 4 * day + 90_000 }),
    sessionHeader('shot-hotfix-2', SHOT_EPOCH - 4 * day + hour, 'shot-hotfix', { updatedAt: SHOT_EPOCH - 4 * day + hour + 12 * 60_000 }),
    { ...sessionHeader('shot-docs', SHOT_EPOCH - day), cwd: '/home/mayfly/docs' },
    { ...sessionHeader('shot-api', SHOT_EPOCH - 2 * day), cwd: '/home/mayfly/api' },
  ])
  tree.setPersistedTitles(new Map([
    ['shot-root', 'Mayfly branding exploration'],
    ['shot-topic', 'Trace panel polish'],
    [SHOT_MAIN_ID, 'App-level screenshot pipeline'],
    ['shot-side', 'Sidebar panes'],
    ['shot-hotfix', 'Hotfix release notes'],
    ['shot-hotfix-2', 'Hotfix follow-up'],
  ]))
  const execution = await withShotTime(SHOT_EPOCH + 60_000, async () => {
    const result = await tree.ctx.commands.execute(agent, '/sessions', [], new AbortController().signal)
    await waitForRender()
    return result
  })
  if (execution === undefined || execution.result.kind === 'error') {
    throw new Error(`app-sessions: /sessions did not open (${JSON.stringify(execution?.result ?? null)})`)
  }
}

async function sceneSessionWorkspace(tree: AppShotTree): Promise<void> {
  await sceneSessions(tree)
  const agent = await tree.currentAgent()
  await withShotTime(SHOT_EPOCH + 60_000, async () => {
    const picker = tree.ctx.mayflyUiInteraction.get('overlay', 'mayfly.sessions')!
    picker.emit({ kind: 'selection-accept', pagePath: [], controlId: 'workspaces', selectedIds: [sessionWorkspaceId(agent.session.header.cwd)] })
    await waitForRender()
  })
}

/** Scene runners keyed by the ids of `script/shots/app-manifest.mjs`. */
export const APP_SCENE_RUNNERS: Record<string, (tree: AppShotTree) => Promise<void>> = {
  'app-conversation': sceneConversation,
  'app-trace': sceneTrace,
  'app-agents': sceneAgents,
  'app-permission': scenePermission,
  'app-sessions': sceneSessions,
  'app-session-workspace': sceneSessionWorkspace,
}
