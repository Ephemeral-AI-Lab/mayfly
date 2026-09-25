# Interaction model 20-step completion audit

Status date: 2026-09-08. Candidate branch: `refactor/ui-interaction`. Baseline:
`b82acd2`. Candidate version: `0.1.0-alpha.4`.

This table checks each item against the
[20-step execution plan](./ui-interaction-migration-steps.md). Code, tests,
build artifacts, pack output, running processes, and human feedback are the
authoritative evidence; progress prose itself does not prove completion.

| Step | Requirement | Current authoritative evidence | Verdict |
| --- | --- | --- | --- |
| 1 | Pin the baseline, consumers, and failure taxonomy | The execution plan's tail contains the 18-category consumer matrix; the worktree, branch, and Codex session purposes are pinned | Done |
| 2 | Fix dependencies and fixtures | `command-registration.spec.ts`, the pane/overlay bridges, `e2e.spec.ts`, and the app-shot boot use real provider/frontend dependencies | Done |
| 3 | Final event/receipt protocol | `packages/ui/src/interaction.ts` and `snapshot-events.ts`; provider type/runtime tests and the external overlay consumer; zero hits for the old field structure | Done |
| 4 | Operation, close, and parent/child lifecycles | `ui-interaction-state.spec.ts`, `request-overlay.spec.ts`, and `update-command.spec.ts` cover single-flight, abort, late results, same-name reopen, and close policies | Done |
| 5 | Form/Choice/Tabs/Wizard/Decision | The corresponding core reducer specs, renderer traces, and the Provider plus external two-page settings overlay; default No, cross-page submit, partial ack, and conflict are all asserted | Done |
| 6 | Action query, input, and hints from one source | `ui-compiler.spec.ts`, `ui-interaction-renderer.spec.ts`, and the keys/input tests cover the live keymap, capture, IME text, paste, disabled/busy, and hints | Done |
| 7 | Document semantic anchors | `ui-interaction-document.spec.ts` and the renderer tests cover prepend/append, width changes, follow=end, rebuilds, empty documents, and main/alternate | Done |
| 8 | Tree/Search and large lists | Choice/Tree/Search tests cover disclosure, ancestor matching, clearing, and delete/reorder; the 100k flat/filtered/Tree benchmarks prove a stable render/move reads only the viewport neighborhood | Done |
| 9 | Notifications and feedback | Notification store/state/input tests cover owner/scope/operation, the 5-second visibility clock, hidden pause, progress settlement, warning/error handling, and sensitive isolation | Done |
| 10 | The three kinds of editor-extension requests | `editor-extension-runtime.spec.ts` covers action, completion, transform, timeout, replacement, attachment rollback, shell reload, and structured failure | Done |
| 11 | Config and request-type consumers | Provider add/edit/onboarding, Settings, model/preset/permission/plan, authorization, and approval/questions/plan-review tests cover native revisions and lifecycles | Done |
| 12 | Catalog-type consumers and the marketplace | Help, Tools, MCP, Skills, and plugin-market tests cover readonly browsing, redaction, offline/refresh/install rollback, detail parent/child lifecycles, and locale | Done |
| 13 | Session/Agents/Jobs/Trace/readonly history | The commands, agents, jobs, trace, and session-transcript tests cover new/resume/fork/rewind requests, same-ID replacement, cold history, images/tools, exact Agents, and one consuming read | Done |
| 14 | Update and the legacy notification producers | The update/check/swap, input, queue, and paste/session-export tests cover preflight, swap/rollback, reentry, attachment-only summaries, and structured notification ownership | Done |
| 15 | Delete the old controllers/compatibility paths | 10 old panel/controller source and test files deleted; `eventRevision`, `selection-change`, `refreshMode`, max-leaf, and leaf path/offset/scroll searches all hit zero in the production and test trees | Done |
| 16 | Lifecycle, coverage, performance, width | 193 test files, 3183 tests passing; all four metrics at per-file 100%; width/app shots, three PTY groups; performance and CJK Jobs results are in the progress document | Done |
| 17 | Docs, examples, versions, screenshots | Architecture/seams/AGENTS/README/Website synced in both languages; the three alpha.4 packages in lockstep; the external settings overlay; 36 component + 6 app shots current | Done |
| 18 | The full release-candidate gate | Final `verify:full`, `check:pack`, `shots:check`, and `website:build` pass; the 3 tarballs pass publint and the package closure | Done |
| 19 | Dedicated profile and manual acceptance | `mayfly-ui-interaction` link-installed; real startup, config expansion, and happy/PTY/mouse/output smoke pass; the user accepted all A-E/W scenarios on 2026-09-08 | Done |
| 20 | Post-acceptance merge and cleanup | The four candidate commits merged into main via `5fbbdc8`; main build/check:lib pass; the preview, profile, and worktree were cleaned up, and the alpha.4 pack artifacts moved into main | Done |

## Final automated evidence

```text
verify:full
  Test Files  193 passed | 2 skipped (195)
  Tests       3183 passed | 7 skipped (3190)
  Statements  18056/18056 (100%)
  Branches    13404/13404 (100%)
  Functions   3698/3698 (100%)
  Lines       14453/14453 (100%)
  HAPPY_SMOKE_PASS exit=0

check:pack
  3 alpha.4 tarballs; publint passed
  external UI kit packed runtime and types passed

shots:check
  36 component shots current
  6 app shots passed

smoke:pty / smoke:pty:mouse / smoke:pty:output
  all passed on the final runtime source
```

The performance command, environment, the 100k list/Tree/Document numbers, and
the CJK Jobs cause are recorded in the
[implementation progress](./ui-interaction-progress.md). The Website strict
build passed; manual acceptance used three routes including
`http://192.168.8.188:4183/plugins/ui-reference` plus
`dsh --profile mayfly-ui-interaction`, all cleaned up after acceptance.

## Completion boundary

Steps 1–20 are all complete. The main merge commit is `5fbbdc8`; the main
checkout was rebuilt and passed 53 lib closure checks. The Website preview, the
`mayfly-ui-interaction` profile, and the worktree have been removed; the
alpha.4 pack evidence is preserved in main `.artifacts/ui-interaction-alpha4/`.
