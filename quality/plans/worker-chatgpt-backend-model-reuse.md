# Plan: worker model reuse for ChatGPT-backend sessions + Luna preference for real OpenAI

Branch: `fix/worker-chatgpt-backend-model-reuse`
Scope: `packages/gateway/src/worker-model.ts` (+ tests). Two behaviors in one PR.

## Root cause recap (confirmed in code)

- `getWorkerModel(session?)` — `worker-model.ts:1070` — takes only `{ providerID?, model? }`.
  It never sees the upstream URL, so it cannot tell a **ChatGPT-backend** session
  (`url = https://chatgpt.com/backend-api`, `providerID = "openai"`, `protocol = "openai-responses"`)
  from a **real api.openai.com** session (same `providerID`/`protocol`, `url = https://api.openai.com`).
  Both provider routes use `protocol: "openai-responses"` — `config.ts:578-589`.
- For the ChatGPT-backend session, `WORKER_DEFAULTS["openai"]` (family `"gpt-mini"`, `worker-model.ts:987-992`)
  fires at `worker-model.ts:1126-1143`, `resolveNewestInFamily` picks a **sibling** `gpt-5.4-mini`,
  and the worker POSTs `gpt-5.4-mini` to `chatgpt.com/backend-api`, which serves **only the session's own
  model** → **404** (observed session `1cvqnuwLYFtVqXL5`).
- The dedicated correct path (`WORKER_DEFAULTS["openai-codex"]` = `gpt-5.1-codex-mini`, family `gpt-codex`,
  `worker-model.ts:999-1004`) is only reachable when `providerID === "openai-codex"`, which only happens via
  Pi's internal ingress. A bare Codex/opencode client reaches via an upstream-URL override and keeps
  `providerID = "openai"`.
- **Cross-provider guard does NOT catch this.** `pipeline.ts:2531` only re-resolves when
  `modelProvider !== upstreamProvider`. Here both are `"openai"` → guard is a no-op. The 404 is
  contained only by `markWorkerPaused` (no `markAuthStale` — that fires on 401/403 only), so it silently
  degrades memory quality rather than erroring loudly. **Confirmed: no existing code prevents this.**

## The only robust discriminator

The upstream **host**. `UpstreamSnapshot` (`translate/types.ts:429-440`) already carries `.url`, `.protocol`,
`.providerID`, `.headers` — but `getWorkerModel`'s param type omits `url`. Every real call site already
passes the whole snapshot object (`state.lastUpstream` / `sessionState.lastUpstream` / `sessionUpstream`),
so widening the param to read `url` is **zero-cost at call sites** — TypeScript excess-property is only
checked on object literals, and these are all variables of type `UpstreamSnapshot`.

Call sites (all pass the snapshot; `url` flows in for free):
- `pipeline.ts:2532` `getWorkerModel(state.lastUpstream)`
- `pipeline.ts:5524`, `:5545`, `:5596`, `:5735` `getWorkerModel(sessionState.lastUpstream)`
- `pipeline.ts:5872` `getWorkerModel(sessionUpstream)` (destructured `UpstreamSnapshot`, `pipeline.ts:5860`)
- `pipeline.ts:9147` `getWorkerModel(state.lastUpstream)`
- `idle.ts:664`, `:1020` `getWorkerModel(state.lastUpstream)`
- `cache-warmer.ts:1538` `getWorkerModel(state.lastUpstream)`
- `cost-tracker.ts:1178` `getWorkerModel()` — **no arg**; `url` is `undefined` → fail-safe branch below.

---

## Part 1 — Correctness: reuse the session's own model for ChatGPT-backend sessions

### 1a. Widen the param type + add a tiny helper

In `worker-model.ts`, place the helper just above `getWorkerModel` (~line 1060):

