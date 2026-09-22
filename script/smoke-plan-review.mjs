// Interactive PTY smoke for the flow-mounted plan review (manual — not in
// CI): boots the real dsh CLI under a pseudo-terminal against the mock LLM,
// toggles plan mode, then drives three `exit_plan_mode` reviews — the first
// exercises document scrolling (wheel + PgUp/PgDn), copy, and the inline
// Other input before submitting custom feedback, the second declines, and
// the third approves — before settling on a plain success turn.
// Run: node script/smoke-plan-review.mjs (self-contained: installs its own
// throwaway profile)

import { createRequire } from 'node:module'
import { existsSync, readdirSync, chmodSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  assertDshVersion,
  cleanOutput,
  installIntoThrowawayProfile,
  registerCleanup,
  resolveDshBin,
} from './smoke-lib.mjs'

const require = createRequire(import.meta.url)
const pty = require('node-pty')

try {
  const store = join(import.meta.dirname, '..', 'node_modules', '.pnpm')
  if (existsSync(store)) {
    for (const entry of readdirSync(store)) {
      if (!entry.startsWith('node-pty@')) continue
      const helper = join(store, entry, 'node_modules', 'node-pty', 'spawn-helper')
      if (existsSync(helper) && (statSync(helper).mode & 0o111) === 0) {
        chmodSync(helper, 0o755)
        console.log(`==> Restored spawn-helper execute bit under ${entry}`)
      }
    }
  }
} catch {
}

const dshBin = resolveDshBin()
assertDshVersion(dshBin)
const { home, envFor } = installIntoThrowawayProfile(dshBin, 'mayfly-smoke-plan')
registerCleanup(home)

// The plan body is deliberately taller than any smoke viewport so scrolling
// is required to read it: STEP-01 hides above the fold while STEP-36 anchors
// the tail the follow-content pin lands on.
const planBody = [
  '# Smoke Plan',
  '',
  ...Array.from({ length: 36 }, (_, index) => `${index + 1}. STEP-${String(index + 1).padStart(2, '0')} implementation detail`),
  '',
  '## Rationale',
  '',
  'Screen-space selection copies clean rows.',
].join('\n')

const { startMockLlmServer } = require('@deepseek-ai/dsh-llm-mock-server')
const server = await startMockLlmServer({
  port: 0,
  // The second slot is the background session-title request that fires after
  // the first human message lands — it must not consume a tool_call. The run
  // exercises all three settlements: Other feedback, decline, approve.
  sequence: ['tool_call_success', 'success', 'tool_call_success', 'tool_call_success', 'success'],
  repeatLast: true,
  toolName: 'exit_plan_mode',
  toolArguments: JSON.stringify({ plan: planBody }),
  successText: 'SMOKE_PLAN_DONE',
})

const COLS = Number(process.env.SMOKE_COLS ?? 100)
const ROWS = Number(process.env.SMOKE_ROWS ?? 30)
console.log(`==> PTY boot: dsh --profile mayfly-smoke-plan at ${COLS}x${ROWS}`)
const term = pty.spawn(dshBin, ['--profile', 'mayfly-smoke-plan'], {
  name: 'xterm-256color',
  cols: COLS,
  rows: ROWS,
  cwd: import.meta.dirname,
  env: envFor({
    DEEPSEEK_BASE_URL: `${server.baseURL}/v1`,
    DEEPSEEK_API_KEY: 'mayfly-smoke-key',
    COLUMNS: undefined,
    LINES: undefined,
  }),
})

let out = ''
let exitCode = null
term.onData(data => { out += data })
term.onExit(({ exitCode: code }) => { exitCode = code })

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const deadline = Date.now() + 150_000
async function waitFor(predicate, label) {
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(200)
  }
  console.error(`FAIL: timed out waiting for ${label}`)
  return false
}

const clean = () => cleanOutput(out)

