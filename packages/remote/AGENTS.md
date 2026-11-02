# `@ephemeral-ai/mayfly-remote`

This package is the independent HTTP/WebSocket Mayfly Frontend. It is not a
Cordis bundle installed into a dsh Host. Host processes run the native
`dsh-web-app`; this package runs a separate Node process that can attach and
detach multiple Hosts without owning their Agent or Session lifetimes.

## Boundaries

- Cross-process communication uses only the native dsh `/connect`, HTTP Remote,
  `/api/remote.mux` WebSocket, and existing file routes. Do not import Host
  Agent, Session, persistence, or Host Cordis services into this package.
- `src/client/` owns token exchange, cookies, Node transport, and the official
  React-free Client object layer, including the typed `ClientRemote` command
  catalog. A lexical module loader may execute official Client handoffs, but
  must not install a process-global `window` or DOM shim.
- `src/frontend/` owns multi-Host registration, generation-safe selection, and
  typed actions. Every Session identity includes `HostKey`; do not create a
  second Session, Connection, or projection state machine.
  Its native tool-presentation cache keys exact Host, Session, `callId`, durable
  update and presenter revision. Both mapper phases use `getForCall` to resolve
  the same call id, without passing it to the native registry scope parameter;
  repeated names and identical arguments never consume a positional cursor.
  Presenter batches retain native result metadata and retire on generation
  replacement, so builtin Read windows, Edit diffs and Write previews survive
  the process boundary without borrowing another call's result.
  Workflow frames use the official `RemoteSnapshotStream` baseline protocol.
  Replacement waits for the previous consumer to drain; retired callbacks and
  attach/subscribe calls after disposal cannot publish or retain listeners.
- `src/remote/` owns the standalone application, editor, local commands,
  banner, footer, plain panels, and terminal lifecycle. Session facts stay in
  the footer; command results and operation failures use the reference
  notification pane above the editor. Detach releases only Client resources and never cancels remote work.
  Attaching stays Session-independent: the first submitted prompt creates a
  Session, while `/new` and `/clear` release only the primary view. Concurrent
  initial prompts share creation; clearing or detaching fences its late result.
  Clearing the primary view also releases any pending primary acquisition so a
  stalled native open cannot retain the old view or block the next selection;
  independent view-role leases retain their own lifetimes.
  App owns startup plan intent through `startupPlan`; the plan feature only
  reads/writes that intent. Prompt preparation awaits native plan admission
  before admitting the first prompt. Selection listeners never apply it in the
  background. Native Session command outcomes render from their durable events.
  The editor uses shared readonly `Editor` and placeholder models. Theme swaps
  call its `retheme` handle around the same native editor, preserving its draft,
  caret, undo, history, paste, and completion state. Notification clocks and core
  focus/tail/prompt listeners belong to that mount and stop on unload. Editor
  composition retires each connection subscription independently; queued
  callbacks from a detached subscription or disposed composition cannot call
  the current editor controller, including after the same Client reattaches.
  Browser cleanup owns the mount before overlay publication. An already aborted
  caller opens no panel; synchronous close during registration or an immediate
  locale snapshot leaves no later observer and runs close feedback once.
- Editor focus and content navigation use the existing core keymap and screen
  APIs: autocomplete keeps focus keys, a failed target preserves editor fallback,
  and a retained draft/caret survives transcript and overlay visits. Core alone
  normalizes terminal wheel reports and owns actual focus/scroll state. The
  runtime forwards the shared transcript controller's focus-mode/row facts,
  new-message requests, Ctrl+O expansion, presentation settings and locale
  invalidation; those registrations and queued callbacks retire with its mount.
  Its dock is the shared `EditorExtensionRuntime`, which consumes direct editor
  registrations around the retained native editor. Feature bindings supply
  completion sources, attachment metadata and reversible prepared submissions;
  they never replace its provider or submit barrier. The original frame/footer,
  diagnostic/action rows and async extension work share this one shell. Input,
  catalog, projection, locale and settings updates refresh its memoized shape;
  only a palette change forces recompilation. Unbinding or route retirement
  fences late work.
  History/token facts and delayed prompt waits belong to the editor feature
  Fiber. File, clipboard and extension waits share one 150 ms owner; settlement,
  cancellation, selection replacement and unload release their exact scopes.
