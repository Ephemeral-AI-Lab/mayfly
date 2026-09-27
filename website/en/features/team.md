---
title: Agent Team
---

# Agent Team

Agent Team is an optional marketplace plugin providing a separate collaboration
preset and Mayfly terminal UI. Existing presets keep ordinary delegation;
installing the plugin does not enable Team in them or change the default.

## Install and use

```text
/plugin install agent-team
```

Restart Mayfly, start a new session, and choose the preset:

```text
/preset team
```

`team` builds on the ordinary `standard` coding preset. The normal / plan
execution mode remains independent. Explicitly ask the Lead to create teammates,
for example: “Use Agent Team: have reviewer check permissions and tester inspect
tests, record the work on the shared board, then wait and summarize.”

## Terminal UI

`/team` displays members and shared tasks. Wide terminals show both columns;
narrow terminals use tabs while retaining search and selection. Lists show
activity, owners and blockers; overlapping write scopes are visible in the
overview. Task details can open the owner's conversation.
Native Agent tools create teammates, exchange messages and modify tasks;
the board remains read-only.

Select a teammate to open its conversation. F7 switches the retained primary
and auxiliary views; F8 closes the auxiliary view without stopping the teammate.
Replies offer Queue (after the current turn) and Steer (at the next step boundary).
An unloaded member first opens as history; press `i` to reply. Only Send resumes
it. Drafts survive renderer reloads.

## Boundaries

Members share a working directory; write scopes are advisory, not filesystem
locks. Team supplies no separate worktrees or automatic merging.
Install, remove and update follow the existing `/plugin` restart boundary.
Removing the plugin does not delete Team session logs; reinstall it before
resuming those sessions.

Source: [Ephemeral-AI-Lab/dsh-plugins](https://github.com/Ephemeral-AI-Lab/dsh-plugins/tree/main/plugins/mayfly-agent-team).
