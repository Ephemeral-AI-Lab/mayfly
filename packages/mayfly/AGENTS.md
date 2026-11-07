# `@ephemeral-ai/mayfly`

The independent Mayfly TUI: a Node process with its own Cordis tree that
attaches to dsh Hosts over HTTP/WebSocket and detaches without owning their
Agent or Session lifetimes. It is not a Cordis bundle installed into a Host;
Host processes run the native `dsh-web-app` and `packages/host`. The public
surface is the root (the application and `runRemoteFrontend`), `./client` (the
official Client layer), and `./bin` (the `mayfly` entry, whose `run(argv,
{ plugins })` is also the source-composition seam). There is no Host plugin
entry, dsh bundle declaration, composition patch, or preset payload.

| Area | Owns |
| --- | --- |
| `src/core/` | pi-tui, raw terminal state, ANSI, focus, layout, width, keymap, screen, node slots |
| `src/frontend/` | `mayflyUiInteraction`, images, locale, editor-extension runtime |
| `src/components/` | pure Mayfly components over facts |
| `src/interaction/`, `src/transcript/`, `src/conversation/` | readonly models, the transcript controller, the current-attempt overlay |
| `src/client/` | token exchange, cookies, Node transport, the official Client object layer |
| `src/hosts/` | multi-Host registration, generation-safe selection, typed actions, tool presentations |
| `src/app/` | the application, editor, features, operations, panels, startup, and runtime |
| `src/bin.ts` | credentials from the environment, argv, and redacted diagnostics |

Host owns the DTOs, the generated `mayflyHost` client, and the conversation
fold; the TUI imports them only from `@ephemeral-ai/mayfly-host`'s `./remote`,
`./types`, and `./conversation` subpaths. `check:pack` refuses Host service
runtime imports and composition payload.

## Process boundaries and features

- Cross-process communication uses only the native dsh `/connect`, HTTP Remote,
  `/api/remote.mux` WebSocket, and existing file routes. Do not import Host
  Agent, Session, persistence, or Host Cordis services into this package.
- `src/client/` owns token exchange, cookies, Node transport, and the official
  React-free Client object layer, including the typed `ClientRemote` command
  catalog. A lexical module loader may execute official Client handoffs, but
  must not install a process-global `window` or DOM shim.
- `src/hosts/` owns multi-Host registration, generation-safe selection, and
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
- `src/app/` owns the standalone application, editor, local commands,
  banner, footer, plain panels, and terminal lifecycle. Session facts stay in
  the footer; command results and operation failures use the reference
  notification pane above the editor. Detach releases only Client resources and never cancels remote work.
  Attaching stays Session-independent: the first submitted prompt creates a
  Session, while `/new` and `/clear` release only the primary view. Concurrent
  initial prompts share creation; clearing or detaching fences its late result.
  Startup joins the Session catalog refresh after the official Connection
  generation is established; a superseded bootstrap pull cannot admit resume.
  Pending connection waits retire on caller cancellation, detach, a newer
  attachment or app disposal and release their native subscriptions.
  Clearing the primary view also releases any pending primary acquisition so a
  stalled native open cannot retain the old view or block the next selection;
  independent view-role leases retain their own lifetimes.
  Bare `/rename` uses the shared reference title editor, retains its draft on
  refocus, and confirms dirty dismissal. Its exact Client, displayed binding,
  selection and connection generation fence admission and late feedback.
  App disposal retires pending selection and initial creation before asynchronous
  runtime teardown, without cancelling work already admitted by the Host.
  `/new [preset]` validates the exact Host's usable roster before releasing the
  current view and retains that preset until native creation consumes it.
  `/fork` and `/init` refuse a running Agent. Caller cancellation and exact
  selection owners fence native reference admission and late feedback; a
  retired fork cannot replace a newer selection. Session browser callers own
  its reads, actions and panel lifetime through the same cancellation signal.
  `/fork` and `/rewind` ignore command arguments as the reference handlers do;
  rewind boundaries come only from the native-history picker.
  App owns startup plan intent through `startupPlan`; the plan feature only
  reads/writes that intent. Prompt preparation awaits native plan admission
  before admitting the first prompt. Selection listeners never apply it in the
  background. Admitted commands consume the generated `commands.execute`
  outcome exactly once; historical durable events never replay their notices.
  Generic command success text uses the reference info severity and errors use
  error severity. Explicit picker actions and mode cycles retain their own
  success reporting.
  The editor uses shared readonly `Editor` and placeholder models. Theme swaps
  call its `retheme` handle around the same native editor, preserving its draft,
  caret, undo, history, paste, and completion state. Notification clocks and core
  focus/tail/prompt listeners belong to that mount and stop on unload. Editor
  composition retires each connection subscription independently; queued
  callbacks from a detached subscription or disposed composition cannot call
  the current editor controller, including after the same Client reattaches.
  F7 warnings have their own Fiber-owned notification producer: input and
  same-Host Session changes preserve them; Host changes and unload retire them.
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
  A real palette-service replacement retires pending extension callbacks and
  this input owner's feedback; the initial same-service bind retires neither.
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
  npm staging verifies actual CLI/TUI/shared versions, imports the candidate,
  and starts its real CLI before mutation. Native Host bundle writes retain the
  captured Host even after UI retirement; failures compensate exact versions.
  The frontend npm catalog owns canonical release-channel resolution; the
  capped newer-only Host version list never proves that an absent tag is current.
  Both installations use that same exact release, with native Host compatibility
  and installation checks. Registry progress and bounded retries retire with
  their caller and connection; confirmation shows known native publish age and
  states that the Host enforces its undisclosed release-age setting at install.
  A durable local recovery marker retains logs and graphs across interruption;
  `/update recover` requires the original Host and explicit confirmation.
  Linked/read-only or foreign-prefix installs refuse mutation. The official
  API lacks an isolated Host boot check: confirmation and completion must say
  Host startup remains unverified until restart, never claim a full boot pass.
  Native Host restoration first verifies the exact installed release and
  enablement, including an updateBundle automatic restoration. Startup-only
  profiles permit direct replacement; an HMR already-installed refusal requires
  an exact-version recheck, native removal, and native installation. Recovery
  accepts a missing bundle after an interrupted removal, preserves failed-stage
  diagnostics, and never replaces a release outside the captured transaction.
  A native cross-process file lock owns each local callback through staging,
  mutation and compensation. Recovery rechecks its original marker under that lock before
  transferring ownership. Each global npm Node process records its own PID
  before importing npm; a surviving writer blocks recovery after its parent
  exits. An unconfirmed startup record requires explicit manual repair, never
  an inferred safe takeover. UI cancellation only cancels lock acquisition and
  pre-mutation reads; admitted writes finish under their captured owner.
  Same-process recovery may use its already verified snapshot when npm left the
  launcher entry or manifest absent, after rechecking the exact marker and
  original canonical global prefix. A fresh process requires installation proof.