- `/plugin` consumes the shared rc.2 marketplace presentation and calls the
  official selected Host plugin manager for every install, remove, and enable.
  Its catalog, installed rows, notifications, and restart chip belong to one
  feature generation. A Host/selection/reconnection change retires that owner;
  late writes are never retried or presented under another Host.
  Reopening the browser replaces its local overlay. Caller cancellation and
  panel close retire reads and acknowledgements, and stop later install units;
  a sent native mutation keeps its Host-owned lifetime. A post-write list read
  must still belong to that owner before it can publish restart state.
- `/update` owns one explicit coordinated Host/frontend transaction. The shared
  reference confirmation and progress models remain renderer-neutral. Frontend
  npm staging verifies actual CLI/Remote/shared versions, imports the candidate,
  and starts its real CLI before mutation. Native Host bundle writes retain the
  captured Host even after UI retirement; failures compensate exact versions.
  An exclusive local marker retains logs and graphs across interruption;
  `/update recover` requires the original Host and explicit confirmation.
  Linked/read-only or foreign-prefix installs refuse mutation. The official
  API lacks an isolated Host boot check: confirmation and completion must say
  Host startup remains unverified until restart, never claim a full boot pass.
- `/jobs` reads durable settled history from the Host `mayflyJobs` native
  Session projection and overlays the native `job.list` whole resident roster.
  Remote never folds Job events or invents live jobs from unfinished history.
  Output readers retain exact Host/Session and byte cursors; human stops
  recheck native liveness and fence late results after connection replacement.
- `/rewind` reads the primary Session through passive native journal pages,
  builds the shared reference turn picker, and forks only after explicit
  acceptance. Busy checks and exact binding/Host/generation fences cover the
  history read, acceptance, and late fork result; the original Session stays.
- `/trace` consumes the Host's complete canonical trace timeline and exact raw
  event identities through passive Session queries. Its shared rc.2 model owns
  list/detail presentation and copy documents. Native Host queries own surface
  classification, stream grouping and event relationships; Remote never folds
  those facts. Panel close, caller cancellation and exact Host generation retire
  pending detail/copy results; newer commands and selections fence older reads.
- `/sessions` consumes the shared reference workspace/session browser and the
  native Client catalog, workspace membership, projection reads, search, and
  archive actions. Listing and detail reads never retain a Session. Child
  conversations use the operations composition's shared presented-view slot;
  readonly native access metadata and BTW history floors accompany bindings.
  Only displayed and F7 counterpart views retain native bindings. Listed child
  and BTW descriptors reacquire through this same owner when displayed again.
- `/provider` uses the reference configured-provider roster, editor tabs,
  connection/model setup, and model picker. Native namespace revisions and
  credential observations fence every write. A successful settings write followed
  by a failed credential write retains the confirmed revision so an explicit
  retry can finish without recreating the provider. Credentials are write-only;
  environment-owned keys remain intact when a profile is removed. Authorization
  answers reach the Host only after the shared UI acknowledges the answer action;
  dismissal, detach, and reconnect retire outstanding prompts and discovery.
  Account sign-in retirement freezes its local snapshot, releases an actually
  pending link timer, and makes queued native watch, callback and timer results
  inert. Closing the panel never cancels the Host's sign-in attempt.
- Model pickers preserve the native selection's explicit/default effort
  provenance. An adapter-default request header never creates an explicit pin;
  the shared reference picker renders that native distinction. Newer catalog
  refreshes retire both successful and failed results of older refreshes.
  A prompt already closed during mounting must acquire no later ACK observer.
  Retrying profile setup after successful sign-in reuses that exact authorization
  owner and never starts another native authorization attempt.
