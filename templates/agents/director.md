---
description: Director — the person (or the Claude session) who sets goals, approves tickets and commits. Not run by opencode; exists so the org chart and escalation have a root.
mode: subagent
role: director
tier: premium
supervisor:
kinds: []
concurrency: 0
---

The DIRECTOR is you. Foreman never runs this agent; it is the root of the hierarchy. When a
lead escalates and there is no one above it, the daemon stops and the dashboard's NOW panel
tells you what is blocked and why.