- `/goal` belongs entirely to the official native command catalog, including
  its parser, bare-command output, ordered attachments and refusal messages.
  The Goal status consumes the whole native goal projection and merges only
  matching id/revision activation reads; an unavailable activation leaves the
  durable goal disarmed. Its revision-bound resume/pause/clear writes use native
  goals; edit puts `/goal edit <objective>` in the retained local prompt. Every
  read, action and late result checks exact Client, binding, connection and
  caller lifetime. Goal/Todo use the shared reference status models; Todo reads
  native whole `todos`, `mayflyConversationFacts`, and the resolved frontend
  `viewHistory` source. Repeated completion reads never extend the linger.
- `/jobs` reads durable settled history from the Host `mayflyJobs` native
  Session projection and overlays the native `job.list` whole resident roster.
  The TUI never folds Job events or invents live jobs from unfinished history.
  Output readers retain exact Host/Session and byte cursors; human stops
  recheck native liveness and fence late results after connection replacement.
- `/agents` browses the primary Session even while a side conversation is shown.
  It consumes the Host's whole native descendant tree and live metrics through
  `subagentTree`, and the shared reference tree owns filtering, disclosure and
  selected-row stop confirmation. `subagentStop` rechecks native descendants and
  the exact direct parent before draining; idle resident Agents may be stopped.
  Opening a selected child retires the tree and owns its acquisition separately
  under the original command caller. Browser close, cancellation, primary
  replacement, connection replacement and unload release reads and timers.
  Catalog, jobs and schedule commands retain their invocation's abort signal
  through panels, readers and pending actions. Navigation children retain the
  original invocation when their source panel closes. MCP resource reads and
  job output follows retire with their exact panel or caller; independent job
  observation and schedule reminders keep their feature-owned lifetimes.
  A schedule panel owns its refresh timer before renderer registration, so a
  synchronous close cannot leave a timer running.
  MCP/tool browsers and reminders consume the native rc.2 pure builders from
  `command-panels`. MCP resources and `uriTemplate` rows first open an editable
  URI form, then a separate body page; Escape walks those layers. Resource,
  template and paging keys retain their reference controls. Reopening a live
  panel focuses its original invocation. `/mcp`, `/tools` and `/schedule` ignore
  command arguments as the reference handlers do; reminders read only the
  selected Session and never depend on a Host-wide catalog succeeding.
  `/jobs` uses the distinct reference browser list, detail and output pages in
  one overlay; its status view retains its own roster and independent output
  overlay. Output observations retain the native ring's complete returned text.
  Both output entry paths await the native anchor's complete initial retained
  window before showing output; an initial read failure returns an action
  failure and keeps the current page. Retirement settles this pending admission,
  while later catch-up failures preserve the held document.
  Only native loss replaces an older retained window; the frontend never adds
  a length cutoff or invents a retention-loss marker.
