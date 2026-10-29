# `@ephemeral-ai/mayfly-host`

Owns the Mayfly-specific Host side of the split deployment: the session
projections the TUI reads, the generated `mayflyHost` Remote namespace, the
Host profile patch, and the startup URL printer. It runs inside the dsh Host
process; it must never import the terminal UI, pi-tui, or a renderer.

## Boundaries

- Projections live under `src/conversation/` and are registered by
  `src/index.ts` on the caller's Fiber: `mayflyConversation` (the append-origin
  transcript), `mayflyConversationFacts` (presentation facts: phase, output
  progress, in-flight calls, retries, approvals, compactions), and
  `mayflyDeliverables` (recorded file deliveries). The facts projection keeps
  `stateVersion` 13 and must stay a pure immutable fold: renderers never fold a
  second session log, and a semantics change increments the version with the
  fold change that caused it.
- `src/remote/` owns the `mayflyHost` Remote service and its DTOs in
  `src/types.ts`. Every method resolves the exact Agent for the requested
  Session before doing work, and every error carries a `mayflyHost/*` code with
  a client-safe message. Payloads crossing the wire contain no functions,
  AbortSignals, tool definitions, credentials, or raw connection errors.
- The MCP catalog reads the optional native resource runtime through the narrow
  structural face in `src/remote/mcp-catalog-face.ts`. A composition without
  that runtime keeps the tool-derived catalog, leaves `config` unresolved, and
  must not advertise `mcpTransportHealth`; an unconnected server is never
  reported as `no-tools`.
- `src/settings.ts` is the `mayfly` settings namespace schema; presentation
  application stays in the TUI. `cordis.patch.yml` composes the Host profile
  over `dsh-base`/`dsh-web-app` and changes only the browser/URL handoff.
- `src/startup.ts` prints the authenticated URL once. Tokens never enter logs,
  argv, or ordinary error text.

## Verification

A projection change requires its fold, state-version, wire-schema, and
summary-exclusion coverage. A Remote change requires an exact-Agent resolution
test plus its refusal path, and the generated client artifact must be rebuilt
(`pnpm run build` bundles the Host first). Catalog changes exercise the native
runtime present and absent, a configured server without tools, and the
redaction of every connection detail. The built artifacts are what the Remote
package consumes, so rebuild before judging any client behavior.
