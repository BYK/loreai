---
title: Install Lore
description: Install Lore locally and launch your coding agent through the memory gateway.
sidebar:
  order: 1
---

Install Lore with the hosted install script:

```bash
curl -fsSL https://withlore.ai/install | bash
```

Then launch Lore with your detected coding agent:

```bash
lore run
```

Lore auto-detects Claude Code, OpenCode, Pi, Codex, and Hermes Agent when you run `lore run`. For harness-specific setup, see the Guides section.

If you'd rather configure Codex manually (for the Codex Desktop app, or to run `codex` without going through `lore run`), run [`lore setup codex`](./setup/) once — it writes `~/.codex/config.toml` with the gateway URL and the no-auto-compact override. See the [Setup command](./setup/) page for the full reference.

You can also run the gateway directly with npm:

```bash
npx @loreai/gateway
```

## Existing Conversations

Lore can import previous coding conversations so a new project memory does not start from a blank slate:

```bash
lore import
```

Imported history feeds the same distillation and knowledge pipeline as live sessions.