- `/rewind` reads the primary Session through passive native journal pages,
  builds the shared reference turn picker, and forks only after explicit
  acceptance. Busy checks and exact binding/Host/generation fences cover the
  history read, acceptance, and late fork result; the original Session stays.
- `/btw` inherits the source's complete current tail through the authorized
  `mayflyHost.btwFork` native command. Its returned history floor is authoritative;
  bounded Client event pages never choose the cut. An empty source has no floor.
  Before a recorded model route exists, read the native Host default without
  recording a parent selection or turning its default effort into an explicit pin.
  A focused Host fork refreshes the official Client catalog before retaining or
  writing its child. A joined list pull may predate that fork, so one fresh read
  may follow; an undiscovered child admits no model write or prompt.
  Exact Client, parent binding, connection generation and caller lifetime fence
  every continuation before model restoration, inherited-Inbox cleanup and the
  child prompt. A pre-aborted invocation preserves an existing or pending view.
  Closing releases the frontend view and never cancels Host-owned Agent work.
- `/trace` consumes the Host's complete canonical trace timeline and exact raw
  event identities through passive Session queries. Its shared rc.2 model owns
  list/detail presentation and copy documents. Native Host queries own surface
  classification, stream grouping and event relationships; the TUI never folds
  those facts. Panel close, caller cancellation and exact Host generation retire
  pending detail/copy results; newer commands and selections fence older reads.
- `/sessions` consumes the shared reference workspace/session browser and the
  native Client catalog, workspace membership, projection reads, search, and
  archive actions. Listing and detail reads never retain a Session. Child
  conversations use the operations composition's shared presented-view slot;
  readonly native access metadata and BTW history floors accompany bindings.
  Only displayed and F7 counterpart views retain native bindings. Listed child
  and BTW descriptors reacquire through this same owner when displayed again.
  Retained subagent bindings derive live access from passive native
  `session.list` whole summaries: the official Client display catalog omits
  `agentAvailable`. Catalog notifications coalesce reads for at most those two
  bindings; exact Client, binding, connection generation and request ownership
  fence every result. A refused read preserves known access. Natural Agent
  disposal keeps the descriptor and makes a continuable child resumable;
  explicit `/agents stop` closes that child as in the reference.
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
  Direct `/model` input resolves exact case-sensitive model ids, preferring the
  current provider when ids repeat. Only the exact `/effort default` argument
  restores provider-default provenance; effort ids and labels otherwise use
  the native case-insensitive matching. Direct model/effort success uses info
  feedback; picker and Alt+M success uses success feedback. Failed picker writes
  remain inline action failures, while direct failures use error and failed
  Alt+M commits use warning.
  A prompt already closed during mounting must acquire no later ACK observer.
  Retrying profile setup after successful sign-in reuses that exact authorization
  owner and never starts another native authorization attempt.
  Configuration commands retain their invocation's abort signal through
  discovery, mounted panels, account flows and onboarding child operations. A
  cancelled catalog or default-route read cannot open a late picker, start a
  write or publish feedback. Refocusing an existing picker retains its original
  owner; a cancelled invocation cannot focus it. Provider navigation and model
  handoffs inherit the original invocation, so disposing a completed resolver or
  setup panel cannot retire the next picker. Wizard children instead retire with
  their still-active wizard.
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
  `/settings` and `/permissions` ignore command arguments as the native handlers
  do, while `/theme` retains the reference case-sensitive theme parser.
  Permission actions await the generated full native command result before
  reporting success; a matched command ACK alone proves no preset write.
  Native refusals keep the picker open with the reference prefixed dispatch
  error and error notice. Action cancellation fences both replies and notices.
- Raw settings editing uses `createRemoteSettingsEditor` with core-owned
  `screen.suspend`. Editing happens locally; writes use the original Host
  document revision and reject results after cancellation or selection change.
- Readable `/save` and `/export` consume the Host's whole `mayflyConversation`
  projection, preserving retractions and hidden-message visibility. Only `full`
  pages the native audit journal; attempt prefixes use native stream expansion.
  `/copy` reads the newest non-empty visible assistant item from that same whole
  projection, never a bounded raw journal window, and fences clipboard results
  against caller, exact binding, Client, connection generation, and unload.
  Exports resolve relative paths against the TUI working directory, accept
  absolute paths, create parent directories, and overwrite existing files. They
  fence the caller, exact Host/Session/binding/connection generation and command
  owner. Writes queue by normalized target, stage in a temporary sibling file,
  and recheck ownership before atomic commit. Failure or retirement cleans up
  only uncommitted temporary files; a committed output is never rolled back.
