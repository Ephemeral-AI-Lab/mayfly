# `@ephemeral-ai/mayfly-ui`

This package owns the renderer-neutral `MayflyUiNode` wire contracts, pure
builders, and the four direct Mayfly UI contribution services. The root entry
has no Cordis runtime import; `./provider` is the sole Cordis entry and mounts
`mayflyPanes`, `mayflyStatus`, `mayflyOverlays`, and
`mayflyEditorExtensions`. It must not depend on Harness, the Mayfly runtime,
pi-tui, terminal objects, or mutable product state.

Builders must remain side-effect free and preserve the handwritten wire shape.
They recursively clone caller-owned wire data before freezing the result and
reject cycles and enumerable accessors without invoking getters, including
before spreading builder options. Only snapshots produced by the same module's
`freezeWire` may share immutable object identities; arbitrary frozen objects,
`deepFreeze` results, and other module copies must still be cloned. Keep this
trust internal and weakly held, without wire metadata or global registration.
Stacks normalize plain nodes to `{ node }`; flex sizing and
viewport conditions still require explicit `ui.child(node, options)` wrappers.
List `detailSpans`, like all inline semantic content, pass through unchanged
and are cloned/frozen with their list item. Do not add hidden layout metadata
or renderer callbacks to nodes.

Markdown, diagram, and chart builders preserve only the public wire data. They must not
import, configure, or expose Mermaid/chart renderer libraries, and they remain
outside the narrower status, editor-extension, and section-content unions.

`defineMayflyComponent` is a package-level composition factory. It validates
the component id and render function, then freezes render output.
It must not validate node schemas, register component kinds, capture a Fiber,
or create a runtime registry. Core owns schema admission, quotas, and compile.

Keep runtime source fully covered. Type fixtures must prove component prop
inference, the explicit child boundary, and rejection of custom node kinds.
Provider tests must prove registration ownership, delta replay, snapshot set, duplicate
id rejection, Fiber cleanup, and cancellable pane/overlay snapshot loading. Async
providers live on service definitions and publish frozen node snapshots; functions,
Promises, cursors, or renderer state must never be embedded in `MayflyUiNode`.
Automatically started loads contain failures; explicit pane loads reject on
current provider failures and settle normally on cancellation. Snapshot replacements
fence pending results, failures, and pagination cursors. Overlay visibility/focus changes preserve pending
content loads, and the initial entry is published before invoking the provider.
Admit definitions and initial snapshots before
registering effects; all publication and cleanup must use the admitted id even
when callers later mutate their definitions. Built root/provider tests must
prove that trusted builder snapshots retain identity through publication.

Snapshot `set()` accepts data refreshes or explicit replacements, with native
source stamps and a replacement-only scope change. It rejects legacy
`eventRevision` metadata and caller-manufactured acknowledgements. Entry event
endpoints prepare frozen structured replies; core admits the reply before its
single-use publisher updates the original registration. Definitions split
`onEvent.observe` from `onEvent.action`: observations receive only change/toggle/tab
facts and cannot publish, navigate, or dismiss, while every handled action must
return a structured settlement. Replacement/disposal revokes old entry endpoints,
pending handlers, prepared publishers, and progress callbacks; ordinary data and
overlay visibility changes preserve valid actions. Current scope/source metadata
must survive later snapshots that omit it. No renderer, draft, or operation-busy
state belongs in these provider endpoints.

An action's `dismiss` requests the shared dirty-close flow. A successful reply
may request dismissal after publication; invalid/conflict/failed replies cannot
hide their feedback through dismissal. Dismissal callbacks and action replies
remain registration-owned, outside node data.

`presentation: 'editor'` is a capturing overlay in the existing editor host,
using the same registration, event, source, and lifetime contracts as a modal.
Focus raises its activation order without replacing its snapshot. Action `read`
and `submit` boundaries are mutually exclusive; `selections` names shared list
drafts included in the immutable inputs. Read results must be fenced when their
input revisions change. Replies may navigate semantic page paths, never renderer
handles. Partial failures may acknowledge explicit submitted field addresses
alongside their authoritative snapshot; unacknowledged drafts remain editable.

Action `navigate` is a renderer-neutral page link. It may declare `read` inputs
for local validation, but cannot also submit or dismiss. Wizard tabs record
completion against the validated form revisions in the frontend model; builders
and providers retain no completion state. Tab items may name a sibling `backId`;
core rejects cycles and unknown return targets. Back preserves drafts. Overlay
`dismissal: 'discard'` explicitly maps outer cancellation to a native request
outcome without dirty confirmation; the default is `confirm-dirty`. Local picker
and page return behavior still runs before outer dismissal.
