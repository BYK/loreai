---
title: Custom upstreams and hosted mode
description: Point Lore at LiteLLM, Cloudflare AI Gateway, internal corporate proxies, or a remote gateway.
sidebar:
  order: 5
---

This guide is for the advanced counterpart to the per-harness setup: pointing Lore at a non-vendor upstream. Three things are configurable:

1. The upstream **URL** (where the request goes).
2. The upstream **auth** (the `Authorization` / `x-api-key` header, plus optional extra headers).
3. The gateway's own **hosted mode** (where the gateway itself runs and whether it has filesystem access to client projects).

## URL configuration

Lore's gateway resolves the upstream URL in this order, highest priority first:

1. `X-Lore-Upstream-URL` request header (explicit user override).
2. `X-Lore-Provider` request header → static `PROVIDER_ROUTES` table.
3. Model-prefix route (e.g. `claude-` → Anthropic, `gpt-` → OpenAI).
4. Config defaults: `LORE_UPSTREAM_ANTHROPIC`, `LORE_UPSTREAM_OPENAI`.

### Override the defaults per-protocol

```bash
# Route all Anthropic-protocol calls (Claude, MiniMax, Fireworks) to a custom URL
export LORE_UPSTREAM_ANTHROPIC=https://internal-llm.corp.example.com

# Route all OpenAI-protocol calls (OpenAI, Groq, xAI, DeepSeek, etc.) to a custom URL
export LORE_UPSTREAM_OPENAI=https://litellm.corp.example.com
```

The URL is the server root — do not include `/v1` (the gateway appends API paths automatically).

### Route by provider ID

Provider-specific URLs are configured with `LORE_UPSTREAM_<PROVIDER>`:

| Provider | Env var |
|---|---|
| `vllm` | `LORE_UPSTREAM_VLLM` |
| `llamacpp` | `LORE_UPSTREAM_LLAMACPP` |
| `ollama` | `LORE_UPSTREAM_OLLAMA` |
| `lmstudio` | `LORE_UPSTREAM_LMSTUDIO` |
| `tgi` | `LORE_UPSTREAM_TGI` |
| `litellm` | `LORE_UPSTREAM_LITELLM` |
| `zai` | `LORE_UPSTREAM_ZAI` |

The Pi plugin reads these and injects the URL as `x-lore-upstream-url` on each request. The OpenCode plugin does the same. Cloud providers (Anthropic, OpenAI, etc.) are routed automatically by model name and do not need this.

### Per-request override

If you need to point a single request at a different upstream, the SDK client can set the `X-Lore-Upstream-URL` header directly:

```bash
curl -X POST http://127.0.0.1:3207/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "x-lore-upstream-url: https://internal-llm.corp.example.com" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model": "claude-3-5-sonnet", "max_tokens": 1024, "messages": [{"role": "user", "content": "Hello"}]}'
```

The header is sanitized (control characters stripped, length-capped at 2048, must be http/https, no embedded credentials) before use.

## Custom auth headers

Standard `Authorization: Bearer …` or `x-api-key: …` is forwarded by the gateway automatically — these are reconstructed from the session's credential on every request. For everything else (corporate proxies, LiteLLM team-routing tokens, Cloudflare AI Gateway), set `LORE_UPSTREAM_EXTRA_HEADERS`:

```bash
# LiteLLM with team routing
export LORE_UPSTREAM_EXTRA_HEADERS="X-Team-Id: acme"

# Cloudflare AI Gateway
export LORE_UPSTREAM_EXTRA_HEADERS="cf-aig-authorization: Bearer <token>"

# Generic corporate proxy with multiple headers (newline-separated)
export LORE_UPSTREAM_EXTRA_HEADERS="X-Corp-Token: <token>
X-Tenant: acme
X-Trace-Id: $(uuidgen)"
```

The format is curl-style `Name: Value` per line, the same convention Anthropic's SDK uses for `ANTHROPIC_CUSTOM_HEADERS`. Keys are lowercased, values are trimmed, malformed lines are skipped with a warning.

Precedence (highest wins):

1. `x-api-key` / `Authorization` reconstructed by the gateway from the session credential.
2. Your `LORE_UPSTREAM_EXTRA_HEADERS` (the overlay).
3. Client-forwarded headers (everything else the SDK sent).

This means you can use `LORE_UPSTREAM_EXTRA_HEADERS` to override the session's credential for upstream calls — useful for routing worker calls to a service account, or pointing the entire session at a corporate proxy that requires a different key.

### Claude Code path

Claude Code already reads `ANTHROPIC_CUSTOM_HEADERS` natively, so you can set the same headers from the Claude Code side and they reach the upstream unchanged:

```bash
export ANTHROPIC_CUSTOM_HEADERS="X-Team-Id: acme
cf-aig-authorization: Bearer <token>"
claude
```

The gateway's `forwardClientHeaders()` pass-through preserves these on the upstream call.

### Codex path

