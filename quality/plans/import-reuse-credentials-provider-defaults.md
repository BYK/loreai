# Plan: `lore import` reads each harness's own on-disk credentials (all agents)

Branch: `fix/import-harness-ondisk-auth`
Issue: BYK/loreai#1398 — importing conversation history must "use existing credentials
automatically", for EVERY supported harness (OpenCode, Pi, Codex, Claude Code, Copilot,
Aider, Cline, Continue), not just OpenCode and not by borrowing a live gateway session.

## Decision (locked)

Standalone `lore import` obtains its extraction credential by reading the **harness's own
on-disk auth**, then routing the curator/extraction LLM call through the gateway to that
provider's upstream. No running `lore run` gateway required, no `LORE_WORKER_API_KEY`
required. `LORE_WORKER_API_KEY` remains as an explicit override; a live-gateway borrow is
NOT part of this change.

## Why a credential is still needed at all

Reading conversation history is already credential-free — every `AgentHistoryProvider`
(`import/providers/*.ts`) reads local SQLite/JSONL and emits plain-text `ConversationChunk`s.
The credential is only for the **extraction** step: `extractKnowledge()` (`import/extract.ts`)
feeds chunks to the curator LLM to distill durable knowledge. Raw chat logs can't become
structured knowledge without a model, so the fix is to make that model's credential come
from the harness the user already authenticated — automatically.

## What each harness stores (confirmed on this machine)

| Harness      | Auth file                                        | Shape (per provider)                                              |
|--------------|--------------------------------------------------|-------------------------------------------------------------------|
| OpenCode     | `~/.local/share/opencode/auth.json`              | `{ "<provider>": {type:"api", key} }` OR `{type:"oauth", refresh, access, expires, accountId} }` |
| Claude Code  | `~/.claude/.credentials.json`                    | `{ claudeAiOauth: { accessToken, refreshToken, expiresAt, ... } }` |
| Codex        | `~/.codex/auth.json` (OpenAI OAuth; may be empty)| OpenAI OAuth; session JSONL meta also carries `model_provider`     |
| Copilot      | GitHub token → Copilot token exchange (no static file usable directly) | out of reach as a static key — see "Copilot" below |
| Pi / Aider / Cline / Continue | agent-specific | to be surveyed during impl |

`XDG_DATA_HOME`/`XDG_CONFIG_HOME` must be honored (OpenCode provider already does for its DB).

Two credential kinds:
- **api-key** (OpenCode `type:"api"`, e.g. minimax/nvidia/openrouter/anthropic key): directly
  usable as `AuthCredential { scheme:"api-key", value:key }`.
- **oauth** (OpenCode `type:"oauth"` access token, Claude `accessToken`): usable as
  `AuthCredential { scheme:"bearer", value:access }` **while unexpired** (`expires`/`expiresAt`).
  If expired we do NOT implement each harness's refresh dance in v1 — we skip that provider and
  fall through (see "Expiry handling").

## Architecture — an `AgentAuthProvider` capability

Mirror the existing per-harness `AgentHistoryProvider` registry. Add an optional auth-reading
capability so each harness owns both "how to read my history" and "how to read my creds".

```ts
// import/types.ts
export interface AgentResolvedAuth {
  credential: { scheme: "api-key" | "bearer"; value: string };
  providerID: string;           // e.g. "anthropic", "openai", "minimax", "openrouter"
  modelID?: string;             // optional hint; else defaultModelForProvider(providerID)
  expiresAt?: number;           // epoch ms; undefined = non-expiring api-key
}

export interface AgentAuthProvider {
  readonly name: string;        // matches AgentHistoryProvider.name
  /** Read the harness's own stored credentials. Returns [] if none/unreadable.
   *  Ordered best-first (e.g. the provider the harness is currently set to use). */
  readAuth(): AgentResolvedAuth[];
}
```

- Put readers under `import/auth/<harness>.ts`, registered alongside the history providers so
  `name` keys line up. Core stays runtime-agnostic (Node + Bun): read files with `node:fs`,
  parse JSON, honor XDG envs, never throw (return `[]` on any error — same discipline as
  `openDB()` returning null in `providers/opencode.ts`).
- Keep the `AuthCredential` type + scheme mapping consistent with gateway `auth.ts`
  (`workerKeyScheme`): api-key → `x-api-key`, bearer → `Authorization: Bearer`.

## Wiring into `commandImport` (`cli/import.ts`)

Replace the `LORE_WORKER_API_KEY`-only credential resolution (`import.ts:678-704`) and the
hardcoded `anthropic` default (`import.ts:666-669`) with this chain, evaluated per detected
agent (each agent knows its own creds):

1. `LORE_WORKER_API_KEY` set → keep today's behavior (explicit override wins), but derive the
   provider from `cfg.model?.providerID` when present rather than assuming anthropic.
2. Else, for the agent(s) being imported, call its `AgentAuthProvider.readAuth()`; pick the
   first credential whose provider Lore can route (must exist in `PROVIDER_ROUTES`,
   `config.ts:527`) and that is unexpired.
   - `providerID` → upstream via `X-Lore-Provider` (the extraction LLM client already forwards
     provider/model to the gateway; confirm `createGatewayLLMClient` passes provider through).
   - `modelID` → `resolvedAuth.modelID ?? defaultModelForProvider(providerID)`.
