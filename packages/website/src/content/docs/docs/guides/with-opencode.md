---
title: OpenCode with Lore
description: Set up Lore as an OpenCode plugin and route every LLM call through the memory gateway.
sidebar:
  order: 1
---

OpenCode is a terminal-based AI coding agent. The `@loreai/opencode` plugin runs inside OpenCode and routes every LLM call through the Lore gateway transparently.

## Install

Add the plugin to your project's `opencode.json`:

```json
{
  "plugin": [
    "@loreai/opencode"
  ]
}
```

Restart OpenCode. The plugin is installed automatically on first run.

:::note
The package is also published as `opencode-lore` (legacy alias). Both names ship identical code at every release — either works.
:::

## What you get

Once the plugin is loaded, every conversation you have with OpenCode is captured in Lore's three-tier memory. Distillations run in the background, the recall tool is available in any session, and your project knowledge is exported to `.lore.md` and `AGENTS.md` automatically. See the [architecture overview](../architecture/) for the full picture.

## Local embeddings

Recall uses `@huggingface/transformers` with `nomic-embed-text-v1.5` (768-dim INT8 quantized, ~137 MB) for on-device vector search by default — no API key required. The model downloads on first use and is cached locally.

If local embeddings fail (for example, CUDA 13 on Linux/x64 with `onnxruntime-node`), set `VOYAGE_API_KEY` or `OPENAI_API_KEY` in your environment and recall transparently switches to that provider. You can also pin a hosted provider explicitly in `.lore.json`:

```json
{ "search": { "embeddings": { "provider": "voyage" } } }
```

If none of the above apply, recall falls back to FTS-only search.

## Pointing OpenCode at a local LLM server

OpenCode users running a local LLM server (vllm, llama.cpp, ollama, LM Studio, etc.) should configure the provider's `baseURL` in OpenCode to point at the running gateway URL. The `@loreai/opencode` plugin reads `LORE_UPSTREAM_<PROVIDER>` from your environment and injects it as the `x-lore-upstream-url` header on each request:

```bash
export LORE_UPSTREAM_VLLM=http://localhost:8000
# or
export LORE_UPSTREAM_OLLAMA=http://localhost:11434
```

The URL is the server root — do not include `/v1` (the gateway appends API paths automatically). See the [local inference guide](./local-inference/) for a full walkthrough.

## Per-harness notes

- **Compaction is disabled.** OpenCode's built-in compaction would defeat Lore's gradient context manager. The plugin sets `cfg.compaction = { auto: false, prune: false }` in the OpenCode config.
- **Project identity is automatic.** The plugin detects your project root (`ctx.worktree` / `ctx.directory`), walks up to find the workspace root, and injects the path + git remote as `x-lore-project` / `x-lore-git-remote` headers on every request.
- **The gateway auto-starts.** If no Lore gateway is running, the plugin starts one in-process. The gateway listens on a deterministic port (`3207` by default, falling back to `5673`) and the plugin probes for it before assuming it needs to spawn.

## Next steps

- [Architecture](../architecture/) — how temporal storage, distillation, and the gradient context manager fit together.
- [Configuration](../configuration/) — full reference for `.lore.json`.
- [Local inference](./local-inference/) — running OpenCode against Ollama, vLLM, or llama.cpp.
- [Custom upstreams](./custom-upstreams/) — corporate proxies, LiteLLM, Cloudflare AI Gateway.
