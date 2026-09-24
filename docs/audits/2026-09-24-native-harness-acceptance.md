# Native Harness adaptation: acceptance candidate

Candidate branch: `feat/native-harness`.
Worktree: `/home/x/dev/deepseek-harness-plugin/mayfly-native-harness`.
Human acceptance is pending; nothing has been merged into main.

## Automated evidence

- `verify:full`: 3,501 tests passed; executable source has per-file 100% statements,
  branches, functions, and lines. The full gate also passed repository workflows,
  type checking, lint, diagrams, exports, agent documentation, external examples,
  and the real-process happy smoke.
- `check:pack`: three tarballs passed manifest, runtime payload, published types,
  external UI consumer, and distribution checks.
- `shots:sync` followed by `shots:check`: all six app-shot checks passed. Four
  committed app screenshots changed for native session browsing/work details.
- `website:build`: passed; persistent preview remains on port 4186.
- Marketplace PTY: Unicode paste, editing, resize, file completion, provider
  form cancellation, the original `/plugin install` and `/plugin uninstall` flow,
  restart guidance, and exit restoration passed on Linux x64.
- Native Team PTY: default distribution, all five shipped presets, official tool
  composition, teammate creation, native task
  projection, exact live Agent selection, cold history, addressed continuation,
  40-column rendering, and cleanup passed with a local mock LLM.

The global `dsh` on PATH is still 0.1.5-rc.2. Use the worktree's 0.1.7-rc.1 CLI:

```sh
export PATH=/home/x/dev/deepseek-harness-plugin/mayfly-native-harness/packages/mayfly/node_modules/.bin:$PATH
dsh --profile mayfly-native-harness
```

The `mayfly-native-harness` development profile uses the default Mayfly bundle,
including Agent Team. Its native support packages
resolve from the same pinned Harness dependency graph, avoiding the older
installation's peer modules. Production profile `mayfly` was not changed.

## Runtime acceptance

1. In `mayfly-native-harness`, open `/plugin` and exercise catalog browsing,
   `/plugin info <id>`, installation, and removal. The original marketplace
   cache and `marketIndexUrl` configuration remain supported. Installation and
   removal report the restart/new-session boundary; HMR remains disabled.
2. In the same default profile, explicitly ask the Lead to use Agent Team for a
   read-only review with two teammates and shared tasks. `/team` should show the
   roster and task board, including owners, blockers, readiness, and advisory
   write scopes. Select a teammate and use F7/F8 to switch/close its view. Quit and
   resume the saved Lead session; selecting a cold continuable member should show
   history, and `i` → Send should resume that member. Browsing alone must not
   activate it. A reply draft should survive renderer reload.
3. At 40 columns, repeat roster/task browsing and the reply workflow. Also check
   ordinary `/agents`, `/btw`, permissions, model selection, and theme switching.
4. Check `/sessions` title filtering, configured content search, archive refusal
   for active work, explicit stop-and-archive, and restore. `/schedule` should
   distinguish unavailable, empty, scheduled, and overdue reminders; delivery is
   session-local. `/files` reads bytes only on Preview/Open, and `/mcp` resource
   catalogs fetch bodies only on Read.

Feature configuration and removed settings are documented in
[Native Harness features](../native-harness-adaptation.md).

## Website acceptance

The preview remains running. Review the relevant language variants:

| Content | English | Chinese |
| --- | --- | --- |
| Team | http://192.168.8.188:4186/en/features/team | http://192.168.8.188:4186/features/team |
| Settings | http://192.168.8.188:4186/en/guide/config | http://192.168.8.188:4186/guide/config |
| Commands | http://192.168.8.188:4186/en/reference/commands | http://192.168.8.188:4186/reference/commands |
| Existing plugin marketplace | http://192.168.8.188:4186/en/market/installing | http://192.168.8.188:4186/market/installing |
| Discovery catalog | http://192.168.8.188:4186/en/market/ | http://192.168.8.188:4186/market/ |
| Catalog trust | http://192.168.8.188:4186/en/market/trust | http://192.168.8.188:4186/market/trust |
| Catalog metadata | http://192.168.8.188:4186/en/market/manifest | http://192.168.8.188:4186/market/manifest |
| Homepage screenshots | http://192.168.8.188:4186/en/ | http://192.168.8.188:4186/ |

Do not stop the preview or remove the development profiles before acceptance.
