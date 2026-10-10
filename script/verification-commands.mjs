/** Produce the commands actually executed by a verification plan. @module script/verification-commands */

import { existsSync } from 'node:fs'

function pnpm(...args) {
  return ['pnpm', args]
}

/** Return the ordered executable checks, keeping manual acceptance out of the command list. */
export function commandsForPlan(plan, { smoke = false } = {}) {
  if (plan.mode === 'none') return []
  if (plan.mode === 'full') {
    const scripts = [
      'test:repo-workflow', 'typecheck', 'lint', 'diagrams:check', 'build', 'check:lib',
      'shots:check', 'check:agent-docs', 'check:examples',
      ...(plan.checks.pack ? ['check:pack'] : []),
      ...(plan.checks.website ? ['website:build'] : []),
      // One run: coverage against the repository floor, with every retained-row hit painted again and compared.
      'test:coverage',
      // The real terminal: the happy smoke and the bench against its coarse ceilings, both on the build above.
      ...(smoke ? ['smoke:happy', 'bench:pty:assert'] : []),
    ]
    return scripts.map(script => pnpm('run', script))
  }
  const commands = []
  // The repository-workflow tests the change reaches, and only those.
  if (plan.tests.nodeTests.length > 0) commands.push(['node', ['--test', ...plan.tests.nodeTests]])
  if (plan.checks.agentDocs) commands.push(pnpm('run', 'check:agent-docs'))
  if (plan.checks.lint) {
    const lintFiles = plan.files.filter(file => /^(?:packages|examples)\/.+\.(?:[cm]?ts|tsx)$/u.test(file) && existsSync(file))
    if (lintFiles.length > 0) commands.push(pnpm('exec', 'oxlint', ...lintFiles))
  }
  if (plan.checks.typecheck && !plan.checks.build) commands.push(pnpm('run', 'typecheck'))
  if (plan.checks.diagrams) commands.push(pnpm('run', 'diagrams:check'))
  if (plan.checks.build) commands.push(pnpm('run', 'build:changed', '--', '--files-json', JSON.stringify(plan.files)))
  if (plan.checks.checkLib) commands.push(pnpm('run', 'check:lib'))
  if (plan.checks.shots) commands.push(pnpm('run', 'shots:check'))
  if (plan.checks.examples) commands.push(pnpm('run', 'check:examples'))
  if (plan.checks.pack) commands.push(pnpm('run', 'check:pack'))
  if (plan.checks.website) commands.push(pnpm('run', 'website:build'))

  // The specs the import graph carries the change to (plan.tests.why holds each chain). A local run never measures
  // coverage (D29); the full tier reports it against the repository floor.
  if (plan.tests.specs.length > 0) commands.push(pnpm('exec', 'vitest', 'run', ...plan.tests.specs, '--reporter=dot', '--silent=passed-only'))
  if (smoke || plan.checks.smoke) commands.push(pnpm('run', 'smoke:happy'))
  return commands
}