- Durable conversation and facts come from whole Host projections.
  `src/conversation/` and `src/transcript/` map their latest snapshots plus a
  bounded current-attempt stream overlay; they never fold a second durable
  history or facts store. Command submissions report their exact native return
  values through their input owner. Plan-mode shortcuts report their own admitted
  result. Conversation events never produce command notices, including a second
  notice for a command already acknowledged by its submit owner. Reconnect
  replaces the baseline.
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
  and are removed from the command line. File bytes use the official Blob binary
  HTTP upload carrier. File receipts retain their exact
  Host, Client, Session binding and generation; a changed scope refuses dispatch.
  Pre-admission refusal restores the original draft and attachments before
  reporting feedback, so the restored editor cannot clear that notice. A local
  handler that executes and throws, or a returned native command error, consumes
  its submitted draft just like a successful admitted command. Stale failures
  never publish feedback and transport refusals never retry a write.
  A selected Session's `/plan` uses native command admission, including ordered
  attachments and native refusals. The explicit command supersedes unstarted
  startup mode intent before dispatch
  so preparation never sends an extra plan switch. Sessionless `/plan` and
  `/plan off` retain their next-Session behavior; any other sessionless argument
  reports the exact native refusal without creating a Session. Mode cycles read
  the generated full native command outcome rather than a matched-only ACK.
  Late upload results after cancellation are never retained. MCP transport
  health is unknown unless the Host advertises the optional sanitized catalog.
  Passive cold-child history keeps generic tool cards; Agent controls must
  refuse unavailable scope rather than activate or borrow a parent Agent.
  Displayed feature selections carry native access and conversation kind.
  Cold side views retain their declared title and history; automatic Workflow,
  Git, context and effective-effort lanes require interactive access. Only the
  primary view announces resumed history. Returning to a used primary view may
  restore its recorded effective effort without changing native selection.
- `/skills` consumes the exact Host `skillCatalog` native source/provider
  metadata and completeness. Only an uncomposed capability falls back to the
  official skill list with an explicit metadata notice; a failed read does not
  imply that capability is absent. Selection, binding, connection and caller
  cancellation fence discovery. Metadata is never inferred from paths.
  The public Client entry must retain the official Remote assembly's type-only
  export in emitted declarations so external consumers receive its namespace
  augmentations without relying on workspace imports.
- `src/bin.ts` receives remote credentials through the authenticated
  `MAYFLY_DSH_STARTUP_URL` environment variable; a non-secret `--host` URL is
  accepted, and a token in argv or a log is refused.
  The unified CLI may also pass a startup URL from its current-user private discovery record directly in memory; that input is redacted in diagnostics. Tokens never enter argv, logs, screenshots, or ordinary error text.

- Source compositions pass Cordis entries to `run(argv, { plugins })` or
  `runRemoteFrontend({ plugins })`. They load in order into the TUI's tree
  after core and the built-in features, before the first attach, each in its
  own Fiber, and unload with the TUI. The tree provides the four UI services
  and no native dsh services.

`/files` consumes the shared rc.2 responsive Files browser and authoritative Host
deliveries plus the latest retained native workspace comparison. Metadata and
256 KiB previews use recorded delivery ids through `mayflyHost`; Open uses the
native Session controller and Copy uses the Frontend clipboard. Exact Client,
Session binding, connection generation, focus and caller cancellation fence
reads and acknowledgements. Closing releases observers and never stops Host work.

`/stats` consumes the shared statistics presentation for all four reference tabs. Native
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

## State and lifetime ownership

- A resource acquired across an `await` registers its owner first and checks
  it again on resumption. Unload and stale-generation fences cover starts,
  late success, late failure, publishers, and acknowledgement continuations.
- Shared models consume readonly facts and structured action replies. Native
  Agent selection, Session creation, provider/settings/plugin writes, jobs,
  side-session bindings, and command routing belong to `src/app/` and the Host.
- `frontend/index.ts` owns `mayflyUiInteraction`, images, locale, and consumer
  Fibers independently of core. Form/Choice/Tabs/Document/Prompt drafts,
  caret/recall/completion state, locks, confirmations, semantic focus, and
  feedback survive renderer gaps. Teardown releases terminal editors and
  handles, not valid frontend drafts. Registry observers dispose only their
  own registration instances.
  `createInteractionNotificationOwner` is exported from `frontend` and requires
  the consumer's explicit `() => MayflyUiScope` callback. The consumer owns
  selection and scope lifetime; the shared helper never looks up native Agents,
  Sessions, or Host selection and supplies no default scope.
