# `/api/v1` inventory for the memory browser (UI-01)

Verified against `packages/gateway/src/api.ts` at `a4e6af5b` (dispatcher
`handleAPIRequest`). The SPA in `packages/ui` is a **read projection** of this
API: the gateway's SQLite store stays authoritative, and the browser never
writes to it in UI-02. Everything below is what the UI can rely on today; gaps
are listed so later slices add opt-in behaviour rather than change existing
shapes.

## Conventions shared by every route

- **Project selector.** Routes that need a project resolve, in order: the
  `:id` route param (project UUID; anything else 404s), then `?git_remote=`,
  then `?path=` (`resolveProject`). Project-less detail routes
  (`GET /api/v1/sessions/:id`, `DELETE /api/v1/sessions/:id`) require
  `?git_remote` or `?path` and answer `400 invalid_request` without one.
- **Limits.** `?limit=N` defaults to **50** and is capped at **1000**
  (`getLimit`); non-numeric or `< 1` falls back to the default. `GET
  /api/v1/recall` uses default **10**, cap **50**. There is **no cursor,
  offset, next-page token, or `total`**: lists are "first N" only.
- **Errors.** `{ "type": "error", "error": { "type": string, "message":
  string } }` with the HTTP status. `type` values seen: `not_found`,
  `invalid_request`. Unknown routes: `404 not_found` with
  `No API route for <METHOD> <path>`.
