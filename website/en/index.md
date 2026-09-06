---
layout: home
pageClass: brand-home

brandHero:
  eyebrow: A dsh-based multi-agent terminal
  name: mayfly
  tagline: ephemeral agents, enduring works
  versionNote: v0.1.0-alpha.3 · Preview
  install: npm -g install @ephemeral-ai/mayfly-cli
  copyLabel: copy
  copiedLabel: copied
  actions:
    - theme: brand
      text: Get started
      link: /en/guide/
    - theme: alt
      text: GitHub
      link: https://github.com/Ephemeral-AI-Lab/mayfly

brandFeatures:
  kicker: Why mayfly
  title: Brief agents, lasting works.
  items:
    - title: Transparent by default
      details: "Every model thought, tool call, and sub-agent fan-out lands in one Harness event stream; /trace replays the full trajectory at any time. dsh owns the domain state — Mayfly just renders it faithfully in your terminal."
      image: /shots/app-trace.svg
      alt: Replaying a session trajectory with /trace in the Mayfly terminal
      caption: /trace — one replayable event stream
      link: /en/reference/commands
      linkText: Slash commands →
    - title: Many agents, one stream
      details: "Harness natively orchestrates subagents, background agents, and workflows that advance in parallel over a shared stream of facts. Mayfly surfaces each agent's progress and output side by side in the terminal."
      image: /shots/app-agents.svg
      alt: Multiple agents collaborating in the Mayfly terminal
      caption: subagents — parallel, shared facts
      link: /en/dsh/tools
      linkText: Built-in tools →
    - title: Permissions you control
      details: "Sandboxing, approvals, and presets are defined by dsh's mode system, and every privileged action stops for your confirmation. Mayfly contributes the approval UI; the decision and its audit trail stay with Harness."
      image: /shots/app-permission.svg
      alt: A permission approval prompt in the Mayfly terminal
      caption: approval — every call goes through you
      link: /en/dsh/modes
      linkText: Modes & permissions →
    - title: Sessions you can rewind
      details: "/sessions lists past sessions, /fork branches from any point, and /rewind replays to an earlier state. Sessions and events are persisted by Harness — Mayfly is simply your way back."
      image: /shots/app-sessions.svg
      alt: Session list and rewind in the Mayfly terminal
      caption: /sessions · /fork · /rewind
      link: /en/reference/commands
      linkText: Slash commands →
    - title: An interface you can extend
      details: "Everything you see in the terminal comes from a plugin: Mayfly exposes only four UI services and a shared UI kit, so external plugins contribute interfaces with the same components as the built-ins."
      image: /shots/uikit-builder.svg
      alt: Components from the Mayfly public UI kit
      caption: ui-kit — interfaces contributed by plugins
      link: /en/plugins/
      linkText: Developer manual →
---
