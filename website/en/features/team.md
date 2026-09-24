---
title: Agent Team
---

# Agent Team

Agent Team is included in the default Mayfly distribution. Start Mayfly normally; no separate Team profile or optional bundle is needed.

```sh
mayfly
```

Explicitly ask the Lead to use Agent Team. For example: “Use Agent Team for a read-only repository review. Create two teammates, one for architecture and one for tests, and put their tasks on the shared task board.” Ordinary requests do not automatically create teammates.

The panel follows official Web behavior: `/team` shows members and shared tasks, and selecting a member opens its conversation. Agents own spawning, messaging, and task updates. All shipped presets use the native Team tools while retaining their other capabilities.

F7 switches the retained conversations; F8 closes the auxiliary view. Cold continuable history offers `i` to reply; only Send resumes the child. Reply drafts survive renderer reload. Task write scopes are advisory and teammates share a checkout.

Plugin management continues through the existing `/plugin` marketplace, with restart required after installation/removal.
