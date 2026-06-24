---
title: Pi with Lore
description: Set up Lore as a Pi extension and route every LLM call through the memory gateway.
sidebar:
  order: 2
---

[Pi](https://github.com/badlogic/pi-mono) is a terminal-based AI coding agent. The `@loreai/pi` extension loads inside Pi and routes every LLM call through the Lore gateway.

## Install

Add the extension to your `~/.pi/settings.json`:

```json
{
  "packages": [
    "npm:@loreai/pi@latest"
  ]
}
```

Then run `pi install` once. The extension auto-loads on every Pi session.

## What you get

Once the extension is loaded, every conversation is captured in Lore's three-tier memory. Distillations run in the background, the recall tool is available, and your project knowledge is exported to `.lore.md` and `AGENTS.md` automatically. See the [architecture overview](/docs/architecture/) for the full picture.

## Local embeddings

Recall uses `@huggingface/transformers` with `nomic-embed-text-v1.5` (768-dim INT8 quantized, ~137 MB) for on-device vector search by default — no API key required. The model downloads on first use and is cached locally.

If local embeddings fail (for example, CUDA 13 on Linux/x64 with `onnxruntime-node`), set `VOYAGE_API_KEY` or `OPENAI_API_KEY` in your environment and recall transparently switches to that provider. You can also pin a hosted provider explicitly in `.lore.json`:

```json
{ "search": { "embeddings": { "provider": "voyage" } } }
```

If none of the above apply, recall falls back to FTS-only search.

## Pointing Pi at a local LLM server

The Pi plugin reads `LORE_UPSTREAM_<PROVIDER>` from your environment and injects it as the `x-lore-upstream-url` header on each request. Set the env var for the provider you want:

```bash
export LORE_UPSTREAM_VLLM=http://localhost:8000
# or
export LORE_UPSTREAM_OLLAMA=http://localhost:11434
# or
export LORE_UPSTREAM_LLAMACPP=http://localhost:8080
# or
export LORE_UPSTREAM_LMSTUDIO=http://localhost:1234
# or
export LORE_UPSTREAM_TGI=http://localhost:8080
# or
export LORE_UPSTREAM_LITELLM=http://localhost:4000
```

The URL is the server root — do not include `/v1` (the gateway appends API paths automatically). See the [local inference guide](/docs/guides/local-inference/) for a full walkthrough.

## Per-harness notes

- **Compaction is intercepted.** Pi's compaction goes through its extension API rather than HTTP. The Pi extension calls the gateway's `POST /v1/compact` endpoint to get a full LLM-synthesized compaction summary (force-distill + knowledge + compact prompt).
- **Provider headers are auto-injected.** The extension's `registerProviders()` walks the configured providers and sets the gateway base URL, `x-lore-session-id`, `x-lore-project`, and `x-lore-git-remote` headers on each request.
- **`LORE_GATEWAY_URL` overrides auto-detection.** If the gateway is on a non-default host or port, set `LORE_GATEWAY_URL` in your environment before launching Pi.

## Next steps

- [Architecture](/docs/architecture/) — how temporal storage, distillation, and the gradient context manager fit together.
- [Configuration](/docs/configuration/) — full reference for `.lore.json`.
- [Local inference](/docs/guides/local-inference/) — running Pi against Ollama, vLLM, or llama.cpp.
- [Custom upstreams](/docs/guides/custom-upstreams/) — corporate proxies, LiteLLM, Cloudflare AI Gateway.
