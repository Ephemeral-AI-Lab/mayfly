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
  `stateVersion` 14 and must stay a pure immutable fold: renderers never fold a
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
- `subagentTree` preserves the native complete descendant preorder and diagnostics.
  Activity, token/tool/timing metrics and workflow labels come from exact resident
  native owners; transient stream facts use a passive opening follow snapshot,
  released after the read. It never activates a cold root or child. `subagentStop`
  re-reads the authorized root's descendants and drains only a continuable live
  leaf through its exact live direct parent. Wait for native completion; caller
  cancellation or unload retires results without cancelling sent teardown.
- The MCP catalog reads the optional native resource runtime through the narrow
  structural face in `src/remote/mcp-catalog-face.ts`. A composition without
  that runtime keeps the tool-derived catalog, leaves `config` unresolved, and
  must not advertise `mcpTransportHealth`; an unconnected server is never
  reported as `no-tools` or `synced`, but as `unknown`.
- Handshake versions come from the published package manifest. Raw settings
  writes are serialized by the service-owned `SettingsDocumentCoordinator`;
  stale content revisions remain conflicts, including during validation.
  Authorization streams retire through their own native request signal. A
  settled or refused stream must never cancel a different attempt that reused
  its credential key; key-wide cancellation belongs only to the explicit
  `cancelAuthorization` action.
- `btwFork` obtains the complete native observation cursor and passes that
  explicit inclusive cut to `sessionController.fork`, including an open first
  turn. Native fork composition owns synthetic closers, preset and workspace
  policies. A genuinely empty source uses native `create` with the effective
  Host directory and source preset, and returns no inherited history floor.
  Caller cancellation, source/controller replacement, exact Agent replacement
  and service unload retire results without cancelling Host-owned work.
- `src/settings.ts` is the `mayfly` settings namespace schema; presentation
  application stays in the TUI. `cordis.patch.yml` composes the Host profile
  over `dsh-base`/`dsh-web-app`. Keep its Web services, transport, and browser
  runner, but disable the Web-only `harness-dev-context` prompt plugin and
  `web-runtime.surfaceContext`: terminal users must not be described to the
  model as browser GUI users, or given a browser-only shell URL.
- `src/startup.ts` prints the authenticated URL once after Loader settlement.
  For a managed child it sends readiness only over parent IPC and consumes a native exit request on the same channel; unload retires both listeners. An unmanaged development Host retains its explicit readiness line. Tokens never enter argv or ordinary diagnostics.
- `presets/mayfly-cordis.patch.yml` registers the native creative preset after
  the Host patch. Its child rows match the pinned upstream Cordis preset except
  persona and the Host-owned skill root. Its published skills describe the
  actual split boundary: Host services and Agent-preset scopes cannot inject
  the independent frontend's four UI services. Current native Cordis model
  tools inspect only; programmatic Host/browser dynamic runners are not a
  TUI hot-load or frontend plugin installation API; TUI plugins join through
  a source composition (`run(argv, { plugins })` from `@ephemeral-ai/mayfly/bin`).
  Do not copy legacy in-process UI, dynamic model-tool, or directory-preset
  instructions into this payload. The TUI package does not publish it.

## Verification

A projection change requires its fold, state-version, wire-schema, and
summary-exclusion coverage. A Remote change requires an exact-Agent resolution
test plus its refusal path, and the generated client artifact must be rebuilt
(`pnpm run build` bundles the Host first). Catalog changes exercise the native
runtime present and absent, a configured server without tools, and the
redaction of every connection detail. The built artifacts are what the Remote
package consumes, so rebuild before judging any client behavior.
The Host build lowers decorators through `script/source-decorators.mjs` before
native Typert metadata generation. Its output must match the native generator;
only synthetic decorator calls without a source body stay unmapped. Keep
decorator expressions and business method bodies mapped, and run
`node --test script/tests/source-decorators.test.mjs` when changing this chain.
Runtime source maps are local build artifacts for coverage and debugging. Keep
them enabled in `tsdown.config.ts`, while the manifest's `files` whitelist
publishes runtime JavaScript and declarations only; declaration maps remain
allowed. The source-decorators regression builds and packs a fixture through
those actual configuration boundaries.
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

Recorded file reads in `src/remote/deliverables.ts` accept only an authoritative
delivery id, use that exact Agent's filesystem and effective Host directory, and
fence every await against Agent, Session, cwd and delivery replacement. Preview
bytes are capped at 256 KiB; opaque filesystem targets never cross Remote.
Latest workspace changes use the native announcing event and retained summary
without activating a cold Session.

## Passive statistics, traces, and recorded files

`statsSession` and `statsHistory` use native Session Query observations with
`projectionMode: 'none'`. They never activate an Agent. The Host owns the
complete event fold into readonly local-day usage digests; Remote receives
whole snapshots. Each history request owns its listing, leases, progress and
cancellation. The service-owned cache reuses only unchanged cold revisions;
live logs are folded again. Preserve the rc.2 newest-300 cap, four-reader pool,
precise provider/model identity and peak/off-peak buckets, and retire reads on
source replacement or Fiber unload.

`traceCatalog` and `traceDetail` passively read the complete native log and
native replacement/source relationships. A selected item's exact event
identities must still exist before detail is returned. The Host owns canonical
aggregation and detached immutable JSON; shared presentation owns no native
Session access.

`deliveredFile` accepts a recorded delivery id, resolves only that record
through the exact selected Agent's filesystem, and checks Agent, cwd and record
after every await. Text previews read at most 256 KiB; binary data gets the
reference message. `latestWorkspaceChanges` reads only resident native
comparisons and never activates a cold Session. Filesystem targets do not cross
the wire; native Session open operations own external application admission.