```ts
/**
 * ChatGPT's `/backend-api/codex/responses` endpoint serves ONLY the session's
 * own model — sending any sibling model id there returns 404. A ChatGPT-backend
 * (Codex/OAuth) session is indistinguishable from a real api.openai.com session
 * by providerID/protocol alone (both report providerID "openai",
 * protocol "openai-responses"); the upstream URL host is the only reliable
 * discriminator. Match on host === "chatgpt.com" OR a "/backend-api" path so
 * both the static `openai-codex` route and a bare-client upstream-URL override
 * are covered.
 */
function isChatGPTBackend(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (u.hostname === "chatgpt.com" || u.hostname.endsWith(".chatgpt.com")) {
      return true;
    }
    return u.pathname.includes("/backend-api");
  } catch {
    // Non-absolute / malformed url string — fall back to substring checks so a
    // bare "chatgpt.com/backend-api" (no scheme) is still caught.
    return url.includes("chatgpt.com") || url.includes("/backend-api");
  }
}
```

Widen the signature (`worker-model.ts:1070-1074`):

```ts
export function getWorkerModel(session?: {
  providerID?: string;
  /** Session model ID (UpstreamSnapshot uses `model`, callers may use `modelID`). */
  model?: string;
  /** Upstream base URL (UpstreamSnapshot.url) — used to detect endpoints that
   *  serve only the session's own model (ChatGPT backend). Optional/back-compat. */
  url?: string;
}): { providerID: string; modelID: string } | undefined {
```

### 1b. Short-circuit branch

Place it AFTER the env override and AFTER `effectiveProvider`/`effectiveModelID` are computed, BEFORE the
cost-aware block at `worker-model.ts:1114`. Insert immediately after line 1112 (`const effectiveModelID = ...`):

```ts
// ChatGPT-backend endpoints (chatgpt.com/backend-api) serve ONLY the session's
// own model — a sibling worker model (e.g. gpt-5.4-mini) 404s there. Force the
// worker to reuse the session's own model. This must win over the cost-aware
// downgrade and even over a configured workerModel, because the endpoint
// PHYSICALLY cannot serve a different model — a mismatched override is a
// guaranteed 404, not a preference. The `openai-codex` providerID is EXEMPT:
// its /codex/responses endpoint DOES serve the validated cheaper codex-mini
// (WORKER_DEFAULTS["openai-codex"]), so keep that downgrade. An explicit env
// LORE_WORKER_MODEL is the sole escape hatch (handled above) for operators who
// deliberately repoint ALL workers to a separate provider/upstream.
if (
  isChatGPTBackend(session?.url) &&
  session?.providerID !== "openai-codex" &&
  effectiveProvider &&
  effectiveModelID
) {
  return { providerID: effectiveProvider, modelID: effectiveModelID };
}
```

**Design decision (stated tradeoff):** we intentionally ignore `cfg.workerModel` here for the
`providerID === "openai"` + chatgpt.com case. Rationale: the endpoint can only serve the session's own
model, so honoring a config override would re-introduce the exact 404. The `LORE_WORKER_MODEL` env override
still short-circuits earlier (`worker-model.ts:1079-1090`) for operators who route ALL workers to a separate
upstream — that path sends elsewhere entirely, so it is safe. **Recommendation: force session model, keep
env as the only escape hatch, and exempt the validated `openai-codex` providerID path.**

Note: `effectiveProvider` = `cfg.model?.providerID ?? sessionProviderID`; `effectiveModelID` =
`cfg.model?.modelID ?? sessionModelID`. For the failing session both come from the snapshot
(`openai` / `gpt-5.6-sol`), so we reuse `gpt-5.6-sol` — exactly the fix.

---

## Part 2 — Preference: prefer `gpt-5.6-luna` for real api.openai.com sessions

### Current behavior for a premium OpenAI session (e.g. `gpt-5.6-sol`, $5/M)

`WORKER_DEFAULTS["openai"]` family `"gpt-mini"` → `resolveNewestInFamily("openai", "gpt-mini", isCheapVariant, 5)`
→ newest **mini** (e.g. `gpt-5.4-mini`, $0.75/M). Cheap and working, but it is the *cheapest* tier, not the
"closest cheaper tier" quality-up that PR #1407 established for the generic path
(`findCheaperSameProviderModel`, `worker-model.ts:702-856`). Luna ($1/$6) is a **mid-tier** — strictly
cheaper than sol/terra but higher quality than mini.

