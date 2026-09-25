# Interaction refactor resume plan and current audit

Status date: 2026-09-08. The candidate implementation lives on
`refactor/ui-interaction` at baseline `b82acd2`. Codex session
`01a07aa1-3760-7791-92dd-dc5f797f2874` was used to recover earlier decisions;
nothing later depends on that session being recoverable — all facts are taken
from the worktree.

## Done

- The public interaction protocol, provider endpoints, the stable frontend
  owner, and the core compiler have switched to the single model.
- Provider, Settings, request-type interactions, Tools/MCP/Skills,
  Help/Trace/Session/Agents, Jobs/Market/Update, notifications, Queue, and
  editor extensions have all been migrated.
- The old generic panel/controller stack and compatibility fields have left
  the production tree.
- The external overlay example proves an ordinary plugin can read and write
  native settings with the same Form/Tabs/action/reply semantics.
- Whole-repo typecheck, lint, and per-file 100% coverage pass; exact numbers
  are in [implementation progress](./ui-interaction-progress.md).
- Architecture, seams, AGENTS, both README languages, and the Website plugin
  reference are synced to the final protocol.

## Current boundary

Technical implementation, the release-candidate automated gate, Step 19 manual
acceptance, and Step 20 merge cleanup are all complete:

1. The four candidate commits merged into main via `5fbbdc8`.
2. The main checkout was rebuilt and passed `check:lib`.
3. The Website preview, dedicated profile, and worktree were cleaned up.

The shared `mayfly` profile was not used for candidate acceptance. The Website
preview, dedicated profile, and worktree are each retained only until the user
explicitly accepts, then cleaned up per repository procedure.

## Manual acceptance order

Runtime entry:

```sh
dsh --profile mayfly-ui-interaction
```

Website entries:

- `http://192.168.8.188:4183/plugins/ui-reference`
- `http://192.168.8.188:4183/plugins/component-model`
- `http://192.168.8.188:4183/en/plugins/ui-reference`

| Group | Main flow and expected result | Failure, narrow-screen, or lifecycle checks | Neighboring behavior must not regress | Status |
| --- | --- | --- | --- | --- |
| A | Edit Forms and single/multi Choice in `/provider` and `/settings`; Save commits only changed paths, Cancel writes nothing | Required-field errors stay on the field; partially successful credentials retry only the unfinished part; closing with unsaved content defaults to No; 40-column or short windows do not overflow | Text input, Tab grouping, layer-by-layer Escape return, and the original config-file entry all normal | Accepted |
| B | Operate Tabs, Tree, Search, and long Documents in `/agents`, `/trace`, `/help`, `/tools`, etc.; focus, expansion, and scroll anchors match the current content | Clearing a search restores expansion; prepend/append or width changes still locate the same semantic content; returning or a renderer reload does not resurrect a closed subpage | PageUp/PageDown/Home/End, parent/child return, and large-list windowing stable | Accepted |
| C | Initiate OAuth from Provider and actually handle approvals, questions, and plan review; each native request settles exactly once | URL/code stays visible; Escape defaults to decline; user refusal, signal withdrawal, and whole-authorization cancellation are distinguishable; late results do not reopen UI; Other and empty answers keep their semantics | Request FIFO/allowance, sensitive values never backfilled or leaked, editor focus restores normally | Accepted |
| D | `/plugin` browses details and install state, `/jobs` shows paged output and stops tasks, `/update` shows preflight, execution state, and the final result | Offline/install failure gives clear feedback; Jobs long lines and cross-page content are complete with no repeat consumption while paging; stop does not confirm by default; an update failure rolls back | Marketplace tabs, profile/source labeling, native Job terminal state, and update reentry protection all normal | Accepted |
| E | Edit/submit/steer in Prompt, browse Session/Agents, and trigger editor-extension action, completion, and transform | F7/F8 toggle and close the auxiliary session; attachment failure rolls back; late results after cancel, timeout, replacement, or unload take no effect | Exact Agent, drafts, attachments, completions, and the primary-session transcript never cross wires | Accepted |
| W | Read the three Website routes above and check the Chinese/English protocol descriptions, component screenshots, sidebars, and narrow-screen layout | Page refresh and direct subroute opens work; no cropped, overlapping, or stale-interaction screenshots | Language switching, prev/next pages, and other developer-manual navigation normal | Accepted |

The first manual acceptance on 2026-09-08 found: a doubled outer frame on the
command overlay, the permission selector missing its `mayflyOverlays` inject,
Settings field navigation/Tab causing unintended adjustments, and the editor
command panel not honoring the height cap. The candidate now uniformly merges
registration/root frames, adds the missing inject, switches to focused
navigation state with Enter-only select application, and makes editor
presentations honor the default one-third `maxHeight` while short content
keeps its natural height; A–D awaited re-verification with the rebuilt
dedicated profile.

The second round of feedback asked for the default height to be one third of
the screen, short Version-type panels to shrink to content, and pointed out
that `/context` produced an illegal progress value from a fractional token
estimate. The candidate now normalizes context window/occupancy to safe
integers, caps long panels at 8/24 rows, and `/version` is 6 rows on real
hardware; `/context`, `/plugin`, and `/version` were all re-verified in the
dedicated profile and included in the final acceptance.

On 2026-09-08 the user explicitly replied "验收通过", accepting runtime
scenarios A–E and Website scenario W; Step 19 is complete and the candidate
moved on to post-acceptance merge and cleanup.

Each acceptance record covers the primary workflow, the expected result, the
failure or lifecycle branches, and whether neighboring behavior regressed. Any
post-acceptance source adjustment reruns the corresponding automated gate.

## Merge conditions

The final source gate, Website/profile re-verification, user acceptance,
branch merge, main-checkout rebuild, and resource cleanup are all complete.
The pre-existing artifacts/audit files on main were preserved; the overlapping
early PR #15 document original was saved separately as stash commit `dfcdfe3`,
and the final document kept and updated its valid content.