- **Bodies.** JSON; request bodies may be `Content-Encoding: zstd|gzip|br|deflate`.
- **Authorization.** See [Management boundary](#management-boundary). No
  route carries per-user identity; there is no login, session cookie, or CSRF
  token in this surface.

## Reads (safe, idempotent — the only routes UI-02 calls)

| Route | Response | Service (today) | Limitations |
|---|---|---|---|
| `GET /api/v1/projects` | `ProjectSummary[]`: `id, path, name, git_remote, created_at, knowledge_count, session_count, message_count, distillation_count`, newest first. `knowledge_count` counts current entries with `confidence > 0.2`. | `core/data.listProjects` | No filter, no limit, no search. |
| `GET /api/v1/stats` | `data.globalStats()` aggregate object. | `core/data.globalStats` | Shape is whatever core returns; UI must validate leniently. |
| `GET /api/v1/projects/:id/knowledge` | `KnowledgeEntry[]` from `ltm.forProject(path, false)` with **`id` rewritten to `logical_id`** (stable identity across versions). Fields: `id, logical_id, tenant_id, project_id, category, title, content, source_session, cross_project, confidence, created_at, updated_at, metadata, created_by, updated_by, sensitivity, promotion_status, promoted_at, approval_status, approved_by, approved_at, source_user_id, source_entry_id, last_accessed_at, worker_provider_id, worker_model_id, last_reinforced_at`. | `core/ltm.forProject` | Current versions only; **ignores `?limit`** (returns every entry); no sort/filter parameters; embedding blob excluded. |
| `GET /api/v1/projects/:id/sessions` | `SessionSummary[]`: `session_id, message_count, first_message_at, last_message_at, distilled_count, undistilled_count, distillation_count`. | `core/data.listSessions` | `?limit` only. |
| `GET /api/v1/projects/:id/distillations` | `DistillationSummary[]`: `id, session_id, generation, token_count, r_compression, c_norm, archived, created_at, call_type`. | `core/data.listDistillations` | `?limit`, `?session=` filter; summaries only (no text). |
| `GET /api/v1/knowledge/:id` | One `KnowledgeEntry` with `id = logical_id`. Accepts a current version id, a superseded version id, an id prefix, or the logical id; resolves via `data.resolveId` → `ltm.get` → `ltm.getByLogical(ltm.logicalIdOf(...))`. 404 `Knowledge entry not found`. | `core/ltm` | Returns the **current** version only; no history. |
| `GET /api/v1/sessions/:id` | `{ messages: TemporalMessage[], distillations: DistillationSummary[] }` scoped to the selected project. | `core/temporal.bySession`, `core/data.listDistillations` | Requires `?git_remote`/`?path`; `messages` is unbounded (whole session). |
| `GET /api/v1/distillations/:id` | One distillation record (id or prefix). 404 `Distillation not found`. | `core/data.getDistillation` | — |
| `GET /api/v1/recall` | `{ query, scope, projectPath, result }`; `q` required, project selector required, `scope=all\|session\|project\|knowledge`, optional `session`, `limit` (10, cap 50). | `core/recall` | May touch embeddings/LLM config; latency varies. |
| `GET /api/v1/import/history` | `conversationImport.listImports(path)` array. | `core/conversation-import` | Project selector required. |

## Mutations (not called by UI-02; listed so the SPA never triggers them by accident)

| Route | Response | Service (today) | Notes |
|---|---|---|---|
| `DELETE /api/v1/knowledge/:id` | `{ deleted: true, id }` (resolved version id). | `core/data.deleteKnowledge` | Accepts logical/current/superseded ids. |
| `DELETE /api/v1/sessions/:id` | `data.deleteSession` result. | `core/data.deleteSession` | Requires project selector. |
| `DELETE /api/v1/distillations/:id` | `{ deleted: true, id }`. | `core/data.deleteDistillation` | — |
| `DELETE /api/v1/projects/:id` | `data.deleteProject` counts; 404 if missing. | `core/data.deleteProject` | — |
| `POST /api/v1/projects/merge` | `data.backfillGitRemotes()` result. | `core/data.backfillGitRemotes` | **Refused in hosted mode** (400). |
| `POST /api/v1/reindex` | `{ knowledge_embedded, distillations_embedded }`. | `core/embedding.backfill*` | Global, long-running. |
| `POST /api/v1/projects/:id/clear` | Per-kind counts for `{ knowledge, temporal, distillations }` flags, or full `data.clearProject()` result when the body is empty/null. | `core/data.clearProject` | Empty body = clear everything. |
| `POST /api/v1/projects/:id/dedup` | `{ project, global }` — **always a dry run.** Both `ltm.deduplicate(path, { dryRun: true })` and `ltm.deduplicateGlobal({ dryRun: true })` are called unconditionally. | `core/ltm.deduplicate*` | The source comment mentions `?apply=true`, but the handler never reads it; **there is no way to apply dedup over REST**. |
| `POST /api/v1/sessions/move` | `data.moveSessions` result (moved ids). Body: `session_ids[]`, `from_project_id`, `to_project` (`{ id \| git_remote \| path }`), optional `include_children`. | `core/data.moveSessions` | — |
| `POST /api/v1/knowledge/:id/move` | `{ moved: true, id }`. Body: `to_project`. | `core/data` / `core/ltm` | — |
| `POST /api/v1/import/extract` | `conversationImport.extractKnowledge` result. | `core/conversation-import` + LLM | Needs an available LLM. |
| `POST /api/v1/import/record` | `{ recorded: true }`. Body: `agent_name, source_id, source_hash, stats` + project selector. | `core/conversation-import` | — |
| `POST /api/v1/import/structured` | Structured import counts; validates `doc`, accepts `global`, `dry_run`. | `core/conversation-import` | **Refused in hosted mode.** |
| `POST /api/v1/entities/rebuild` | `{ dryRun, cancelled, results }`. | `core/entities` + LLM | **Refused in hosted mode**; long-running. |
| `POST /api/v1/entities/rebuild/cancel` | `{ cancelled }`. | `core/entities` | **Refused in hosted mode.** |

## Gaps the UI has to design around

| Gap | Consequence for the SPA | Owner / plan |
|---|---|---|
| **Limit-only pagination** (no cursor, offset, or totals) on every list; knowledge list has no limit at all. | UI-02 renders complete lists client-side. UI-04 tables need an opt-in cursor (`?after=`) added to the gateway, never a changed default. | UI-04 (gateway, new query option) |
| **No knowledge version-history route.** `ltm` stores superseded versions and `GET /knowledge/:id` resolves them, but nothing lists them. | Detail view shows the current version only; "history" is a disabled affordance. | Proposed: `GET /api/v1/knowledge/:id/versions` (new route) |
| **Dedup is dry-run only** over REST despite the `?apply=true` comment. | Dedup review can preview but never apply from the browser. | Proposed: explicit `apply` body flag + hosted-mode refusal (UI-08 parity) |
| **No REST for auth, sync, team, or management settings.** These live in gateway config/env, CLI (`lore data …`), and the sync module. | Connection status is inferred from `GET /api/v1/projects` (reachable / unreachable / 404-hidden). Team review, sync status and settings screens have no backend. | Proposed services, see below |
| **No search route besides recall.** | Global search is a UI-04 placeholder in UI-02. | UI-04 |
| **No per-user identity in responses** (`created_by` etc. are stored but no caller identity exists). | Discussions/notes stay local (IndexedDB) until a durable service exists. | Later slices |

## Service ownership

"Service" is where the behaviour lives today; **proposed** rows do not exist
and must not be assumed by the SPA.

| Concern | Today | Status |
|---|---|---|
| Knowledge / project / session **reads** | `packages/core` (`data`, `ltm`, `temporal`) via `packages/gateway/src/api.ts` | exists |
| Knowledge **edits** (create/update) | `core/ltm.create/update` — CLI + curator only; **no REST route** | proposed (opt-in write routes, hosted-mode refusals) |
| Knowledge **move / delete** | `POST /knowledge/:id/move`, `DELETE /knowledge/:id` | exists (mutation; not used by UI-02) |
| **Dedup** | `POST /projects/:id/dedup` (dry-run only) | exists, apply path proposed |
| **Version history** | `core/ltm` versions (internal) | route proposed |
| **Team review / approval** | `approval_status`, `promotion_status` columns; sync module | proposed |
| **Auth / sync status** | gateway config (`LORE_GATEWAY_AUTH_TOKEN`, `LORE_REMOTE_*`), sync module; no REST | proposed |
| **Management settings** | env vars / `.lore.json` | proposed |
| **Contradiction resolution** | legacy `ui.ts` (moved to a non-UI gateway module in UI-02; no route) | exists as logic, route deferred |

## Management boundary

The SPA must not weaken any of this; UI-02 serves `/ui` behind the same checks.

- `/`, `/api`, `/api/*`, `/ui`, `/ui/*` are **management** paths. The gateway
  authorises them from the **actual socket peer address** before CORS
  preflight, lazy imports, body reads, or storage work. `Host`, `Origin`,
  `Forwarded`, `X-Forwarded-For` and friends are never trusted for this.
- A **non-loopback peer** gets a bodyless `404` (with `Connection: close`) for
  every management path unless `LORE_ALLOW_REMOTE_MANAGEMENT=1`. Hidden, not
  "forbidden": the surface must not be discoverable.
- **Origin checks.** Loopback peers may send loopback origins only. With remote
  management enabled, a non-loopback `Origin` must match the request `Host`
  exactly (host and port; scheme is only used to normalise default ports).
- `LORE_GATEWAY_AUTH_TOKEN` is a dedicated gateway credential (32–256 chars,
  compared by SHA-256 digest with `timingSafeEqual`), separate from provider
  keys. In remote/hosted mode every **data-plane** request needs it; browser
  origins are categorically denied on data-plane paths; provider credentials
  never authorise management.
- **Hosted mode** refuses `projects/merge`, `import/structured`,
  `entities/rebuild`, `entities/rebuild/cancel`.

Implications for `packages/ui`:

- The browser sends **no credentials**: same-origin `fetch` to `/api/v1/*`, no
  `Authorization` header, no token stored in the bundle or `localStorage`.
- A `404` on `GET /api/v1/projects` with a bodyless response is rendered as
  **"unauthorized / hidden"**, not "no projects".
- Static assets are served with the same peer check as the API, a strict CSP,
  `frame-ancestors 'none'` and `X-Frame-Options: DENY` (UI-02).
