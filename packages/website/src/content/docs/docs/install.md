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

If you'd rather configure Codex manually (for the Codex Desktop app, or to run `codex` without going through `lore run`), run [`lore setup codex`](/docs/setup/) once — it writes `~/.codex/config.toml` with the gateway URL and the no-auto-compact override. See the [Setup command](/docs/setup/) page for the full reference.

You can also run the gateway directly with npm:

```bash
npx @loreai/gateway
```

## Slimmer installs (remote embeddings)

Lore's on-device (local) embeddings run through `@huggingface/transformers` and the ONNX runtime — about 480 MB of ML runtime that's pulled in when you `npm install` a Lore package (`@loreai/core`, `@loreai/opencode`, `@loreai/pi`). It's an **optional dependency**, so if you use a remote embedding provider — or don't need vector recall — you can skip it:

```bash
npm install @loreai/opencode --omit=optional
```

With the stack absent, recall degrades gracefully to FTS-only keyword search. To keep semantic recall without the local runtime, set a remote provider in `.lore.json` (`search.embeddings.provider` = `voyage` or `openai`, with the matching API key). The hosted install script and the standalone binary are unaffected — they ship their own runtime and never read `node_modules`.

## Existing Conversations

Lore can import previous coding conversations so a new project memory does not start from a blank slate:

```bash
lore import
```

Imported history feeds the same distillation and knowledge pipeline as live sessions.
