# Service seam reference

## Native Host services and Remote

Host plugins directly inject public dsh services such as `commands`,
`sessionProjections`, `tools`, `settings`, `skills`, and `sessionController`.
Agent-scoped operations require the exact invocation Agent, such as
`invocation.agent` in a native command handler.

The Remote TUI uses official Client/Remote Session faces, whole projections, and
native file routes. Focused `mayflyHost` methods supply presentation queries and
guarded writes missing from native transport, using serializable DTOs. They do
not expose arbitrary service, filesystem, or tool invocation.

`statsHistory` requires global Host authorization in both current-workspace and
all-workspace modes; permission for one Session allows only its own statistics.
Raw settings-document saves share the native configuration profile lock,
compare the revision under that lock, and replace the file atomically. This
protection does not cover external editors that ignore the lock and write
after the final check.

## Four TUI UI services

| Service | Write | Consumer |
| --- | --- | --- |
| `mayflyPanes` | `register(MayflyPaneDefinition, MayflyUiNode)` | Core surface renderer |
| `mayflyStatus` | `register(MayflyStatusDefinition, MayflyStatusNode)` | transcript footer |
| `mayflyOverlays` | `open(MayflyOverlayDefinition, MayflyUiNode)` | Core overlay renderer |
| `mayflyEditorExtensions` | `register(MayflyEditorExtensionDefinition, MayflyEditorDecoration)` | editor shell |

`@ephemeral-ai/mayfly-ui` provides the Context declaration merge, contracts, and
pure builders. Host plugins and native browser client halves cannot inject
these frontend-local registries. TUI extensions currently require source
integration and a restart; `/plugin` installation and dynamic hot mounting do
not install them.

## Selection and notifications

Remote owns HostKey + SessionRef and writable, resumable, or readonly
conversation state. Selection change and detach retire the old generation's
reads, subscriptions, and write replies. Agent and Session objects never cross
processes; the shared package exposes no public current-Agent or conversation
navigation facade.

A TUI source consumer supplies an explicit scope callback for a shared
notification owner:

```ts
import { createInteractionNotificationOwner } from '@ephemeral-ai/mayfly/frontend'

const notifications = createInteractionNotificationOwner(ctx, 'acme.health',
  () => ({ kind: 'app', targetId: 'acme.health' }))
```

For Session notifications, the consumer's callback returns its current
`MayflyUiScope`. The consumer owns Host/Session selection and lifetime; the
helper never looks up a native Agent.

## Lifecycle

Every registration belongs to the consumer Fiber. Registries and frontend
interaction state survive Core/theme reload; a remounted renderer reads the
current snapshots. Contribution unload removes registrations and revokes
pending replies. Drafts, confirmations, paging, and semantic focus belong to
the frontend. ANSI, visible width, terminal handles, layout, and rendering
caches belong to Core.
