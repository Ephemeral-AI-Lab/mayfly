# Session modes

Mayfly keeps planning and permissions independent. With the editor focused, **`Shift+Tab`** toggles only:

**normal ↔ plan**

YOLO is selected separately through `/permission` and can remain active alongside plan mode. The first status row shows both `plan` in the accent color and `yolo` in the warning color; a pending plan transition displays `plan...`. These states come from dsh: plan uses the native `plan` projection, and yolo labels a `danger-full-access` + `never` permission preset.

## normal

Plan mode is off. Default permissions are `workspace-write` + `ask`: workspace operations follow native tool policy, and actions requiring approval display the four-option panel (see [Approvals & questionnaires](/en/features/approval)). Returning from plan to normal preserves current permissions, including YOLO.

## plan — plan first, act later

Plan mode gives the agent guidance to plan before acting without changing tool permissions or the filesystem sandbox. This is soft guidance, so combining plan with YOLO does not impose a read-only boundary. When the plan is final, the harness's `exit_plan_mode` request surfaces as the **plan review panel** (editor-slot replacement, mounted like the approval panel):

- the full plan renders as Markdown inside a bordered `plan` box;
- beneath it a numbered decision list — number keys pick directly, or ←→ +
  `Enter`; ↑↓ / PageUp / PageDown scroll only the plan body:

| Option | Effect |
| --- | --- |
| `1. Approve` | Approve the plan, exit plan mode, start executing with current permissions |
| `2. Reject` | Reject — the model hears "the user chose to keep planning" and reacts in the same turn |
| `3. Revise <text>` | Inline revision: keep polishing the plan with your feedback |

## yolo — full access

Enter YOLO with `/permission danger-full-access` and restore default permissions with `/permission workspace-write`. Bare `/permission` opens the permission picker. Mayfly does not register extra `/yolo` or `/yes` commands.

YOLO disables the filesystem sandbox and applies the `never` approval policy: actions that require approval are rejected without displaying an approval panel, while actions that do not require approval can run directly. **User questions and plan reviews still appear**, because the permission policy does not answer questions or approve plans for you.

`Shift+Tab` executes only `/plan` or `/plan off`, preserving YOLO. Likewise, `/permission` preserves plan state. For example, pressing `Shift+Tab` after entering YOLO shows `plan yolo` in the status bar; pressing it again ends planning and leaves `yolo` active. If the Agent preset does not provide plan mode, the shortcut reports that it is unavailable.

::: tip Relation to /preset
Plan mode is supplied by the harness's plan-mode plugin, composed through Agent presets (`/preset`, see the [slash commands reference](/en/reference/commands)). Agent presets select capabilities, `/plan` controls planning collaboration, and `/permission` controls sandbox and approval policy.
:::