### Cleanest data-driven approach — reuse the lineage path, drop the family pin

`findCheaperSameProviderModel` (`worker-model.ts:702-796`) ALREADY implements exactly what we want: it groups
same-lineage siblings (`lineageKey` = family up to first `-`, so `gpt-mini`, `gpt`, `gpt-codex` all share
lineage `"gpt"` — `worker-model.ts:653-656`) cheaper than the session and picks the **closest cheaper tier**
(max tier cost still `< session`). For a `gpt-5.6-sol` ($5) session with candidates `gpt-5.6-luna` ($1),
`gpt-5.4-mini` ($0.75), it picks **luna** (higher tier cost, still < $5). Zero hardcoding.

The problem: `getWorkerModel` sends `"openai"` down the `WORKER_DEFAULTS` (family-pin) branch
(`worker-model.ts:1126-1143`) and only falls into `findCheaperSameProviderModel` when there is **no**
`WORKER_DEFAULTS` entry (`worker-model.ts:1148`). The mini pin pre-empts the lineage logic.

**Recommended edit** — make the `openai` known-provider branch prefer the lineage-aware "closest cheaper
tier", falling back to the mini family pin only when lineage yields nothing. Change the branch at
`worker-model.ts:1125-1143`:

```ts
} else {
  const mapping = WORKER_DEFAULTS[effectiveProvider];
  if (mapping && !mapping.alreadyCheap(effectiveModelID)) {
    // For real OpenAI (api.openai.com), prefer the lineage-aware "closest
    // cheaper tier" (PR #1407 semantics) so a premium session (gpt-5.6-sol
    // $5) downgrades to the mid-tier gpt-5.6-luna ($1) rather than all the
    // way to the cheapest mini — higher distillation quality, still strictly
    // cheaper. Falls back to the family-pin newest-mini when the lineage set
    // is empty (cold cache / no cheaper same-lineage sibling). Never reached
    // for a chatgpt.com session (Part 1 short-circuits before this).
    const lineagePick =
      effectiveProvider === "openai" && cachedModelData
        ? findCheaperSameProviderModel(
            effectiveProvider,
            effectiveModelID,
            inputCost,
          )
        : undefined;

    const newest =
      lineagePick ??
      (mapping.family
        ? resolveNewestInFamily(
            mapping.providerID,
            mapping.family,
            mapping.alreadyCheap,
            inputCost,
          )
        : undefined);

    costAwareDefault = {
      providerID: mapping.providerID,
      modelID: newest ?? mapping.modelID,
    };
  }
  // ... existing unknown-provider findCheaperSameProviderModel block unchanged ...
}
```

Why this is correct and safe:
- **Strictly cheaper:** `findCheaperSameProviderModel` only returns candidates with
  `cost.input < sessionInputCost` (`worker-model.ts:737`), so luna ($1) is chosen only when the session is
  pricier than $1 (sol $5, terra $2.5 qualify; a luna session would not downgrade to itself).
- **Data-driven, no fragile pin:** luna selected purely from models.dev family/tier data. No literal
  `"gpt-5.6-luna"` string in source.
- **Codex-caveat isolation:** `findCheaperSameProviderModel` includes full `gpt` tiers (luna). That is
  intended for **real openai** (endpoint serves any model). It never runs for the ChatGPT backend because
  Part 1 short-circuits first.
- **`alreadyCheap` gate still applies:** a mini/nano session hits
  `mapping.alreadyCheap(effectiveModelID) === true` → no downgrade (unchanged, `worker-model.ts:1127`).

**Alternative considered & rejected:** a second `WORKER_DEFAULTS` "gpt"/"gpt-luna" family pin — re-introduces
a hardcoded tier string and can't express "closest cheaper tier". Rejected in favor of the lineage path.

