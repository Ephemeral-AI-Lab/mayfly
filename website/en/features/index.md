# Features overview

Mayfly runs a native dsh Host and an independent Remote TUI on Harness
`0.2.2-alpha.3`. Each process has its own Cordis tree. The published
`0.1.4-rc.2` release is the immutable UI, key, and workflow reference.

## Data and interaction

- native Harness `sessionProjections` drive conversation, token/context,
  title, and session facts;
- Host commands register on native `commands`; Remote routes frontend commands locally and discovers native Session commands through the official Client;
- Remote owns HostKey + SessionRef selection for primary and side conversations; Host owns exact Agent/Session domain state;
- transcript and interaction do not maintain a second Agent/Session truth.

## Terminal UI

- core is the only pi-tui/raw-terminal owner;
- status producers register directly on `mayflyStatus`;
- activity, queue, todo, Agent, and workflow panes register on `mayflyPanes`;
- BTW, subagents, and stored children all render in the one transcript pane; live ones drive the complete main layout, cold or one-shot ones are read from native history as read-only or resumable;
- Remote jobs, `/jobs`, and `/agents` consume native transport facts and focused Host DTOs;
- `mayflyOverlays` renders overlay contributions;
- `mayflyEditorExtensions` composes extensions around the one Mayfly editor.

External plugins and built-ins use the same services and Fiber lifecycle.

## Continue

- [Streaming transcript and tool cards](/en/features/streaming)
- [Input editor](/en/features/editor)
- [Approvals and questionnaires](/en/features/approval)
- [Status bar](/en/features/status-bar)
- [Optional Agent Team](/en/features/team)
- [Session modes](/en/features/modes)
- [Bottom panes](/en/features/panes)
