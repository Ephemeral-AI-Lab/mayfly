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
  `mayflyDeliverables` (recorded file deliveries), and `mayflyJobs` (durable
  settled Job rows in registration order). Job history is a whole readonly
  snapshot; unfinished registrations stay absent and resident `job.list` rows
  take precedence in the frontend. The facts projection keeps
  `stateVersion` 13 and must stay a pure immutable fold: renderers never fold a
  second session log, and a semantics change increments the version with the
  fold change that caused it.
- `src/remote/` owns the `mayflyHost` Remote service and its client-safe DTOs in
  `src/types.ts`; Remote consumers import these instead of maintaining copies.
  Agent-scoped methods resolve the exact Agent and reject stale or cancelled
  asynchronous results. Passive history and workspace reads do not activate an
  Agent. A cold child's tool presentation uses generic durable content rather
  than resuming the child or failing other Sessions in the batch. Every error
  carries a public domain code with a client-safe message. Payloads contain no functions,
  AbortSignals, tool definitions, credentials, or raw connection errors.
- The MCP catalog reads the optional native resource runtime through the narrow
  structural face in `src/remote/mcp-catalog-face.ts`. A composition without
  that runtime keeps the tool-derived catalog, leaves `config` unresolved, and
  must not advertise `mcpTransportHealth`; an unconnected server is never
  reported as `no-tools` or `synced`, but as `unknown`.
- Handshake versions come from the published package manifest. Raw settings
  writes are serialized by the service-owned `SettingsDocumentCoordinator`;
  stale content revisions remain conflicts, including during validation.
- `src/settings.ts` is the `mayfly` settings namespace schema; presentation
  application stays in the TUI. `cordis.patch.yml` composes the Host profile
  over `dsh-base`/`dsh-web-app`. Keep its Web services, transport, and browser
  runner, but disable the Web-only `harness-dev-context` prompt plugin and
  `web-runtime.surfaceContext`: terminal users must not be described to the
  model as browser GUI users, or given a browser-only shell URL.
- `src/startup.ts` prints the authenticated URL once after Loader settlement.
  That explicit readiness line is the credential handoff; tokens never enter
  argv or ordinary diagnostics.
- `presets/mayfly-cordis.patch.yml` registers the native creative preset after
  the Host patch. Its child rows match the pinned upstream Cordis preset except
  persona and the Host-owned skill root. Its published skills describe the
  actual split boundary: Host services and Agent-preset scopes cannot inject
  the independent frontend's four UI services. Current native Cordis model
  tools inspect only; programmatic Host/browser dynamic runners are not a
  Remote TUI hot-load or frontend plugin installation API. Do not copy legacy
  in-process UI, dynamic model-tool, or directory-preset instructions into this
  payload. The shared renderer does not publish it.

## Verification

A projection change requires its fold, state-version, wire-schema, and
summary-exclusion coverage. A Remote change requires an exact-Agent resolution
test plus its refusal path, and the generated client artifact must be rebuilt
(`pnpm run build` bundles the Host first). Catalog changes exercise the native
runtime present and absent, a configured server without tools, and the
redaction of every connection detail. The built artifacts are what the Remote
package consumes, so rebuild before judging any client behavior.
Preset or skill changes require upstream-row comparison, published payload
closure, native registry registration/mount and skill-catalog evidence, unload
and second-Session isolation, plus dedicated-profile acceptance. Keep the two
package READMEs synchronized with the actual API limits.

## Local split profile

`script/install-dev.sh` builds the workspace and installs or refreshes
a dedicated `mayfly-*` profile (default `mayfly-dev`) in one shot: it checks
the selected `DSH_BIN` against the Host manifest, seeds the profile from the web template, denies the optional
native build scripts before the first install, links this package as a bundle,
and asserts the composed profile carries the Web runtime, the Mayfly rows,
the creative preset, and the disabled Web-only model context.
Pass the authenticated URL through `MAYFLY_DSH_STARTUP_URL` when launching the
Remote, never through argv. Use dedicated acceptance profiles and a pinned
local dsh binary; do not use the installer to change the global installation.
A spec that needs the hub or the plugin entry imports the
built `lib/` (see service.spec.ts); `src/remote/service.ts` decorators do not
survive vitest's oxc transform, and the `experimentalDecorators` tsconfig flag
does not change that.
