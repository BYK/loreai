---
title: Local inference with Lore
description: Run Lore against Ollama, vLLM, llama.cpp, LM Studio, or any OpenAI-compatible local server.
sidebar:
  order: 6
---

This guide is for the privacy-maximalist / tinkerer path. If you'd rather not have your conversations touch a third-party API — or you just want to experiment with smaller open-weight models — Lore can run against any OpenAI-compatible local server.

Lore's gateway already runs locally. Your database lives at `~/.local/share/lore/lore.db` and never leaves your machine. With a local LLM server, even the distillation and curation calls stay on your hardware. There is no external API key required and no telemetry.

## Server setup

Pick a server. All of these speak the OpenAI Chat Completions protocol and work with Lore out of the box.

### Ollama

[Ollama](https://ollama.com) is the easiest single-binary option. Install it and pull a model:

```bash
# Install from https://ollama.com/download
ollama pull qwen2.5-coder:14b
ollama serve
```

The server listens on `http://127.0.0.1:11434`. Move on to [pointing Lore at it](#pointing-lore-at-your-local-server).

### vLLM

[vLLM](https://docs.vllm.ai) is a high-throughput serving engine for Hugging Face models. It runs on a single GPU and exposes an OpenAI-compatible server:

```bash
pip install vllm
vllm serve Qwen/Qwen2.5-Coder-14B-Instruct --port 8000
```

The server listens on `http://127.0.0.1:8000`.

### llama.cpp

[llama.cpp](https://github.com/ggerganov/llama.cpp) is a CPU-first inference engine that also runs on Apple Silicon and CUDA. The server binary exposes an OpenAI-compatible API:

```bash
llama-server -m model.gguf --port 8080
```

The server listens on `http://127.0.0.1:8080`.

### LM Studio

[LM Studio](https://lmstudio.ai) is a desktop app with a built-in OpenAI-compatible server. Open the app, load a model, click the "Local Server" tab, and start the server. The default port is `1234`.

### TGI and LiteLLM

If you already use [Text Generation Inference](https://huggingface.co/docs/text-generation-inference) or [LiteLLM](https://github.com/BerriAI/litellm) as a unified proxy in front of multiple model backends, point Lore at them the same way. Both expose the OpenAI Chat Completions protocol.

## Pointing Lore at your local server

Lore resolves the upstream URL by provider ID. Set the env var for the provider you started:

```bash
export LORE_UPSTREAM_OLLAMA=http://localhost:11434
# or
export LORE_UPSTREAM_VLLM=http://localhost:8000
# or
export LORE_UPSTREAM_LLAMACPP=http://localhost:8080
# or
export LORE_UPSTREAM_LMSTUDIO=http://localhost:1234
# or
export LORE_UPSTREAM_TGI=http://localhost:8080
# or
export LORE_UPSTREAM_LITELLM=http://localhost:4000
```

The Pi plugin reads these and injects the URL as `x-lore-upstream-url` on each request. The OpenCode plugin does the same. Then launch your harness through Lore:

```bash
lore run
```

The gateway talks to your local server on the harness's behalf, with no external dependencies.

## Embeddings are local by default

Recall uses `@huggingface/transformers` with `nomic-embed-text-v1.5` (768-dim INT8 quantized, ~137 MB) for on-device vector search by default — no API key required. The model downloads on first use and is cached locally.

If local embeddings fail (CUDA 13 on Linux/x64 with `onnxruntime-node` is a known case — [microsoft/onnxruntime#26586](https://github.com/microsoft/onnxruntime/discussions/26586)), set `VOYAGE_API_KEY` or `OPENAI_API_KEY` in your environment and recall transparently switches to that provider. You can also pin a hosted provider explicitly in `.lore.json`:

```json
{ "search": { "embeddings": { "provider": "voyage" } } }
```

## Quality: small models and Lore's worker pipeline

This is the honest part. Lore runs three LLM-driven pipelines in the background:

1. **Distillation** — turns raw conversation history into observation logs.
2. **Curation** — extracts durable long-term knowledge (decisions, patterns, preferences) into the knowledge base and `.lore.md`.
3. **Query expansion** — generates 2-3 alternative phrasings of a recall query for better search.

Small local models are perfectly fine for distillation. A 7B-class instruct model with Q4 or Q5 quantization produces usable observation logs, especially for code-heavy sessions.

Curation is more sensitive to model quality. The curator needs to read the conversation, decide which facts are durable, and write them in a structured form. A 7B model produces noticeably worse `.lore.md` entries — duplicates, wrong categories, lower-confidence assertions. **32B or higher (Q4 or better)** is the practical floor for full feature parity with cloud models.

If your local model isn't up to curation, disable it:

```json
{
  "curator": {
    "enabled": false
  }
}
```

The rest of Lore (temporal storage, distillation, gradient context management, recall, AGENTS.md sync) keeps working.

## Recommended starting configs

A typical 14B-class setup with one harness:

```json
{
  "model": {
    "providerID": "ollama",
    "modelID": "qwen2.5-coder:14b"
  },
  "workerModel": {
    "providerID": "ollama",
    "modelID": "qwen2.5-coder:14b"
  },
  "curator": {
    "enabled": false
  }
}
```

A 32B+ setup with a hosted model for curation only:

```json
{
  "model": {
    "providerID": "ollama",
    "modelID": "qwen2.5-coder:32b"
  },
  "workerModel": {
    "providerID": "anthropic",
    "modelID": "claude-3-5-haiku-latest"
  },
  "curator": {
    "enabled": true
  }
}
```

Use `LORE_WORKER_API_KEY` and `LORE_WORKER_UPSTREAM` to point workers at a different (potentially cloud) provider.

## What we're evaluating: Gemma 4 E4B

Google's [Gemma 4 E4B](https://blog.google/technology/developers/gemma-4/) (released June 5, 2026) is a 4B-effective-parameter model built on a MatFormer / PLE architecture. Apache 2.0, runs on modest hardware, and is the most promising small-model candidate we've seen for Lore's worker pipeline.

We are actively evaluating Gemma 4 E4B Q8_0 as a worker-model candidate for budget-conscious self-hosted setups. Early experiments are promising for distillation (clean observation logs, no repetition) but the curator still needs work — Q8 quantization doesn't recover enough long-context fidelity for the structured knowledge extraction step.

There is one quality gotcha worth knowing about: the model's `repetition_penalty=1.0` default produces doubled commas (`,,`) and repetition loops at `temperature=0`. Set `repetition_penalty=1.15` in your server config to avoid it.

Results and the evaluation harness live in `packages/core/eval/` if you'd like to reproduce them.

## Next steps

- [Configuration](/docs/configuration/) — full reference for `.lore.json`.
- [Custom upstreams](/docs/guides/custom-upstreams/) — corporate proxies, LiteLLM, Cloudflare AI Gateway.
- [Architecture](/docs/architecture/) — how temporal storage, distillation, and the gradient context manager fit together.
