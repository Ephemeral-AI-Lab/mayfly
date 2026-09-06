# Features overview

Mayfly `0.1.0-alpha.2` is a flat Cordis plugin tree over `dsh-base`. The
bundle inserts six dsh support rows and 28 Mayfly rows.

## Data and interaction

- native Harness `sessionProjections` drive conversation, token/context,
  title, and session facts;
- built-in commands register directly on native `commands`;
- app owns the primary Agent and one auxiliary slot, exposing the exact
  displayed identity through `mayflyCurrentAgent`;
- transcript and interaction do not maintain a second Agent/Session truth.

## Terminal UI

- core is the only pi-tui/raw-terminal owner;
- status producers register directly on `mayflyStatus`;
- activity, queue, todo, Agent, and workflow panes register on `mayflyPanes`;
- BTW and live continuable subagents reuse the complete main layout; cold or one-shot children use a core-owned readonly transcript panel;
- the jobs footer, `/jobs`, and `/agents` consume native Harness services;
- `mayflyOverlays` renders overlay contributions;
- `mayflyEditorExtensions` composes extensions around the one Mayfly editor.

External plugins and built-ins use the same services and Fiber lifecycle.

## Continue

- [Streaming transcript and tool cards](/en/features/streaming)
- [Input editor](/en/features/editor)
- [Approvals and questionnaires](/en/features/approval)
- [Status bar](/en/features/status-bar)
- [Session modes](/en/features/modes)
- [Bottom panes](/en/features/panes)