3. Else `cfg.model` explicit override.
4. Else fail loudly with the rewritten guidance (below).

Because different detected agents can have different creds, resolve auth **per agent** inside
the extraction loop (`import.ts:719`) rather than once up front — import OpenCode with OpenCode's
creds, Codex with Codex's, etc. The `getImportAuth` closure passed to `createGatewayLLMClient`
becomes agent-scoped (or we build one client per agent).

## `defaultModelForProvider` (shared, covers all harnesses)

Single source of truth built on the existing `WORKER_DEFAULTS` map (`worker-model.ts:997`):

```ts
export function defaultModelForProvider(providerID?: string): { providerID: string; modelID: string } {
  const p = providerID ?? "anthropic";
  const d = WORKER_DEFAULTS[p];
  if (d) return { providerID: d.providerID, modelID: d.modelID };
  if (p === "google" || p === "gemini") return { providerID: p, modelID: "gemini-2.5-flash" };
  return { providerID: p, modelID: "" }; // adapter/model resolution fills the blank
}
```

Also replace the 5 hardcoded `anthropic` literals (`import.ts:666`, `import-auto.ts:131`,
`api.ts:133/539/603`) with `defaultModelForProvider(...)` so the API and `lore run` auto-import
paths are consistent too. (auto-import can pass the provider from the resolved auth / session.)

## Expiry handling (v1, conservative)

- api-key creds: no expiry → always eligible.
- oauth creds: eligible only if `expiresAt`/`expires` is in the future (small skew margin).
  If the only available cred is an expired OAuth token, skip it and continue the chain. Do NOT
  implement per-harness refresh in this PR — call it out as a follow-up. Rationale: refresh flows
  are harness-owned and error-prone; a fresh `lore run` turn (or re-login in the harness) refreshes
  them naturally. The rewritten guidance tells the user this.

## Copilot

GitHub Copilot has no directly-usable static key on disk (GitHub token → Copilot token exchange,
done by the Copilot CLI at runtime — `translate/openai.ts:545-556`, `agents.ts:266-295`). v1:
Copilot's `readAuth()` returns `[]` (nothing usable standalone). For Copilot users, the honest
guidance is: run `lore run copilot` once (its live turn authenticates and lazily imports), or set
`LORE_WORKER_API_KEY` to a raw key for a provider Lore proxies. Implementing Copilot token exchange
in a standalone CLI is a separate, larger effort — note it as a follow-up.

## Rewritten failure guidance (`import.ts:693-701`)

When no credential resolves, drop the anthropic-specific text. Say:
- which harness creds we looked for and why none were usable (none found / all expired / provider
  not routable);
- recommend re-authenticating in the harness (or `lore run <agent>` once) to refresh, then re-run
  `lore import`;
- mention `LORE_WORKER_API_KEY=<raw provider key>` as the explicit fallback.

## Out of scope (follow-ups)

- Per-harness OAuth refresh (auto-renew an expired token from disk).
- Copilot standalone token exchange.
- Live-gateway credential borrow (explicitly rejected for this change).

## Tests (mutation-verified, per quality/REVIEW.md)

Core (`@loreai/core`), runnable under Vitest with a temp HOME/XDG:
1. Each `AgentAuthProvider.readAuth()`: given a fixture auth file, returns the expected
   `{credential, providerID, modelID?, expiresAt?}`; missing/garbage file → `[]` (no throw).
   Mutation: make the parser return anthropic-hardcoded → RED.
2. Expiry filter: expired OAuth is skipped, unexpired kept, api-key always kept.
   Mutation: drop the expiry check → RED.
3. `defaultModelForProvider`: table over anthropic/openai/openai-codex/github-copilot/
   google+gemini/unknown. Mutation: revert a branch to anthropic → RED.

Gateway (`vitest run` from repo root — gateway has no `test` script, see .lore.md gotcha):
4. `commandImport` credential chain precedence: worker-key > harness-auth > cfg.model >
   fail; and per-agent auth selection (OpenCode agent uses OpenCode creds). Stub `readAuth`
   + a fake extraction client asserting the provider/model/scheme actually used.
   Mutation: force single up-front auth (ignore per-agent) → the mixed-agent test RED.
5. Provider routability filter: a harness cred for a provider absent from `PROVIDER_ROUTES`
   is skipped. Mutation: drop the filter → RED (would try to route an unroutable provider).
6. Guidance copy: no usable cred → message names the harness/expired reason, recommends
   re-auth + `LORE_WORKER_API_KEY` fallback, and does NOT assert an anthropic key.

## Verification

- `node_modules/.bin/vitest run <touched test files>` (confirm real pass counts).
- `pnpm run typecheck && pnpm run lint && pnpm run format:check`.
- Manual: on a box with OpenCode `auth.json` holding an api-key provider (e.g. openrouter),
  `lore import` (no key, no gateway) extracts knowledge with zero `protocol-mismatch`.
