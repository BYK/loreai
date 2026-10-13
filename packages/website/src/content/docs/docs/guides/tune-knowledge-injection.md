---
title: Tune knowledge injection
description: Adjust how architecture notes compete for space in a coding agent's context.
sidebar:
  order: 10
---

Lore selects context-bound knowledge under a token budget. When it has task context, architecture notes compete with gotchas, decisions, and patterns by relevance. Without task context, Lore uses a confidence-ranked fallback. Selected knowledge reaches the agent through a smaller, 400-token full-content delta; other selected entries can appear as recall-by-ID hints. Only entries sent in full count as injected for outcome tracking. To restore the former first pass for architecture notes in local mode, set this in your project's `.lore.json`:

```json
{
  "knowledge": {
    "architectureInjection": "reserved"
  }
}
```

| Mode | What happens |
|---|---|
| `ranked` (default) | Architecture notes compete by relevance with gotchas, decisions, and patterns from the start. |
| `reserved` | Architecture notes get the former 20% first pass; all remaining entries compete by relevance. |

When task context is absent, both modes use confidence instead of relevance. Hosted mode ignores project `.lore.json` files; this setting applies to local mode. The setting does not delete knowledge. Both modes leave architecture notes available through recall and explicit category reads. Preferences, distillations, and other knowledge categories keep their existing rules. Remove the field to use the `"ranked"` default.

Restart Lore and start a new session after changing the setting: a running session pins its selected knowledge to keep the prompt stable. Compare completed tasks, including missed requirements and wrong decisions, as well as how much off-task context appeared. A test pass in a session where an entry was injected does **not** prove that entry helped; Lore's per-entry outcome counts measure co-occurrence, not contribution.