- User questions use the shared reference wizard and plan-review card. Live
  questions own their native waterfall and timed foreground claim; continued
  questions read the native whole projection and queued replies before an
  explicit native answer. Escape hides timed/continued drafts without closing
  or settling them. Exact Host, Session binding, and connection generation
  fence acknowledgement and late results; reconnect retires every old card
  until a new native projection update. Native foreground claims release once,
  including abort, detach, and replacement races. Waiting activity and plan
  request presentation derive directly from current owned waterfalls before
  opening their editor slot; completion and retirement withdraw those facts.
- Theme/language pickers, settings rail, and permission decision lane use the
  shared reference wire builders. The settings rail submits both native
  descriptor and field-projection revisions; a conflict never refreshes and
  retries a write. Native redacted secrets stay blank in forms; only explicit
  fresh secret edits become native path operations. Permission danger
  confirmations derive from the Host's resolved sandbox/approval spec, never
  from a preset name. Host preference synchronization applies only to the
  currently selected/active Host; background settings or reconnect events cannot
  replace its renderer settings. `/theme` changes live presentation without a
  settings write; unrelated Host writes retain that choice until its persisted
  default changes. Onboarding persists its theme default explicitly under its
  caller's cancellation and Host generation. `/theme custom` reads its palette
  through the Frontend-local public custom-theme provider; swaps and reloads
  retire that provider exactly as they retire a builtin palette.
- Raw settings editing uses `createRemoteSettingsEditor` with core-owned
  `screen.suspend`. Editing happens locally; writes use the original Host
  document revision and reject results after cancellation or selection change.
- Readable `/save` and `/export` consume the Host's whole `mayflyConversation`
  projection, preserving retractions and hidden-message visibility. Only `full`
  pages the native audit journal; attempt prefixes use native stream expansion.
  Exports write exclusively to bare filenames under local `mayfly-exports/`,
  fence the exact Host/Session/binding/connection generation and command owner,
  and remove a newly written file if its owner retires before write settlement.
- Durable conversation and facts come from whole Host projections.
  `src/conversation/` and `src/transcript/` map their latest snapshots plus a
  bounded current-attempt stream overlay; they never fold a second durable
  history or facts store. Only live command completion produces a notice.
  Reconnect replaces the baseline and historical commands never replay notices.
  Effective reasoning labels may read an admitted native request header or the
  exact Host/route's native model catalog when that header is outside the tail
  page. The rc.2 greeting keeps a provider-default route unlabelled during its
  first Session mount; reopening an already used Session restores the effective
  level. Explicit native effort picks still update immediately. This mount-local
  presentation provenance never changes native selections or freezes projections.
  A pending selection never inherits an older request's effort; metadata
  refreshes are generation-fenced and never turn a provider default into an
  explicit model-selection write. Side views borrow the primary owner's current
  exact Host catalog through a readonly resolver; they do not copy metadata into
  another cache, and owner detach immediately removes that fallback.
  Transcript context reads exact displayed Session facts for pressure,
  compaction marks and approval outcomes. Its private source observes that
  same Host's child roster and passively reads whole native direct-child
  projections without retaining or opening Sessions. Stable displayed ref,
  Client identity and connection generation own every read and bounded retry.
  Whole child facts take precedence over a delayed catalog running flag; a
  switch, detach or unload aborts reads before retiring the displayed sources.
  Row-copy feedback uses the shared translated success/error messages and keeps
  full failure details. Its captured Client, displayed binding, connection
  generation and mount must still own the result before publishing a notice.
