/**
 * The small test doubles every area once copied by hand: the identity colour,
 * the event-loop flush, ANSI-stripping text views, the paint-nothing palette,
 * and a canonical fake Agent with its scripted session.
 * @module @ephemeral-ai/mayfly/tests/helpers
 */

import { vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { MayflySemanticColors } from '../src/core/types.ts'

/** A colour that returns its text: the paint-nothing palette's role. */
export const identity = (text: string): string => text

/**
 * Let pending async work progress `times` rounds. Each round yields one
 * event-loop turn through `setImmediate`, draining every queued microtask.
 * When `setImmediate` itself is faked (`vi.useFakeTimers()` without a
 * `toFake` allowlist) it never fires, so the rounds drain the microtask
 * queue directly instead — the only progress a faked clock permits.
 */
export async function flush(times = 1): Promise<void> {
  const setImmediateLive = (): boolean => {
    if (!vi.isFakeTimers()) return true
    const before = vi.getTimerCount()
    const id = setImmediate(() => {})
    const live = vi.getTimerCount() === before
    clearImmediate(id)
    return live
  }
  if (setImmediateLive()) {
    for (let index = 0; index < times; index += 1) {
      await new Promise<void>(resolve => { setImmediate(resolve) })
    }
    return
  }
  for (let index = 0; index < Math.max(times, 8); index += 1) await Promise.resolve()
}

/** Strip every invisible sequence: OSC bands (links, titles), APC bands (the cursor marker), and CSI finals (styles, erases, cursor moves). */
export const plainText = (text: string): string =>
  text.replace(/\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|_[^\x07]*\x07|\[[0-?]*[ -/]*[@-~])/gu, '')

/** The ANSI-free view of painted rows. */
export const plain = (rows: readonly string[] | undefined): string[] => (rows ?? []).map(plainText)

/** Painted rows joined into one ANSI-free block. */
export const plainBlock = (rows: readonly string[] | undefined): string => plainText((rows ?? []).join('\n'))

/** A colour that tags its text `[letter]text[/letter]`, for role assertions. */
export const colorTag = (letter: string) => (text: string): string => `[${letter}]${text}[/${letter}]`

/**
 * A palette that paints nothing: every role is `identity`. A real object, so
 * callers can spread it to tag the colours a spec marks.
 */
export function plainColors(): MayflySemanticColors {
  return {
    text: identity, textStrong: identity, muted: identity, textMuted: identity,
    accent: identity, primary: identity, border: identity, borderFocus: identity,
    success: identity, error: identity, warning: identity, selectedBg: identity,
    roleUser: identity, shellMode: identity,
    mdHeading: identity, mdLink: identity, mdLinkUrl: identity, mdCode: identity,
    mdCodeBlock: identity, mdCodeBlockBorder: identity, mdQuote: identity,
    mdQuoteBorder: identity, mdHr: identity, mdListBullet: identity,
    diffAdded: identity, diffRemoved: identity, diffAddedStrong: identity,
    diffRemovedStrong: identity, diffGutter: identity, diffMeta: identity,
    diffAddedBg: identity, diffRemovedBg: identity,
    modelHighlight: identity, logoGradient: [identity],
  }
}

/** The group-spec palette: identity colours, the six status roles letter-tagged. */
export const taggedColors = (): MayflySemanticColors => ({
  ...plainColors(),
  muted: colorTag('M'), textMuted: colorTag('T'), primary: colorTag('P'),
  success: colorTag('S'), error: colorTag('E'), warning: colorTag('W'),
})

/** The scripted session the fake Agent carries. */
export interface FakeSession {
  readonly id: ReturnType<typeof SessionId>
  readonly events: unknown[]
  readonly seq: number
  snapshotEvents(): readonly unknown[]
  readonly header: { readonly cwd?: string, readonly parentSession?: ReturnType<typeof SessionId> }
  readonly surface: { readonly nodes: readonly unknown[] }
  requestHeader(): { config: { model: string, reasoningEffort?: string } } | undefined
  requestContext(): { contextWindow?: number } | undefined
}

/** The fake Agent's full surface: an Agent plus the session log and the followup/cancel spies. */
export type FakeAgent = Agent & {
  readonly session: Agent['session'] & FakeSession
  readonly followup: ReturnType<typeof vi.fn>
  readonly cancel: ReturnType<typeof vi.fn>
}

/**
 * A fake Agent carrying one scripted session: the event log the caller hands
 * it (push to `agent.session.events` to grow `seq` and `snapshotEvents`), a
 * `cwd`/`parentSession` header when asked, and `followup`/`cancel` spies.
 */
export function fakeAgent(id: string, {
  events = [],
  status = 'idle',
  parentId,
  cwd,
  model,
  provider,
  effort,
  headerModel,
  headerEffort,
  contextWindow,
}: {
  events?: unknown[]
  status?: 'idle' | 'running'
  parentId?: string
  cwd?: string
  model?: string
  provider?: string
  effort?: string
  headerModel?: string
  headerEffort?: string
  contextWindow?: number
} = {}): FakeAgent {
  const session = {
    id: SessionId(id),
    events,
    get seq() { return events.length },
    snapshotEvents: () => events,
    header: {
      ...(cwd === undefined ? {} : { cwd }),
      ...(parentId === undefined ? {} : { parentSession: SessionId(parentId) }),
    },
    surface: { nodes: [] },
    requestHeader: () => (headerModel === undefined ? undefined : {
      config: { model: headerModel, ...(headerEffort === undefined ? {} : { reasoningEffort: headerEffort }) },
    }),
    requestContext: () => (contextWindow === undefined ? undefined : { contextWindow }),
  }
  return {
    id: SessionId(id),
    session,
    status,
    options: {
      ...(model === undefined ? {} : { model }),
      ...(provider === undefined ? {} : { provider }),
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    },
    inbox: { nextTurn: [], nextStep: [] },
    followup: vi.fn(),
    cancel: vi.fn(),
  } as unknown as FakeAgent
}