- Locale namespaces are refcounted shared catalogs. Equivalent registrations
  share a catalog; conflicting content is an error. Use
  `memoizedLocaleTranslator` (`frontend/locale.ts`), with one observer Fiber
  per context/namespace and one resolution per locale revision. Shared words
  belong to `common`. Used keys, liveness, placeholders, and zh terminology
  stay covered by `tests/locale-catalog.spec.ts`, which reads the `*-locale.ts`
  catalogs and every inline `const zh`/`*_ZH` catalog beside its translator.
- Conversation presentation never folds durable Host history. The bounded
  current-attempt overlay accepts only the current assistant attempt, through
  Host's `./conversation` stream helpers. Official whole Host snapshots supply durable
  conversation and facts; reconnect replaces baselines. Explicit settled-step
  facts close live content, never a reasoning animation flag. Durable
  `updatedSeq` and transient `renderRevision` are separate clocks.
- Tool presenter sources optionally implement `getForCall(name, callId)` for
  both call and result resolution. A missing exact-call view never falls back
  to `get(name)`. Native registries receive only the name; their second argument
  remains the native private scope. Asynchronous Host sources use the exact
  call identity to preserve repeated calls independently
  of lookup count or argument equality. Keep native Read windows, Edit diffs,
  Write bodies, and absolute result paths intact across this seam.
- Transcript controllers keep one view per displayed/retained conversation,
  stash hidden values without conversion, and lazily convert floor-eligible
  entries on display. BTW history floors hide seeds only in presentation.
  Entry identity cannot be assumed across native decoding: Host entries are
  interned by id and `updatedSeq` before conversion. Live publishes
  coalesce bursts under their fixed budget and publish immediately when a
  step settles or turn closes. Timers animate labels; domain progress comes
  from native timestamps and projections.
- The activity row owns live phase, elapsed time, action, and throughput.
  Its labels come from `transcript/tool-kinds.ts`. It hears of calls the attempt
  still writes through `mayfly/preparing-calls`, which fires only when that set
  changes, because a model is published per streamed chunk. The attempt's
  overlay carries those calls under their durable id, so the durable row wins.
- A tool's `placement` and `owner` in `tool-kinds.ts` decide where its calls are
  drawn: the stream records a call, the views own what outlives one. A failed
  call or one waiting on the user is drawn whatever its placement. A field the
  stream draws also belongs in `transcript/row-text.ts`, the text behind copy,
  the editor, and search.
  Transcript rows show content and settled summaries. A surface without an
  activity row may opt into its running-turn header. Decision components use
  readonly queue facts supplied by the caller, never inspect an overlay.

## Node slots

`screen.mountNodeSlot(id, { region: 'content' | 'dock' | 'footer' })` is a
core-private lease (`core/node-slot.ts`) whose wire node compiles through the
surface path, with the same compiler entry, runtime, and caches as a pane, into
one of the screen's fixed hosts. Its interaction state is a `slot` model in
`mayflyUiInteraction`, so a screen teardown revokes the lease and keeps the
model for the next lease of the same id; only `dispose()` drops it. Cordis
disposes the screen's dependents before the screen's own effects, so a lease
disposed after `mayflyScreen` stopped being provided counts as that teardown. Mayfly
features reach the footer, the editor, and the conversation through slots, never
through a new root component. Plugins still use only the four public services.

