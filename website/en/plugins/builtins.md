# Built-in plugins

The Mayfly bundle inserts ordinary Cordis siblings over `dsh-base`: a set of
dsh support rows and the Mayfly product rows (`cordis.patch.yml` is the row
list of record). There is no group/isolate or private service realm.

<!-- BEGIN diagram:mayfly-composition -->
<!-- single source 单一来源: docs/diagrams/mayfly-composition.mmd — edit the .mmd, then `pnpm run diagrams:sync` -->
```mermaid
flowchart TB
    BASE["dsh-base"]
    subgraph GRAPH["flat Cordis sibling graph"]
        SUPPORT["dsh support rows<br/>subagent settings · presets · host runner · workspace<br/>connection · file upload · session controller · title"]
        UI["@ephemeral-ai/mayfly-ui provider<br/>four direct UI registries"]
        RUNTIME["@ephemeral-ai/mayfly runtime rows<br/>frontend · conversation · app · core<br/>transcript · status · panes · interaction"]
        PLUGINS["external Cordis plugins"]
    end
    NATIVE["native dsh services"]

    BASE --> NATIVE
    NATIVE --> SUPPORT
    NATIVE --> RUNTIME
    NATIVE --> PLUGINS
    UI --> RUNTIME
    UI --> PLUGINS
```
<!-- END diagram:mayfly-composition -->

## Support rows

- subagent model settings and agent presets;
- dynamic Cordis host runner;
- workspace, connection, and file-upload;
- session controller;
- all-prompts title provider.

## Mayfly rows

- `mayfly-ui-provider`: mounts the four direct UI registries from `@ephemeral-ai/mayfly-ui/provider`;
- `mayfly-frontend`, `mayfly-core`, and dark theme;
- `mayfly-conversation`, startup, app/current Agent;
- banner, transcript, and official model;
- basic/cwd/git/title/context/mode/jobs/goal status;
- activity/queue/todo/agents/workflow panes;
- BTW, jobs, and agents commands, attachments, paste image, editor-plus, and interaction.

External plugin rows share this service graph. Activation dependencies come
from `inject`, not YAML position. Every built-in status or pane uses the same
`mayflyStatus`/`mayflyPanes` registry available to external plugins.
