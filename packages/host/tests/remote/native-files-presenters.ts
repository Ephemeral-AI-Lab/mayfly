/** Real pinned native filesystem definitions, collected without executing filesystem mutations. @module */
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '@deepseek-ai/dsh-tool-fs'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/** Register the real builtin definitions and retain their official call/result presenters. */
export function nativeFilePresenters(): ReadonlyMap<string, ToolDefinition> {
  const definitions = new Map<string, ToolDefinition>()
  const ctx = {
    fs: {},
    systemPrompt: { section() {}, getSectionOrder: () => 0 },
    tools: { register: (definition: ToolDefinition) => { definitions.set(definition.name, definition) } },
  } as unknown as Context
  apply(ctx, { read: true, readImage: false, write: true, edit: true, readLimit: 2000, readMaxLineLength: 2000, readMaxBytes: 50 * 1024, readStreamMinSize: 64 * 1024 })
  return definitions
}