> Implementer must verify against live models.dev: confirm luna's `family` yields lineageKey `"gpt"` (family
> `"gpt"` or `"gpt-luna"` both → `"gpt"`) and that sol/terra share it. If luna's lineage key differs from the
> session model's, the lineage path won't select it — then fall back to a narrow `WORKER_DEFAULTS` tweak. Seed
> tests with the confirmed real family strings.

---

## Part 3 — Compilation / call-site audit

- Widened param is **optional** (`url?`) → `getWorkerModel()` (cost-tracker.ts:1178, no arg) still compiles;
  `session?.url === undefined` → `isChatGPTBackend(undefined) === false` → unchanged behavior.
- All snapshot-passing sites hand a full `UpstreamSnapshot`; `.url` is required on that type (`types.ts:431`),
  so `url` is supplied automatically with no edits.
- No production site passes a hand-built `{ providerID, model }` literal (only tests do — fine; adding an
  OPTIONAL field never triggers excess-property errors).
- `pipeline.ts:2532` re-resolve inside the cross-provider guard also benefits (passes `state.lastUpstream`).

---

## Part 4 — Test plan (`packages/gateway/test/worker-model.test.ts`)

Use the existing `warmCache(rawModelsDevResponse)` seam (`worker-model.test.ts:1174-1180`): it mocks
`globalThis.fetch` to return raw models.dev JSON and calls `fetchModelData()`, populating `cachedModelData`,
`cachedModelDataByProvider`, `cachedProviderModels`, and `cachedProviderRoutes`. The family/lineage functions
need `cachedProviderModels`, which `_setModelDataForTest` does NOT populate — so **use `warmCache`** (mirror
the existing family-path `describe` at ~line 1171 with its `LIMIT` const and beforeEach/afterEach reset).

Seed a realistic OpenAI family set per new describe block (adjust `family` to real values once confirmed):

```ts
openai: {
  api: "https://api.openai.com/v1",
  models: {
    "gpt-5.6-sol":   { id: "gpt-5.6-sol",   family: "gpt",      release_date: "2026-06-01", cost: { input: 5,    output: 30,  cache_read: 1.25 }, limit: LIMIT },
    "gpt-5.6-terra": { id: "gpt-5.6-terra", family: "gpt",      release_date: "2026-06-01", cost: { input: 2.5,  output: 15,  cache_read: 0.6  }, limit: LIMIT },
    "gpt-5.6-luna":  { id: "gpt-5.6-luna",  family: "gpt",      release_date: "2026-06-01", cost: { input: 1,    output: 6,   cache_read: 0.25 }, limit: LIMIT },
    "gpt-5.4-mini":  { id: "gpt-5.4-mini",  family: "gpt-mini", release_date: "2026-04-01", cost: { input: 0.75, output: 4.5, cache_read: 0.19 }, limit: LIMIT },
  },
},
```

### (a) ChatGPT-backend session reuses its own model (Part 1)
```ts
const result = getWorkerModel({
  providerID: "openai",
  model: "gpt-5.6-sol",
  url: "https://chatgpt.com/backend-api",
});
expect(result).toEqual({ providerID: "openai", modelID: "gpt-5.6-sol" }); // NOT gpt-5.4-mini, NOT luna
```
Add variants: `url: "https://chatgpt.com/backend-api/codex/responses"` and scheme-less
`"chatgpt.com/backend-api"` to exercise the `catch` fallback in `isChatGPTBackend`.

### (b) Real api.openai.com premium session prefers luna (Part 2)
```ts
const result = getWorkerModel({
  providerID: "openai",
  model: "gpt-5.6-sol",
  url: "https://api.openai.com",
});
expect(result?.modelID).toBe("gpt-5.6-luna"); // closest cheaper tier, NOT mini
```

