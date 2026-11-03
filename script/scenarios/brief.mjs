/**
 * The brief of a catalog scenario: the `review` field that tells a person which effects a part implemented, where to
 * look, what differs from the prototype, and what is not done yet (docs/design/component-development-spec.md §5). It is
 * data of the scenario, so `pnpm run scenario` prints it before the product boots, `pnpm run frame` writes it beside
 * the checkpoints as `brief.md`, and `--list` marks the scenarios that carry one. @module script/scenarios/brief
 */

/** The sections of a review, in the order they print. */
const SECTIONS = Object.freeze([
  ['implemented', 'Implemented'],
  ['focus', 'Look at'],
  ['differs', 'Differs from the prototype'],
  ['pending', 'Not done yet'],
])

/**
 * The prototype command that draws the same scene, for the two-terminal comparison.
 * @param review - a scenario's review field.
 * @returns the command, or undefined when the scenario has no prototype scene.
 */
export function prototypeCommand(review) {
  return review?.scene === undefined ? undefined : `node docs/design/prototypes/ui-preview.mjs ${String(review.scene)}`
}

/** One bullet of a section: a focus entry is its question and the walk that reaches it. */
const entryText = (section, entry) => (section === 'focus' ? `${entry.look} — ${entry.how}` : entry)

/**
 * Check a review field's shape.
 * @param review - a scenario's review field.
 * @returns the problems found, empty when it is well formed.
 */
export function reviewProblems(review) {
  const problems = []
  if (typeof review.reference !== 'string' || review.reference === '') problems.push('reference must be a non-empty string')
  if (review.scene !== undefined && !(Number.isInteger(review.scene) && review.scene > 0)) problems.push('scene must be a positive integer')
  for (const [section] of SECTIONS) {
    const entries = review[section]
    if (!Array.isArray(entries)) { problems.push(`${section} must be an array`); continue }
    entries.forEach((entry, index) => {
      const ok = section === 'focus'
        ? typeof entry?.look === 'string' && entry.look !== '' && typeof entry?.how === 'string' && entry.how !== ''
        : typeof entry === 'string' && entry !== ''
      if (!ok) problems.push(`${section}[${String(index)}] is malformed`)
    })
  }
  if (Array.isArray(review.implemented) && review.implemented.length === 0) problems.push('implemented must name at least one effect')
  if (Array.isArray(review.focus) && review.focus.length > 8) problems.push('focus has more than eight items: split the part')
  return problems
}

/**
 * The brief as terminal text.
 * @param name - the scenario name.
 * @param scenario - the catalog entry.
 * @returns the text, or an empty string when the scenario has no review.
 */
export function briefText(name, scenario) {
  const review = scenario.review
  if (review === undefined) return ''
  const lines = [`Brief: ${name}`, `  Reference: ${review.reference}`]
  const command = prototypeCommand(review)
  if (command !== undefined) lines.push(`  Sketch:    ${command}`)
  for (const [section, title] of SECTIONS) {
    const entries = review[section]
    if (entries.length === 0) continue
    lines.push('', `${title}`)
    entries.forEach((entry, index) => lines.push(section === 'focus' ? `  ${String(index + 1)}. ${entryText(section, entry)}` : `  · ${entryText(section, entry)}`))
  }
  return `${lines.join('\n')}\n`
}

/**
 * The brief as Markdown, for `brief.md` beside a scenario's frames.
 * @param name - the scenario name.
 * @param scenario - the catalog entry.
 * @returns the document, or an empty string when the scenario has no review.
 */
export function briefMarkdown(name, scenario) {
  const review = scenario.review
  if (review === undefined) return ''
  const lines = [`# Brief: ${name}`, '', `Reference: ${review.reference}`]
  const command = prototypeCommand(review)
  if (command !== undefined) lines.push('', `Sketch: \`${command}\``)
  for (const [section, title] of SECTIONS) {
    const entries = review[section]
    if (entries.length === 0) continue
    lines.push('', `## ${title}`, '')
    entries.forEach((entry, index) => lines.push(section === 'focus' ? `${String(index + 1)}. ${entryText(section, entry)}` : `- ${entryText(section, entry)}`))
  }
  return `${lines.join('\n')}\n`
}

/**
 * One line of `pnpm run scenario --list`: briefed scenarios carry a `*`.
 * @param name - the scenario name.
 * @param scenario - the catalog entry.
 * @returns the line.
 */
export function listLine(name, scenario) {
  return `${scenario.review === undefined ? ' ' : '*'} ${name.padEnd(24)}${scenario.summary}`
}
