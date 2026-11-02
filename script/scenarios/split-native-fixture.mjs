/** Identical native builtin calls and isolated Git seeds for split PTY acceptance. @module */
import { execFileSync } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Seed only the runner-owned workspace; both Harness versions receive these exact committed bytes. */
export function seedSplitNativeWorkspace(cwd, fixture) {
  if (fixture !== 'native-files') return
  rmSync(join(cwd, 'parity-deliverable.txt'), { force: true })
  writeFileSync(join(cwd, 'parity-change.txt'), 'before parity change\nunchanged line\n')
  const git = args => execFileSync('git', args, { cwd, env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T08:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T08:00:00Z' }, stdio: 'pipe' })
  git(['init', '-b', 'master'])
  git(['-c', 'user.name=Parity Fixture', '-c', 'user.email=parity@example.invalid', 'add', 'parity-change.txt'])
  if (!existsSync(join(cwd, '.git', 'refs', 'heads', 'master'))) git(['-c', 'user.name=Parity Fixture', '-c', 'user.email=parity@example.invalid', 'commit', '-m', 'Seed native parity comparison'])
}

const questions = [
  { id: 'route', header: 'Route', question: 'Choose a delivery route', options: [{ label: 'First route', description: 'Keep the current route' }, { label: 'Second route', description: 'Use the alternative route' }] },
  { id: 'scope', header: 'Scopes', question: 'Choose the scopes', multi_select: true, options: [{ label: 'read' }, { label: 'write' }] },
  { id: 'notes', header: 'Notes', question: 'Add a delivery note' },
]

/** Select actual Harness tools from the latest fixture prompt, including every real tool result between phases. */
export function splitNativeInstruction(body) {
  const messages = body.messages ?? []
  const index = messages.findLastIndex(message => message.role === 'user' && /native:(?:question|files):[a-z-]+/u.test(JSON.stringify(message)))
  if (index < 0) return undefined
  const [, mode, label] = /native:(question|files):([a-z-]+)/u.exec(JSON.stringify(messages[index]))
  const used = new Set()
  const visit = value => {
    if (Array.isArray(value)) { for (const entry of value) visit(entry); return }
    if (typeof value !== 'object' || value === null) return
    if (value.type === 'tool_use') used.add(value.name)
    for (const child of Object.values(value)) visit(child)
  }
  visit(messages.slice(index + 1))
  const phases = mode === 'question'
    ? [{ name: 'ask_user_question', input: { questions: label === 'wizard' ? questions : [questions[0]] } }]
    : [
      { name: 'read', input: { file_path: 'parity-change.txt' } },
      { name: 'edit', input: { file_path: 'parity-change.txt', old_string: 'before parity change', new_string: 'after parity change' } },
      { name: 'write', input: { file_path: 'parity-deliverable.txt', content: 'Native delivered file\nExact preview 你好 🪰\n' } },
      { name: 'present', input: { files: [{ path: 'parity-deliverable.txt', description: 'Deterministic native delivery' }] } },
    ]
  const phase = phases.find(phase => !used.has(phase.name))
  return phase === undefined ? { completed: true, reply: `Native ${mode} finished: ${label}` } : { ...phase, id: `native_${mode}_${phase.name}`, completed: false }
}