The Codex CLI has no native "extra headers" config. The Codex agent definition in `lore run` reads `LORE_UPSTREAM_EXTRA_HEADERS` and folds the values into Codex's `openai_provider_headers` TOML map:

```toml
# Injected by `lore run` when LORE_UPSTREAM_EXTRA_HEADERS is set
openai_provider_headers = { X-Team-Id = "acme", cf-aig-authorization = "Bearer <token>" }
```

This is belt-and-suspenders with the gateway-side overlay — both hops carry the headers, which matters if you have a corporate proxy in front of the gateway too.

## Worker overrides

Background workers (distillation, curation, query expansion) can use a different credential and upstream than the session:

```bash
# Dedicated API key for workers
export LORE_WORKER_API_KEY=<service-account-key>

# Dedicated upstream URL for workers (uses the same protocol as the session)
export LORE_WORKER_UPSTREAM=https://workers.internal-llm.corp.example.com
```

Workers use the same provider as the session (cross-provider calls always fail — wrong credentials, wrong API format). If the session uses Anthropic, the workers also call Anthropic-protocol; the `LORE_WORKER_UPSTREAM` value is the URL the workers call.

### Worker cost on OpenRouter

The background worker runs on every session and is the main non-conversation cost. The biggest lever is simply to point the worker at a cheap model — distillation and curation are summarization/extraction tasks that open-weight models handle well at a fraction of a frontier model's price.

When the worker's provider is `openrouter`, Lore does this automatically: worker calls are sent with `provider: { sort: "price" }` (OpenRouter's `:floor` behavior), so each call routes to the cheapest provider serving your chosen worker model. This applies **only** to background worker calls — never the live conversation, which keeps OpenRouter's default load-balancing for reliability.

Two caveats:

- **`:floor` can land on a quantized endpoint.** The cheapest provider is sometimes serving quantized weights (FP8/FP4/INT8). For distillation and curation this is usually fine, but if knowledge quality degrades, pin a specific/higher-precision provider via your worker-model choice or a fuller model slug. See OpenRouter's [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection) for the `quantizations` and `ignore` options.
- **`:free` worker slugs are viable but rate-limited.** OpenRouter's `:free` models cost $0 in tokens (Lore treats them as free), but free endpoints are capped (~50 requests/day, or 1,000/day with $10+ in credits) and *failed* requests still count against that quota. Use `:free` for light or hobby setups, not a heavily-used worker.

## Hosted mode

Hosted mode is for running the Lore gateway as a central service that multiple clients connect to from different machines. In hosted mode, the gateway is always a **remote gateway** — it has no shared filesystem with its clients.

```bash
# Enable hosted mode
export LORE_HOSTED_MODE=1

# Or equivalently (implies hosted mode)
export LORE_REMOTE_GATEWAY=1
```

In hosted mode, the gateway disables filesystem operations that depend on client-controlled paths:

- No `git remote -v` subprocess (clients send `X-Lore-Git-Remote` via the plugin instead).
- No `.lore.json` / `.lore.md` read or write (config and knowledge live client-side).
- No `lat.md/` directory scan.
- No file watchers.

Requests that cannot resolve a confident project path are routed to a per-session synthetic "unattributed" bucket so unrelated sessions are never merged. The bucket self-heals when a confident path arrives in a later turn.

### Connecting clients to a remote gateway

Clients find the remote gateway via the same discovery chain as the local one:

```bash
# Explicit override (highest priority)
export LORE_REMOTE_URL=https://lore.corp.example.com

# Or set the same env var the local-discovery uses
export LORE_GATEWAY_URL=https://lore.corp.example.com
```

Both the OpenCode and Pi plugins probe the URL on startup.

## Gotchas

| Problem | Cause | Fix |
|---|---|---|
| Upstream URL ignored | A request-level `X-Lore-Upstream-URL` header is overriding the config | Remove the header, or rely on `LORE_UPSTREAM_<PROVIDER>` for provider-scoped URLs |
| Custom header not arriving | The header is in the gateway-managed blocklist (`x-lore-*`, `x-api-key`, `authorization`, framing headers) | Use a different header name, or remove the conflicting client-side header |
| Worker calls hitting public Anthropic | `LORE_WORKER_UPSTREAM` is unset and the session uses a non-default upstream | Set `LORE_WORKER_UPSTREAM` to the worker's URL |
| Multiple clients sharing memory unexpectedly | Hosted mode is off but sessions come from different machines | Set `LORE_HOSTED_MODE=1` on the gateway so it stops attributing to its own cwd |
| `cf-aig-authorization` 401 | Cloudflare AI Gateway expects the header at request time but the session credential is overwriting it | Confirm `LORE_UPSTREAM_EXTRA_HEADERS` is set; precedence overlay is intentional — the extras should win |

## Next steps

- [Configuration](/docs/configuration/) — full reference for `.lore.json` and related env vars.
- [Local inference](/docs/guides/local-inference/) — running Lore against Ollama, vLLM, or llama.cpp.
- [Architecture](/docs/architecture/) — how temporal storage, distillation, and the gradient context manager fit together.