- Slash commands submit ordered native encoded images and uploaded file
  receipts through `commands.execute`; markers stay in the reversible draft
  and are removed from the command line. File receipts retain their exact
  Host, Client, Session binding and generation; a changed scope refuses dispatch.
  Refusal restores the original draft and attachments without retrying a write.
  A selected Session's `/plan` uses native command admission, including ordered
  attachments and native refusals. `/plan <message>` can create its first Session;
  the explicit command supersedes unstarted startup mode intent before dispatch
  so preparation never sends an extra plan switch. Sessionless `/plan` and
  `/plan off` retain their next-Session behavior.
  Late upload results after cancellation are never retained. MCP transport
  health is unknown unless the Host advertises the optional sanitized catalog.
  Passive cold-child history keeps generic tool cards; Agent controls must
  refuse unavailable scope rather than activate or borrow a parent Agent.
- `/skills` consumes the exact Host `skillCatalog` native source/provider
  metadata and completeness. Only an uncomposed capability falls back to the
  official skill list with an explicit metadata notice; a failed read does not
  imply that capability is absent. Selection, binding, connection and caller
  cancellation fence discovery. Metadata is never inferred from paths.
  The public Client entry must retain the official Remote assembly's type-only
  export in emitted declarations so external consumers receive its namespace
  augmentations without relying on workspace imports.
- `src/remote-bin.ts` receives credentials only through the authenticated
  `MAYFLY_DSH_STARTUP_URL` environment variable; a non-secret `--host` URL is
  accepted, and a token in argv or a log is refused.
  Tokens never enter argv, logs, screenshots, or ordinary error text.

The candidate `@ephemeral-ai/mayfly` and `@ephemeral-ai/mayfly-ui` packages are
visual dependencies built from the same release set. The published rc.2
artifact is an isolated immutable verification reference. Do not link this
package back into the legacy in-process TUI composition or restore the old
`mayflyCurrentAgent` path.

## Verification

Client transport changes require authentication, reconnect, stale-generation,
and detach tests plus real-Host list/create/open evidence. Registry and command
changes require same-SessionId multi-Host isolation and late-result tests.
Transcript changes require replace/prepend/append/settlement fixtures, live
projection facts, and proof that historical commands do not replay notices.
Command routing changes require Host catalog, alias, failure, and exact
Host/Session coverage. Banner, footer, editor, and panel changes require narrow
and wide rendering plus focus restoration tests. Runtime changes require the
built PTY smoke, proving the banner, footer, command surfaces, Session creation,
and clean teardown.

Develop behavior and regression tests together under the root change-aware
workflow. Before acceptance run the full architecture gate, `pnpm run
check:lib`, and `pnpm run check:pack`, then perform a real dsh Host
attach/detach and PTY acceptance. `pnpm run scenario remoteLifecycle` is the
manual review; supply its Host through `MAYFLY_DSH_STARTUP_URL`, never argv. All
executable source in this package is subject to the repository's per-file 100%
coverage gate.

`/files` consumes the shared rc.2 responsive Files browser and authoritative Host
deliveries plus the latest retained native workspace comparison. Metadata and
256 KiB previews use recorded delivery ids through `mayflyHost`; Open uses the
native Session controller and Copy uses the Frontend clipboard. Exact Client,
Session binding, connection generation, focus and caller cancellation fence
reads and acknowledgements. Closing releases observers and never stops Host work.

`/stats` consumes `./stats-presentation` for all four reference tabs. Native
projection faces provide current Session facts and Host statistics methods
provide creation metadata and complete usage digests; the frontend never folds
the journal for statistics. The Session tab reads effective native reasoning
even on its first mount, borrowing the conversation owner's current exact Host
catalog when the admitted header is outside the tail. Pending model or effort
choices never inherit a previous request's level. Date ranges, workspace scope, copy feedback,
coalesced progress, price discovery and five-minute account caching belong to
one panel lifetime. Host/selection/connection replacement retires its native
reads, streams, timers and cached account identity. Account facts use only
native redacted provider settings, credential descriptions and platform
account methods; API-key balance credentials stay entirely on Host.