The `content` region is the content of the outer scroll: while the slot holds no
focus its lists and rows are not bounded by the viewport (`MayflyUiSurfaceRuntime.flowing`),
and the scroll view windows what they paint, so wheel, page keys, and follow-tail
work as for any content. A focused slot keeps the list's cursor window. An owner
can follow one list item with `MayflyNodeSlot.track(controlId, itemId)`: each paint
of a flowing list notes the item's line, and `trackedRow()` returns it among the
scroll content's rows (the new-messages rule uses it to find itself against the
view). The content scroll (`TailScrollView`) paints the rows of its window before it
settles on a height, lays out again when painted rows moved the length it measured, and
a scroll it cannot take asks for a frame, so a lazy document's estimate never leaves the
last rows out of reach. That holds only while every layer between the document and the
scroll (the flowing list's painter, a column stack, the surface frame) reports the live
length and passes `prepare` on: none may slice at a length it read once or keep a height
it measured before the rows painted. Follow-tail is `Ctrl+↓`'s second press: the first goes to that rule. The
conversation stream (`TranscriptView`, published by `transcript/transcript-model.ts`
from `transcript/stream-facts.ts`) is the first consumer.

## Components area

`src/components/` holds the Mayfly components as pure functions of facts that
return `ui.*` nodes (`TranscriptView`, `ToolLine`, `ActivityRow`,
`NotificationLine`, `CompactionRow`, and `DecisionCard`). Feature owners supply
readonly decision queues; the stream maps the first request to its call block
and never reads an overlay.

It has no Cordis entry and no public subpath, and a component is imported from
its own module. A file there imports
only `@ephemeral-ai/mayfly-ui` and its siblings and contains no `node:` module,
Cordis, `../core`, width helper, escape sequence, timer, or key binding.
The feature plugins that publish a component's nodes own its facts, its
Fibers, and its writes; `core/` owns widths, ANSI, clocks, and keys.
`tests/components/layering.spec.ts` is the guard, and it must keep failing on
each of those constructs. A new component module extends the guard's reach
without edits, and its row renderers join the owning `width-scan.spec.ts`.

## Views lane

A `mayflyPanes` pane with `placement: 'views'` is a view of the status row, kept
by `core/views-lane.ts` (`SurfaceManager.views`), not by a pane lane: it has no
rows of its own, its summary joins the status row through the footer, and an entered
panel opens under the status row (which stays, with a `━` line under the active item as its second line). A view's slot lives with its `PaneComponent`. Entry keys
are the named actions `ui.focus-next`, `ui.left`/`ui.right`, and `ui.cancel`;
`F6` walks the views before the interactive panes. Mayfly's own views register
through the public pane service, never through core.

## Shared presentation models

The readonly models under `src/interaction/` (`*-model.ts`) and the status and
banner builders under `src/transcript/` (`*-model.ts`) are pure data-to-node
helpers. Feature owners in `src/app/`
supply exact-snapshot facts and perform every native read and write; the models
never retain a Session, open history, list or stop an Agent, query or fold
native Session state, or perform Workspace writes.

- The session browser keeps the workspace rail, catalog/search form, and
  detail nodes; the app maps native Client snapshots into its display facts.
- Command panels keep the reference changelog, help, version, context, rewind,
  rename, and update presentation, the subagent tree with its slash filter and
  selected-row stop confirmation, Goal/Todo summaries and panels (resume,
  pause, edit, confirmed clear, prompt-based editing, completed-row filtering
  and completion linger), and the MCP/tool catalog, Job browser and reminder
  builders (resource URI editing, template rows, body/back layers, the
  distinct Job browser list, and the empty-schema message).
- The trace model keeps the rc.2 timeline, responsive detail nodes, and
  clipboard formatters; Host owns complete Session queries, surface
  classification, stream grouping, and event relationships.
- The files browser exposes only metadata and preview/open availability;
  filesystem targets stay in its controller.
- The statistics presentation keeps the four tabs, pure facts, summaries,
  range aggregation, and readonly digest/account types. Owners supply the Host
  home directory explicitly; the TUI machine's home never determines display.
  The pure account model preserves decimal amounts for exact wallet addition.
- The marketplace model and discovery catalog never import Host services.

## Keymap

`mayflyKeymap` owns every dispatched key as a named action (`ui.save`,
`ui.search`, `ui.copy`, `ui.delete`, `ui.refresh`, `ui.external`, `ui.cancel`,
`ui.focus-next`, and the rest of `core/key-actions.ts`) with a scope: `global`,
`editor`, `surface`, or `stream`. A `global` action claims its key in every
scope; within overlapping scopes a key belongs to one action, and a conflict is
refused with the owner's name (`KEY_CONFLICT`). `bind`/`reset`/`resetAll` change
a key for the session (a rebound-away key is dead, not an alias; `Esc` and `Enter`
stay fixed), `list` offers registered and seen component actions for rebinding,
and `preferPlain` puts the plain second default first where Alt is not delivered (or the `preferPlainKeys` setting says so).
Component actions (`<owner>.<action>`) appear in nodes and in the hint row under
the same rule. Printable accelerators never pre-empt a control that takes text,
and `core/ui-key-grammar.ts` derives the hint row from the same state. A new
default key passes `tests/core/key-audit.spec.ts`.

## Interaction contracts

Use shared Form/Choice/Tree/Tab/ScrollView state for drafts, validation, locks,
confirmation, navigation, and acknowledgement. Observations report facts;
handled actions return structured settlements. Publish admitted acknowledgements
before settling native requests. Fence late validation, replies, and source data;
never overwrite newer snapshots or independent form errors.

Keep hidden branches and large lists lazy. Explicit submissions may admit their
own hidden forms; ordinary rendering/movement reads a bounded list window.
Filter/tree indexes change with query, disclosure, or definition, not each frame.
Passive transcript scrolls linearize into the outer viewport; interactive
surfaces retain semantic scroll state. Do not add fixed-width feature renderers.

Use shared Yes/No confirmation with No initially focused. Ordinary dirty forms
confirm dismissal; native decisions may explicitly discard. Wizard navigation
validates read boundaries without domain writes. Decision withdrawal, decline,
and whole-attempt cancellation are distinct; abort/Agent replacement/unload
must retire visible and queued requests before they grant or steer. OAuth
instructions belong only to the live authorization surface.

`core/ui-key-grammar.ts` is the single source for key dispatch and contextual
hints; [docs/interaction-model.md](../../docs/interaction-model.md) is the
spec. Changes to shared keys update `SHARED_KEY_REFERENCE` and both Website key
references together. Escape leaves one layer per press (picker, editing,
search, back, close); Tab commits text and open pickers; arrows up/down never
change a select. Editor shells leave every key except modifier accelerators to
the editor. Choice reducers never focus disabled rows. Consumers express
per-row availability with `unavailableActions` and questions with `confirm`,
not custom confirm pages or post-confirmation rejections.

Core reuses work by identity, never by value. A surface keeps one admission memo
(`ui-validator.ts`), one compile memo and one list-row memo (on its
`MayflyUiSurfaceRuntime`), and the renderer keeps one `UiAnimationClock`; none is
a module singleton. Only a frozen `isWireSnapshot` value is a cache key, a memo
hit must replay every quota and duplicate check, and a subtree that carries a
control, tab, page, action key, filter, editor slot, or responsive branch is
admitted whole each time. Reused leaves are static painters that read only their
node, width, colors, and components; a new palette recompiles them. The work
budgets in `tests/perf/budgets.json` only ratchet down.

One deeply frozen wire subtree may occupy mutually exclusive responsive children
of the same stack while keeping one control and action identity. Each child is
fully admitted and charged its quotas independently; its reservations may reuse
an identical sibling's reservations once only when page, depth, scroll context,
and local viewport exclusivity agree. Mutable declarations, different stacks,
overlapping conditions, and subtrees with further responsive children receive no
reservation sharing. Failed deferred admission restores all budget and key state.

An unchanged subtree costs nothing on republish, so a painter that paints rows is
written once in its cacheable form and brings its budget row. `list` reads
`selectedIds` through `listSelectedIds` (the field is optional on the wire).

An unchanged surface also costs nothing per frame. pi-tui lays a pane out on every
frame of the terminal and renders a component once per stack that measures it, so
every component `compileNode` returns answers a repeat render from memory
(`retain` in `core/ui-compiler.ts`), and so do the parts pi-tui lays out one by one
(a form's fields, a loader's row, a surface's head and tail). The rows hold for one
epoch of the surface (`MayflyUiSurfaceRuntime.epoch`). The rules a painter lives by:

- Whatever can change a row moves the epoch. A handled key, focus, `invalidate`,
  and a new compile move it where they happen; a frame moves it for a new host
  viewport, model revision, keymap revision, or completion state. State a painter
  reads from anywhere else needs its own `touch()`, or the component is volatile.
- A component that paints a live engine (the host editor, a prompt) is volatile:
  it always paints, and no render that contains it is remembered. Keep volatile
  components out of large trees.
- A moving cell reads the clock through `loaderFrame()` or `progressValue()`. Its
  render and the renders around it hold for one animation frame, a tick asks the
  host for a frame without invalidating (`requestFrame`), and the clock is armed
  only while the cell can be on screen (`core/ui-stacks.ts` places children; a
  cell outside the window of its scroll view does not arm it).
- A layout pass has one viewport, the frame the layout engine was given. A stack
  child's `visible` must not adopt the unbounded viewport of a measuring render.
- Stacks are `ColumnStack` and `RowStack`: pi-tui's rows, the row each child
  starts at, and a horizontal stack that remembers composited rows.
- Pages switched in place keep one height, the tallest page's at the current
  width and viewport: `holdHeight` (`core/ui-stacks.ts`) pads the page on show
  for tab pages (`PageHold`) and for the views lane. Components never pin page
  heights of their own to the same end.

Every spec outside `tests/perf/` runs with `MAYFLY_UI_VERIFY_MEMO=1` (the vitest
`suite` project): every memo hit paints again and throws when the rows differ. A
stale row is a test failure, not a report from a screen.

The presentation (`core/presentation.ts`: glyph mode, monochrome, reduced
motion, from the `mayfly` settings and `NO_COLOR`) is read when a theme provider
and the components service are built, never per paint. A change restarts the
live theme provider (`reloadTheme`), so every consumer and cached row rebuilds.
The editor retained across palette swaps calls
`MayflyEditor.updateColors` and rebuild its frame around that same engine;
recoloring never replaces its cursor, undo, history, paste, or completion state.

Build surfaces from the shared components (actions row, text/choice fields,
lists, tabs, decision panels, questionnaire, loader/progress/empty). The
[UI design](../../docs/design/component-library.md) and its prototype are the
starting sketch; the owner's acceptance in the running terminal decides, and a
finalized section describes accepted behavior. Its
[implementation reference](../../docs/design/component-library-reference.md) holds
the wire mechanics. Never hand-roll pi-tui panels outside `core/`; the editor's
completion list is state only (`core/completion-list.ts`) and the palette that
paints it is `core/completion-drawer.ts`. A component that replaces a surface deletes the old code in
the same change; nothing is kept for a later cleanup.

## Shared action and sensitive-data contracts

`src/app/` and the Host own native writes. Shared marketplace, settings, provider, jobs,
and catalog models contain facts and structured actions only. They never
import Host services, mutate profile files, spawn package managers, retain
credentials, or refresh-and-retry conflicts. Keep descriptor/field revisions,
explicit confirmations, restart boundaries, and operation feedback in the
readonly models so feature owners can preserve the native semantics.

Secrets stay redacted and saved schema defaults never become form values.
MCP facts omit environment/header values. Clipboard, exports, palettes, and
external editors are frontend-local; shared nodes never encode arbitrary
Host paths or commands as executable operations. No renderer timer, panel
closure, or UI withdrawal silently rolls back or cancels Host work.

## Editor shell and terminal input

`EditorExtensionRuntime` (`src/frontend/`) is the sole editor shell,
decoration/action consumer, completion multiplexer, and pre-clear transform
barrier. Its input owner binds exact autocomplete sources, delayed-wait
ownership, and readonly attachment metadata with deferred result preparation.
Rebinding retires old callbacks and submissions; retained source callbacks and
old disposers cannot affect a successor. Palette refresh recompiles around the
same editor and focus identity. Editor-extension actions need a modifier key
that no keymap action claims.

Core's `normalizeWheelInput` is the terminal wheel decoder and
`sanitizeShellOutput` the captured-output control-sequence filter; features
route their structured results instead of decoding ANSI. The transcript
presentation policy and its settings observer follow both native document
updates and settings-source replacement, retiring queued callbacks with their
Fiber.

## Verification

Follow the root change-aware gate; lifecycle changes need the owning suite and
renderers need width scans. Core fixtures mount the UI provider and frontend
owner, and test that frontend state survives core reload. New public seams need
real consumers, replay/abort/late-result tests, width and whole-tree
composition coverage, and dedicated-profile acceptance.

Client transport changes require authentication, reconnect, stale-generation,
and detach tests plus real-Host list/create/open evidence. Registry and command
changes require same-SessionId multi-Host isolation and late-result tests.
Transcript changes require replace/prepend/append/settlement fixtures, live
projection facts, and proof that historical commands do not replay notices.
Command routing changes require Host catalog, alias, failure, and exact
Host/Session coverage. Banner, footer, editor, and panel changes require narrow
and wide rendering plus focus restoration tests. Runtime changes require the
split smoke (`node script/split-parity.mjs --scenario smoke`), proving the
banner, footer, command surfaces, Session creation, and clean teardown against
a real dsh Host; supply its Host through `MAYFLY_DSH_STARTUP_URL`, never argv.

The canonical UI pipeline takes an optional core-private work-counter sink
(`core/ui-work-counters.ts`) through the validator and compiler options;
production passes none and no module holds one. The vitest `perf` project
(`tests/perf/work-budget.spec.ts`) gates the counts of `tests/perf/workloads.ts`
and the whole-frame workloads of `tests/perf/frame-workloads.ts`: `budgets.json`
may not exceed `baseline.json`, a slice that adds a painter adds its row, and a
change to the frame path (`core/terminal.ts`, `core/surface-renderer.ts`, the
keymap, the editor-extension runtime) runs them. The design scenes
(`tests/design/scene-*.spec.ts`) drive the real renderer under the probe palette
through `tests/design/walks.ts` and compare every frame with a cell-grid golden
under `tests/design/frames/`; `vitest -u` rewrites a grid only after review.
The owner's live acceptance decides a component's look.

Publication, dependency, or composition edits require `pnpm run check:lib`,
`check:pack`, `check:examples`, `check:agent-docs`, a dedicated-profile install,
the split smoke, and human acceptance. The Harness line comes from the Host
manifest. All executable source in this package is subject to the repository's
per-file 100% coverage gate.
