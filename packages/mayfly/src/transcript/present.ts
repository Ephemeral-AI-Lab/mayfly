/**
 * Pure tool-presentation resolution: parse raw argument JSON and ask the host
 * tool registry's `presentCall`/`presentResult` hooks for canonical views.
 * Every presenter call is contained —
 * an unknown tool, a missing presenter, or a throwing presenter all yield
 * `undefined` and the generic presentation carries on. The module also owns
 * the shared presentation pure helper {@link ellipsize}.
 *
 * @module @ephemeral-ai/mayfly/transcript/present
 */

import type {
  ToolCallView,
  ToolResult,
  ToolResultView,
} from '@deepseek-ai/dsh-tools'

/** The presenter-bearing face of a tool registry the resolvers read (structural, scope-agnostic). */
export interface ToolPresentationSource {
  /** The presenter-bearing definition the source resolves, or `undefined` when none is visible. */
  get(name: string): { readonly presentCall?: (args: unknown) => unknown; readonly presentResult?: (args: unknown, result: ToolResult) => unknown } | undefined
}

/**
 * Collapse a multi-line string to one ellipsized line.
 * @param text - the text to flatten.
 * @param maxChars - the maximum string length (not terminal columns) kept.
 * @returns whitespace-collapsed text, ellipsized beyond `maxChars`.
 */
export function ellipsize(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars - 1)}…`
}

/**
 * Parse a tool call's raw arguments JSON.
 * @param raw - the arguments string exactly as the model produced it.
 * @returns the parsed value, or `undefined` when the string is invalid JSON.
 */
export function parseToolArguments(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/**
 * Resolve the pending-call canonical view for one tool call.
 * @param tools - the host tool registry.
 * @param name - the tool name exactly as the model requested it.
 * @param args - the parsed arguments (`undefined` when parsing failed).
 * @returns the call view, or `undefined` when the tool is unknown, declares
 *   no presenter, or its presenter throws.
 */
export function resolveCallView(
  tools: ToolPresentationSource,
  name: string,
  args: unknown,
): ToolCallView | undefined {
  try {
    return tools.get(name)?.presentCall?.(args) as ToolCallView | undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve the completed-call canonical view for one tool call.
 * @param tools - the host tool registry.
 * @param name - the tool name exactly as the model requested it.
 * @param args - the parsed arguments (`undefined` when parsing failed).
 * @param result - the reconstructed tool result (`content`, `isError`, `meta`).
 * @returns the result view, or `undefined` when the tool is unknown, declares
 *   no presenter, or its presenter throws.
 */
export function resolveResultView(
  tools: ToolPresentationSource,
  name: string,
  args: unknown,
  result: ToolResult,
): ToolResultView | undefined {
  try {
    return tools.get(name)?.presentResult?.(args, result) as ToolResultView | undefined
  } catch {
    return undefined
  }
}