### (c) Regression: `openai-codex` providerID path unchanged
- Keep the existing codex family test (`worker-model.test.ts:1236-1304`) asserting `gpt-5.x-codex-mini`.
- Add a test: `providerID: "openai-codex"`, `url: "https://chatgpt.com/backend-api"`, premium codex session →
  still resolves the codex-**mini** (NOT reuse of the full session model), proving the `openai-codex` EXEMPTION
  in the Part 1 guard. This is correct: that endpoint DOES serve the mini (per `worker-model.ts:993-998`).

### (d) `alreadyCheap` session → no downgrade
```ts
const result = getWorkerModel({
  providerID: "openai",
  model: "gpt-5.4-mini",
  url: "https://api.openai.com",
});
expect(result?.modelID).toBe("gpt-5.4-mini"); // unchanged
```

### Mutation checks (prove non-vacuous — run each in a throwaway `/tmp/opencode` copy, NEVER the real tree)
- **M1:** delete the Part 1 short-circuit → test (a) RED ("gpt-5.4-mini" instead of "gpt-5.6-sol").
- **M2:** `isChatGPTBackend` → `return false` always → test (a) RED, (b) still GREEN.
- **M3:** remove the `lineagePick ??` preference → test (b) RED ("gpt-5.4-mini" instead of luna).
- **M4:** drop the `providerID !== "openai-codex"` clause → test (c) codex-exemption RED (reuses full model).
- **M5:** revert `url` widening → typecheck confirms cost-tracker no-arg call still compiles / other sites OK.

---

## Part 5 — Risks & edge cases

1. **Missing/empty `url`** (cost-tracker no-arg, cold snapshot): `isChatGPTBackend` false → old behavior.
   **Fail-safe = old behavior**, not forced reuse. Correct: without a URL we can't prove single-model, and the
   cost-tracker call is estimation-only (never dispatches a real worker).
2. **`openai` default url is `api.openai.com`** (config.ts:579): real-key snapshot url → `isChatGPTBackend`
   false → Part 2 luna preference applies. Correct.
3. **Anthropic subscription / Claude Code OAuth (`api.anthropic.com`)**: NOT single-model — the OAuth token
   reaches opus/sonnet/haiku, and the sonnet worker downgrade is validated & desired. **No anthropic
   equivalent needs Part 1.** The only single-model endpoint in `PROVIDER_ROUTES` is `openai-codex` →
   `chatgpt.com/backend-api` (config.ts:586-589). `isClaudeCodeOAuthSession` (cch.ts:554) gates Anthropic
   OAuth behavior, but the endpoint itself is general-purpose.
4. **Other bearer/backend-only providers**: none in `PROVIDER_ROUTES` currently share "serves only one model".
   If one is added later, generalize `isChatGPTBackend` into a small `SINGLE_MODEL_ENDPOINTS` allowlist —
   future extension, not needed now.
5. **`X-Lore-Upstream-URL` override to chatgpt.com with a real openai key**: unlikely and still correct — that
   endpoint serves only the session model regardless of key, so reuse is right.
6. **Luna lineage assumption**: if models.dev groups luna under a lineage key different from the session
   model's, Part 2 won't pick it — verify family strings live; fall back to a narrow `WORKER_DEFAULTS` tweak if
   needed. Part 1 is unaffected by this.
7. **Memoization**: `findCheaperSameProviderModel` memoizes by `provider\x1fsessionModel\x1fcost`
   (`worker-model.ts:711`) and is invalidated on snapshot/blocklist change — so switching the openai branch to
   use it does not re-emit duplicate log lines per idle tick (memo already covers it).

---

## Implementation order

1. Add `isChatGPTBackend` helper + widen `getWorkerModel` param type (Part 1a).
2. Add the Part 1b short-circuit (with `openai-codex` exemption).
3. Add the Part 2 openai lineage-preference edit.
4. Add tests (a)-(d) via `warmCache`; run `pnpm test` on the file, then full suite.
5. Mutation-verify M1-M5 in `/tmp/opencode` copies (never mutate the real tree; sha256 before/after).
6. `pnpm run typecheck && pnpm run lint && pnpm run format:check`.
7. Adversarial background review per `quality/REVIEW.md` before merge.