try {
  if (!(await waitFor(() => clean().includes('deepseek-flash'), 'the statusline boot frame'))) throw new Error('boot')
  // The session attaches asynchronously after the first frame; /mode answered
  // with 'no active session' must retry until the agent is bound.
  for (let attempt = 0; attempt < 8 && !clean().includes('Plan mode on'); attempt += 1) {
    const probe = clean().length
    term.write('/mode\r')
    await waitFor(() => clean().includes('Plan mode on') || clean().slice(probe).includes('no active session'), 'the /mode reply')
    if (!clean().includes('Plan mode on')) await sleep(2000)
  }
  if (!clean().includes('Plan mode on')) throw new Error('mode')
  await sleep(300)
  term.write('ship it\r')

  // First review: the document mounts into the content flow — its markdown
  // renders as plain rows — while the editor dock keeps only the numbered
  // decision list. The document tail pins to the viewport bottom, so the
  // first step sits above the fold until the content scrolls back.
  if (!(await waitFor(() => clean().includes('STEP-36'), 'the plan document tail in the content flow'))) throw new Error('document tail')
  if (!(await waitFor(() => clean().includes('2. Keep planning'), 'the seeded decline row'))) throw new Error('decision list')
  const roomy = ROWS >= 28
  if (roomy && !(await waitFor(() => clean().includes('1. Approve') && clean().includes('3. Other'), 'the full numbered list'))) throw new Error('list rows')
  if (roomy && !clean().includes('scroll plan')) throw new Error('scroll hint')

  // Wheel reports over the content region stay raw for the transcript
  // ScrollView even while the dock surface is focused; enough ticks reveal
  // the document top. The exit_plan_mode card above may already quote the
  // plan head, so scrolling is proven by repaint order, not first presence:
  // the top rows must paint after the tail's last frame.
  const tailBefore = () => clean().lastIndexOf('STEP-36')
  const anchor = tailBefore()
  for (let tick = 0; tick < 40; tick += 1) term.write('\x1b[<64;5;5M')
  if (!(await waitFor(() => clean().lastIndexOf('STEP-01') > anchor, 'the document top after wheel scrolling'))) throw new Error('wheel scroll')
  // PgDn then pages back down through the surface's delegated scroll keys.
  term.write('\x1b[6~')
  term.write('\x1b[6~')
  term.write('\x1b[6~')
  if (!(await waitFor(() => clean().lastIndexOf('STEP-36') > clean().lastIndexOf('STEP-01'), 'the document tail after PgDn'))) throw new Error('page scroll')

  // Copy plan: keyed 'c' while the decision page is active reports clipboard
  // feedback without settling the request.
  term.write('c')
  if (!(await waitFor(() => clean().toLowerCase().includes('clipboard'), 'the copy feedback'))) throw new Error('copy')
  if (!(await waitFor(() => clean().includes('2. Keep planning'), 'the still-open review after copy'))) throw new Error('copy settle')

  // The 'o' accelerator swaps the Other input into the same surface — no tab
  // navigation — even when the third list row is clipped. Typing lands in the
  // focused textarea; Tab leaves the field and Enter submits the feedback.
  term.write('o')
  if (!(await waitFor(() => clean().includes('Tell the model what to change'), 'the Other input'))) throw new Error('other input')
  term.write('tweak it')
  if (!(await waitFor(() => clean().includes('tweak it'), 'the typed feedback'))) throw new Error('feedback typing')
  term.write('\t')
  await sleep(300)
  term.write('\r')
  if (!(await waitFor(() => clean().lastIndexOf('Approve this plan and leave plan') > clean().lastIndexOf('Tell the model'), 'the reopened review after feedback'))) throw new Error('second review')

  // Choose rows by the painted cursor rather than a fixed key count: the
  // list restores its own focused row after page navigation, and the seed
  // may already sit on the target row. `→ N.` is the focused-row marker.
  const cursorRow = () => {
    const marks = [...clean().matchAll(/→ ([123])\. /g)]
    return marks.length === 0 ? 0 : Number(marks.at(-1)[1])
  }
  const chooseRow = async (row, label) => {
    for (let press = 0; press < 4 && cursorRow() !== row; press += 1) {
      term.write(cursorRow() < row ? '\x1b[B' : '\x1b[A')
      await sleep(250)
    }
    if (cursorRow() !== row) throw new Error(`cursor never reached ${label}`)
    term.write('\r')
  }
  await chooseRow(2, 'the decline row')
  if (!(await waitFor(() => {
    const c = clean()
    return c.includes('plan declined') && c.lastIndexOf('Approve this plan and leave plan') > c.lastIndexOf('plan declined')
  }, 'the reopened review'))) throw new Error('third review')

  // Third review: a fresh surface seeds focus on the decline row again, so
  // the cursor only has to reach approve; Enter settles the plan and the
  // turn ends with the final scripted success text. Approval has no card
  // text of its own — it is proven by the turn completing without a second
  // decline card and the statusline dropping its 'plan' mode tag.
  await chooseRow(1, 'the approve row')
  if (!(await waitFor(() => clean().includes('SMOKE_PLAN_DONE'), 'the post-approve success turn'))) throw new Error('settlement')
  const declined = clean().split('plan declined').length - 1
  if (declined !== 1) throw new Error(`expected exactly one decline card, saw ${declined}`)
  if (!(await waitFor(() => /deepseek-flash(?!\s+plan)/.test(clean()), 'the plan-mode statusline tag to drop'))) throw new Error('approve')

  for (let press = 0; press < 4 && exitCode === null; press++) {
    term.write('\x03')
    await sleep(700)
  }
  if (!(await waitFor(() => exitCode !== null, 'clean exit'))) throw new Error('exit')
} catch (error) {
  console.error(`FAIL: ${error.message}`)
  console.error('--- PTY output tail ---')
  console.error(clean().slice(-2000))
  const dump = `/tmp/mayfly-plan-smoke-${Date.now()}.log`
  writeFileSync(dump, out)
  console.error(`--- full PTY stream: ${dump} ---`)
  for (const record of server.requests) {
    const last = record.body?.messages?.at(-1)
    console.error(`--- req ${record.attempt}: ${record.scriptBehavior} <- ${JSON.stringify(last?.role)} ${JSON.stringify(String(last?.content ?? last?.tool_calls ?? '').slice(0, 80))}`)
  }
  term.kill()
  await server.close()
  process.exit(1)
}
await server.close()

const final = clean()
const ok = exitCode === 0
  && !final.includes('exceeds terminal width')
  && !final.includes('Uncaught')
  && !final.includes('pi-crash.log')
if (!ok) {
  console.error(`FAIL: exit=${exitCode}`)
  console.error(final.slice(-2000))
  process.exit(1)
}
console.log(`PLAN_REVIEW_SMOKE_PASS exit=${exitCode}`)
