/** Produce the commands actually executed by a verification plan. @module script/verification-commands */

function pnpm(...args) {
  return ['pnpm', args]
}

/** Return the ordered executable checks, keeping manual acceptance out of the command list. */
export function commandsForPlan(plan, { smoke = false } = {}) {
  if (plan.mode === 'none') return []
  if (plan.mode === 'full') {
    const scripts = [
      'test:repo-workflow', 'typecheck', 'lint', 'diagrams:check', 'build', 'check:lib',
      'shots:check', 'design:golden:check', 'check:agent-docs', 'check:examples',
      ...(plan.checks.pack ? ['check:pack'] : []),
      ...(plan.checks.website ? ['website:build'] : []),
      'test:coverage',
      ...(smoke ? ['smoke:happy'] : []),
    ]
    return scripts.map(script => pnpm('run', script))
  }
  const commands = []
  if (plan.checks.repoWorkflowTests) commands.push(pnpm('run', 'test:repo-workflow'))
  if (plan.checks.agentDocs) commands.push(pnpm('run', 'check:agent-docs'))
  if (plan.checks.lint) {
    const lintFiles = plan.files.filter(file => /^(?:packages|examples)\/.+\.(?:[cm]?ts|tsx)$/u.test(file))
    if (lintFiles.length > 0) commands.push(pnpm('exec', 'oxlint', ...lintFiles))
  }
  if (plan.checks.typecheck && !plan.checks.build) commands.push(pnpm('run', 'typecheck'))
  if (plan.checks.diagrams) commands.push(pnpm('run', 'diagrams:check'))
  if (plan.checks.build) commands.push(pnpm('run', 'build:changed', '--', '--files-json', JSON.stringify(plan.files)))
  if (plan.checks.checkLib) commands.push(pnpm('run', 'check:lib'))
  if (plan.checks.shots) commands.push(pnpm('run', 'shots:check'))
  if (plan.checks.designGolden) commands.push(pnpm('run', 'design:golden:check'))
  if (plan.checks.examples) commands.push(pnpm('run', 'check:examples'))
  if (plan.checks.pack) commands.push(pnpm('run', 'check:pack'))
  if (plan.checks.website) commands.push(pnpm('run', 'website:build'))

  const coverage = []
  if (plan.tests.coverage.length > 0) {
    coverage.push('--coverage', '--coverage.reporter=text')
    for (const file of plan.tests.coverage) coverage.push('--coverage.include', file)
  }
  if (plan.tests.packageTests.length > 0) {
    const focused = [...new Set([...plan.tests.packageTests, ...plan.tests.direct])]
    commands.push(pnpm('exec', 'vitest', 'run', ...focused, ...coverage, '--reporter=dot', '--silent=passed-only'))
  } else if (plan.tests.related.length > 0) {
    const related = [...new Set([...plan.tests.related, ...plan.tests.direct])]
    commands.push(pnpm('exec', 'vitest', 'related', ...related, '--run', ...coverage, '--reporter=dot', '--silent=passed-only'))
  } else if (plan.tests.direct.length > 0) {
    commands.push(pnpm('exec', 'vitest', 'run', ...plan.tests.direct, '--reporter=dot', '--silent=passed-only'))
  }
  if (smoke) commands.push(pnpm('run', 'smoke:happy'))
  return commands
}
