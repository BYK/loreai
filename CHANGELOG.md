# Changelog
## 0.29.0

### New Features ✨

- (gateway) Route Pi openai-codex through the gateway (#715) by @BYK in [#717](https://github.com/BYK/loreai/pull/717)

### Bug Fixes 🐛

#### Core

- Stop non-repo dirs from becoming git-remote magnets by @BYK in [#724](https://github.com/BYK/loreai/pull/724)
- Self-heal corrupt/truncated embedding model download by @BYK in [#721](https://github.com/BYK/loreai/pull/721)

#### Other

- (cch) Run seed scripts under native Node, file issues on failure by @BYK in [#719](https://github.com/BYK/loreai/pull/719)
- (gateway) Stop background-queue saturation (curation debounce + load-aware scaling) by @BYK in [#720](https://github.com/BYK/loreai/pull/720)

### Internal Changes 🔧

- (cch) Skip binary scan when a known seed validates; dedupe seed table by @BYK in [#722](https://github.com/BYK/loreai/pull/722)

## 0.28.0

### New Features ✨

- (website) Clean extensionless URLs (drop .html) by @BYK in [#714](https://github.com/BYK/loreai/pull/714)
- Surface known entities to the agent and resolve cross-project repos via recall by @BYK in [#707](https://github.com/BYK/loreai/pull/707)

### Bug Fixes 🐛

#### Gateway

- Exit promptly on Ctrl+C (bounded shutdown + force-exit on repeat) by @BYK in [#706](https://github.com/BYK/loreai/pull/706)
- Unblock background work — dynamic concurrency, idle de-flood, per-provider breaker, 402 handling by @BYK in [#713](https://github.com/BYK/loreai/pull/713)
- Stop Tier 1b rotation from merging distinct Claude Code conversations by @BYK in [#712](https://github.com/BYK/loreai/pull/712)
- Ignore NODE_OPTIONS in the SEA binary to keep the V8 code cache valid by @BYK in [#710](https://github.com/BYK/loreai/pull/710)
- Replace Bun native fetch with node:https to bypass 5-min timeout cap by @BYK in [#704](https://github.com/BYK/loreai/pull/704)

#### Other

- (opencode) Pin Anthropic baseURL to /v1 to stop /messages 404 by @BYK in [#709](https://github.com/BYK/loreai/pull/709)

### Internal Changes 🔧

- (website) Split production deploy into its own workflow by @BYK in [#716](https://github.com/BYK/loreai/pull/716)
- Strip unused Sentry integrations from bundle via pnpm patch by @BYK in [#708](https://github.com/BYK/loreai/pull/708)

## 0.27.0

### New Features ✨

#### Gateway

- Keepalive pings on client-facing SSE stream during upstream silence by @BYK in [#702](https://github.com/BYK/loreai/pull/702)
- Synthetic tool primitive + auto-detect project via injected tool call by @BYK in [#681](https://github.com/BYK/loreai/pull/681)

#### Other

- (entities) Name-containment dedup signal (first-name vs full-name) by @BYK in [#692](https://github.com/BYK/loreai/pull/692)
- (recall) Search people & entities (aliases + relationships) in recall by @BYK in [#688](https://github.com/BYK/loreai/pull/688)
- (ui) Collapse entity-rebuild behind details + clickable knowledge type filters by @BYK in [#684](https://github.com/BYK/loreai/pull/684)
- Session move/reassign — split mis-grouped projects by @BYK in [#696](https://github.com/BYK/loreai/pull/696)
- Recognize X-Session-Id header for Tier-1 session identification by @BYK in [#687](https://github.com/BYK/loreai/pull/687)

### Bug Fixes 🐛

#### Gateway

- Reuse existing gateway on EADDRINUSE instead of crashing by @BYK in [#698](https://github.com/BYK/loreai/pull/698)
- Remove ineffective timeout:false, document Bun 5-min fetch cap by @BYK in [#700](https://github.com/BYK/loreai/pull/700)
- Redirect root path instead of 500; backfill server + llm-adapter tests by @BYK in [#697](https://github.com/BYK/loreai/pull/697)
- Prevent worker auth cross-contamination and improve resilience by @BYK in [#691](https://github.com/BYK/loreai/pull/691)
- Use native fetch under Bun to fix streaming hang + 5-min timeout by @BYK in [#694](https://github.com/BYK/loreai/pull/694)
- Remove 5-min upstream timeout that truncates slow LLM streams by @BYK in [#689](https://github.com/BYK/loreai/pull/689)
- Update fossilize to 0.9.2 (fixes SEA code cache rejection) by @BYK in [#685](https://github.com/BYK/loreai/pull/685)
- Replace DecompressionStream('zstd') with node:zlib streaming by @BYK in [#680](https://github.com/BYK/loreai/pull/680)

#### Other

- (entities,ui) Restore knowledge/entity dashboard views + harden self-merge + entity re-derivation by @BYK in [#682](https://github.com/BYK/loreai/pull/682)
- Stop cross-project knowledge leakage and hide internal workers by @BYK in [#683](https://github.com/BYK/loreai/pull/683)
- Distillation queue coalescing + log spam dedup + compaction anomaly handling by @BYK in [#676](https://github.com/BYK/loreai/pull/676)

### Internal Changes 🔧

#### Gateway

- SSE-aware replay harness + streaming pipeline coverage by @BYK in [#701](https://github.com/BYK/loreai/pull/701)
- Cover pipeline /lore:* slash commands and /v1/compact validation by @BYK in [#699](https://github.com/BYK/loreai/pull/699)
- Cover recorder, cost-tracker, idle, anthropic stream by @BYK in [#693](https://github.com/BYK/loreai/pull/693)

#### Publish

- Use sudo for global npm upgrade (EACCES on /usr/local) by @BYK in [#679](https://github.com/BYK/loreai/pull/679)
- Restore npm upgrade for OIDC trusted publishing by @BYK in [#678](https://github.com/BYK/loreai/pull/678)

#### Other

- (entities) Fix flaky containment survivor assertion (timestamp tiebreaker, not collation) by @BYK in [#695](https://github.com/BYK/loreai/pull/695)
- Add Codecov coverage reporting with 80% patch requirement by @BYK in [#686](https://github.com/BYK/loreai/pull/686)

## 0.26.0

### New Features ✨

#### Gateway

- Offline compaction from distillations + SSE keepalive by @BYK in [#672](https://github.com/BYK/loreai/pull/672)
- Auto-install @loreai/opencode plugin in `lore setup opencode` by @BYK in [#658](https://github.com/BYK/loreai/pull/658)

#### Other

- (ci) Build darwin binary natively on macOS for code cache + codesign by @BYK in [#641](https://github.com/BYK/loreai/pull/641)
- (site) Add OG/Twitter Card meta tags + CI verification by @BYK in [#659](https://github.com/BYK/loreai/pull/659)

### Bug Fixes 🐛

#### Gateway

- Error the compaction keepalive stream on summary failure by @BYK in [#675](https://github.com/BYK/loreai/pull/675)
- Persist session project binding so restarts don't split sessions by @BYK in [#673](https://github.com/BYK/loreai/pull/673)
- Make the LLM adapter the single owner of worker-failure attribution by @BYK in [#671](https://github.com/BYK/loreai/pull/671)
- Circuit-break runaway worker failures + stable Sentry grouping by @BYK in [#669](https://github.com/BYK/loreai/pull/669)
- Unify worker retry policy to ride out 429s and quiet noise by @BYK in [#666](https://github.com/BYK/loreai/pull/666)
- Resolve bun export to source to prevent stale in-process bundle by @BYK in [#668](https://github.com/BYK/loreai/pull/668)
- Harden request entrypoints against malformed input by @BYK in [#667](https://github.com/BYK/loreai/pull/667)
- Address self-review findings in setup plugin install by @BYK in [#660](https://github.com/BYK/loreai/pull/660)

#### Other

- (ci) Include hidden files in sea-staging artifact upload by @BYK in [#657](https://github.com/BYK/loreai/pull/657)
- (deps) Patch transitive yaml@2.7.1 (CVE-2026-33532) via pnpm override by @BYK in [#652](https://github.com/BYK/loreai/pull/652)
- (test) Move vitest resolve.alias to top level so tests use source by @BYK in [#651](https://github.com/BYK/loreai/pull/651)
- (website) Lead with install CTA, demote Folk Lore waitlist by @BYK in [#661](https://github.com/BYK/loreai/pull/661)

### Documentation 📚

- (setup) Add @loreai/opencode plugin install suggestion to setup opencode output by @BYK in [#656](https://github.com/BYK/loreai/pull/656)
- (website) Lead with context management and add the cost story by @BYK in [#665](https://github.com/BYK/loreai/pull/665)
- Update documentation for bun to node+pnpm+vitest migration by @BYK in [#674](https://github.com/BYK/loreai/pull/674)

### Internal Changes 🔧

#### Publish

- Bump Craft to 2.26.9 and drop Node 22 workaround by @BYK in [61ea4bf6](https://github.com/BYK/loreai/commit/61ea4bf69ea4c6c8e74fe369cb49d248b5d1d4f8)
- Use Node 22 + npm upgrade to avoid Node 24 extract-zip hang by @BYK in [c68bca8e](https://github.com/BYK/loreai/commit/c68bca8e264f50f27ad4744d877997bc5e1dba09)

#### Other

- Revert client-id back to app-id — different values, needs variable update by @BYK in [8a153b35](https://github.com/BYK/loreai/commit/8a153b354c1a34d48239c0f7e6cf8b0dec7f4952)
- Replace deprecated app-id with client-id in GitHub App token action by @BYK in [ba983b60](https://github.com/BYK/loreai/commit/ba983b60fbe1070cdc40aaf9249653171d9e61f5)

## 0.25.0

### New Features ✨

#### Cch

- Add seeds for Claude Code up to 2.1.165 by @github-actions in [#567](https://github.com/BYK/loreai/pull/567)
- Add seeds for Claude Code up to 2.1.163 by @github-actions in [#558](https://github.com/BYK/loreai/pull/558)
- Add seeds for Claude Code up to 2.1.162 by @github-actions in [#525](https://github.com/BYK/loreai/pull/525)
- Add seeds for Claude Code up to 2.1.161 by @github-actions in [#510](https://github.com/BYK/loreai/pull/510)
- Add seeds for Claude Code up to 2.1.160 by @github-actions in [#492](https://github.com/BYK/loreai/pull/492)
- Add seeds for Claude Code up to 2.1.153 by @github-actions in [#480](https://github.com/BYK/loreai/pull/480)
- Add seeds for Claude Code up to 2.1.152 by @github-actions in [#471](https://github.com/BYK/loreai/pull/471)

#### Core

- Track cross-project knowledge transfer metrics (#506) by @BYK in [#531](https://github.com/BYK/loreai/pull/531)
- Support non-English conversations (Turkish) by @BYK in [#522](https://github.com/BYK/loreai/pull/522)
- Structured tool-call execution trace for richer pattern extraction by @BYK in [#521](https://github.com/BYK/loreai/pull/521)
- Auto-promote knowledge recurring across 3+ projects by @BYK in [#505](https://github.com/BYK/loreai/pull/505)

#### Core,Gateway

- Add loreFile.enabled config toggle by @BYK in [#637](https://github.com/BYK/loreai/pull/637)
- Worker attribution columns + health monitoring by @BYK in [#617](https://github.com/BYK/loreai/pull/617)

#### Docs

- Persona-based docs site + LORE_UPSTREAM_EXTRA_HEADERS by @BYK in [#625](https://github.com/BYK/loreai/pull/625)
- Redesign Header & Logo by @sylncnr in [#508](https://github.com/BYK/loreai/pull/508)

#### Gateway

- Add setup handlers for opencode + claude-code by @BYK in [#650](https://github.com/BYK/loreai/pull/650)
- Dynamic worker model discovery from models.dev for all providers by @BYK in [#622](https://github.com/BYK/loreai/pull/622)
- Provider-ID-based upstream routing by @BYK in [#557](https://github.com/BYK/loreai/pull/557)

#### Other

- (build) Migrate standalone binary from Bun --compile to Node SEA via fossilize by @BYK in [#564](https://github.com/BYK/loreai/pull/564)
- (entities) Embedding-based entity auto-dedup (#462) by @BYK in [#536](https://github.com/BYK/loreai/pull/536)
- (quota) Integrate Anthropic OAuth usage/quota API by @BYK in [#509](https://github.com/BYK/loreai/pull/509)
- (website) Migrate website to Astro by @sylncnr in [#559](https://github.com/BYK/loreai/pull/559)
- Add `lore setup` command with Codex support by @BYK in [#514](https://github.com/BYK/loreai/pull/514)
- Add multi-user attribution and team sync schema (v29) by @BYK in [#468](https://github.com/BYK/loreai/pull/468)
- Worker credential routing and custom upstream by @BYK in [#482](https://github.com/BYK/loreai/pull/482)
- Configurable session eviction timeout, sub-agent fast eviction, session-limiter cleanup by @BYK in [#478](https://github.com/BYK/loreai/pull/478)
- Entity enrichment — metadata, relationships, and self-entity by @BYK in [#470](https://github.com/BYK/loreai/pull/470)
- Daily budget throttling with rate-aware proxy sleep by @BYK in [#469](https://github.com/BYK/loreai/pull/469)
- Add Hermes Agent integration (proxy + plugin) by @BYK in [#465](https://github.com/BYK/loreai/pull/465)
- Entity registry with grounding pass and alias resolution by @BYK in [#460](https://github.com/BYK/loreai/pull/460)

### Bug Fixes 🐛

#### Ci

- Remove empty `with:` from pnpm/action-setup in eval.yml by @BYK in [#610](https://github.com/BYK/loreai/pull/610)
- Populate vendor model cache before tests to prevent HuggingFace 429s by @BYK in [#566](https://github.com/BYK/loreai/pull/566)
- Make embedding tests resilient to HuggingFace download flakes by @BYK in [#528](https://github.com/BYK/loreai/pull/528)

#### Core

- IDF-aware relaxed cascade and long-query expansion cap by @BYK in [#639](https://github.com/BYK/loreai/pull/639)
- Fix embedding worker init in vitest, graceful shutdown, remove silent test skips by @BYK in [#613](https://github.com/BYK/loreai/pull/613)
- Recognize WASM fatal error wrapper prefix in isWasmFatalError() by @BYK in [#604](https://github.com/BYK/loreai/pull/604)
- Guard against postMessage on terminated embedding worker by @BYK in [#603](https://github.com/BYK/loreai/pull/603)
- Normalize provider API paths in fetch interceptor by @BYK in [#577](https://github.com/BYK/loreai/pull/577)
- Replace O(N²) correlated subquery in metadata aggregation with JOIN by @BYK in [#570](https://github.com/BYK/loreai/pull/570)
- Clean up knowledge_transfers on entry removal by @BYK in [#543](https://github.com/BYK/loreai/pull/543)

#### Embedding

- Use subquery for DISTINCT dedup in entity backfill SQL by @BYK in [#550](https://github.com/BYK/loreai/pull/550)
- Stop OOM event storm, single-thread WASM, remove auto-fallback by @BYK in [#545](https://github.com/BYK/loreai/pull/545)

#### Entities

- Filter dismissed pairs from dashboard dedup suggestions by @BYK in [#598](https://github.com/BYK/loreai/pull/598)
- Fix self/person merge, dashboard UX, and alias copy bug by @BYK in [#595](https://github.com/BYK/loreai/pull/595)

#### Gateway

- Strengthen .lore.md commit reminder in recall tool by @BYK in [#635](https://github.com/BYK/loreai/pull/635)
- Only mark \_default stale when it holds the same credential as the stale provider by @BYK in [#633](https://github.com/BYK/loreai/pull/633)
- Per-provider auth staleness to prevent cross-provider credential poisoning by @BYK in [#632](https://github.com/BYK/loreai/pull/632)
- Pass session upstream URL to cache-warmer profile resolution by @BYK in [#626](https://github.com/BYK/loreai/pull/626)
- Test cache isolation + docs accuracy for dynamic worker model by @BYK in [#624](https://github.com/BYK/loreai/pull/624)
- Address PR #622 review — zero-cost models, dynamic discovery tests, stale docs by @BYK in [#623](https://github.com/BYK/loreai/pull/623)
- Prevent cross-provider worker model pollution on multi-provider sessions by @BYK in [#621](https://github.com/BYK/loreai/pull/621)
- Externalize @loreai/core in Bun ESM bundle to prevent fetch loop by @BYK in [#620](https://github.com/BYK/loreai/pull/620)
- Use fossilize programmatic API instead of impl-* glob dance by @BYK in [#609](https://github.com/BYK/loreai/pull/609)
- Remove cache fields from ZERO_USAGE and consolidate SSE extraction by @BYK in [#611](https://github.com/BYK/loreai/pull/611)
- Polyfill getSystemErrorMap for Bun to prevent Sentry SDK crash by @BYK in [#602](https://github.com/BYK/loreai/pull/602)
- Guard resp.usage accesses against undefined for vLLM/partial responses by @BYK in [#600](https://github.com/BYK/loreai/pull/600)
- Handle SSE response from upstream when stream: false was sent by @BYK in [#605](https://github.com/BYK/loreai/pull/605)
- Decouple worker wire protocol from provider identity by @BYK in [#596](https://github.com/BYK/loreai/pull/596)
- Remove unused providerID param from resolveTarget by @BYK in [#593](https://github.com/BYK/loreai/pull/593)
- Use fossilize programmatic API with dynamic import by @BYK in [#592](https://github.com/BYK/loreai/pull/592)
- Use fossilize programmatic API with dynamic import resolution by @BYK in [06cc0b84](https://github.com/BYK/loreai/commit/06cc0b84602359c2e0bcce4d730c3f391bb84c80)
- Enforce same-provider worker routing — never cross-provider by @BYK in [#588](https://github.com/BYK/loreai/pull/588)
- Route NVIDIA and other OpenAI-protocol providers to OpenAI batch API by @BYK in [#587](https://github.com/BYK/loreai/pull/587)
- Clear cached warmup body on provider/model switch by @BYK in [#585](https://github.com/BYK/loreai/pull/585)
- Make passthrough and slash responses protocol-aware by @BYK in [#584](https://github.com/BYK/loreai/pull/584)
- Remove protocolToProviderID and use exact provider ID matching for workers by @BYK in [#582](https://github.com/BYK/loreai/pull/582)
- Make pipeline protocol-aware to prevent stream flag bugs by @BYK in [#581](https://github.com/BYK/loreai/pull/581)
- Prevent session header leaks and harden fetch interceptor by @BYK in [#580](https://github.com/BYK/loreai/pull/580)
- Per-provider auth and upstream snapshots to prevent cross-contamination by @BYK in [#579](https://github.com/BYK/loreai/pull/579)
- Use original fetch for upstream calls to prevent interceptor loop by @BYK in [#576](https://github.com/BYK/loreai/pull/576)
- Couple recall follow-up stream flag to its consumer by @BYK in [#573](https://github.com/BYK/loreai/pull/573)
- Route worker calls through session's provider by @BYK in [#572](https://github.com/BYK/loreai/pull/572)
- Provider routing follow-up fixes from post-merge audit by @BYK in [#565](https://github.com/BYK/loreai/pull/565)
- Preserve 5m cache TTL for non-native Anthropic upstreams by @BYK in [#563](https://github.com/BYK/loreai/pull/563)
- Strip extended cache TTL for non-native Anthropic upstreams by @BYK in [#560](https://github.com/BYK/loreai/pull/560)
- Handle Codex /v1/responses/compact compaction endpoint by @BYK in [#552](https://github.com/BYK/loreai/pull/552)
- Make worker model session-provider-aware to prevent cross-provider 401s by @BYK in [#554](https://github.com/BYK/loreai/pull/554)
- Daily budget disable button + costs page performance by @BYK in [#553](https://github.com/BYK/loreai/pull/553)
- Add auth stale guard to scheduleBackgroundWork and filter transient structured logs by @BYK in [#548](https://github.com/BYK/loreai/pull/548)
- Lossless content-block passthrough for images and unknown media types by @BYK in [#526](https://github.com/BYK/loreai/pull/526)
- Never merge unrelated sessions onto the gateway cwd by @BYK in [#523](https://github.com/BYK/loreai/pull/523)
- Offer auto-import per-agent so new agents aren't skipped by @BYK in [#518](https://github.com/BYK/loreai/pull/518)
- Make OpenAI Responses API stateless (drop previous_response_id) by @BYK in [#517](https://github.com/BYK/loreai/pull/517)
- Reject WebSocket upgrades cleanly instead of 404 by @BYK in [#515](https://github.com/BYK/loreai/pull/515)
- Coalesce tool items in OpenAI Responses API parser by @BYK in [#512](https://github.com/BYK/loreai/pull/512)
- OpenAI tool pairing + recall leak on streaming path by @BYK in [#511](https://github.com/BYK/loreai/pull/511)

#### Gateway,Core

- Address 4 Sentry issues (1J, Q, 10, 1Z) by @BYK in [#614](https://github.com/BYK/loreai/pull/614)
- Protocol-safe worker routing + atomic tool_use/tool_result on eviction by @BYK in [#594](https://github.com/BYK/loreai/pull/594)

#### Site

- Restore lilly stem clipped by viewBox by @BYK in [#629](https://github.com/BYK/loreai/pull/629)
- Grain z-index, blog footer, CWD-relative fs read by @BYK in [#601](https://github.com/BYK/loreai/pull/601)
- Convert embedded PNG logo to pure SVG, add light variant by @BYK in [#599](https://github.com/BYK/loreai/pull/599)

#### Test

- Make Sentry-off-during-tests CWD-independent (#530) by @BYK in [#541](https://github.com/BYK/loreai/pull/541)
- Eliminate Sentry background-fetch interference in quota tests by @BYK in [#532](https://github.com/BYK/loreai/pull/532)
- Scope quota fetch-mock capture to the quota URL (#527) by @BYK in [#529](https://github.com/BYK/loreai/pull/529)
- Extend timeout for flaky quota test on CI by @BYK in [8e219898](https://github.com/BYK/loreai/commit/8e21989804575a39b81aa1fb34c7572b12af23fe)

#### Other

- (core,gateway) Restore bun export conditions for OpenCode plugin by @BYK in [#597](https://github.com/BYK/loreai/pull/597)
- (cost) Apply batch discount to cache read/write costs by @BYK in [#503](https://github.com/BYK/loreai/pull/503)
- (costs) Per-day cost ledger + faster Costs page by @BYK in [#507](https://github.com/BYK/loreai/pull/507)
- (docs-preview) Deploy production docs to gh-pages root, not \_preview/ by @BYK in [9dd8cbe1](https://github.com/BYK/loreai/commit/9dd8cbe10f9b68b4becc00dbfd0ae99fbb8b122d)
- (gateway,core,opencode) Auto-detect remote-gateway mode and harden project attribution by @BYK in [#618](https://github.com/BYK/loreai/pull/618)
- (gateway,opencode) Transparent provider routing and protocol preservation by @BYK in [#571](https://github.com/BYK/loreai/pull/571)
- (gateway,opencode,pi) Transparent provider routing via fetch-level interception by @BYK in [#574](https://github.com/BYK/loreai/pull/574)
- (gradient) Detect free-write-cache providers and compress eagerly by @BYK in [#487](https://github.com/BYK/loreai/pull/487)
- (install) Strip macOS quarantine flag and bump fossilize to 0.9.1 by @BYK in [#634](https://github.com/BYK/loreai/pull/634)
- (lint) Resolve biome findings from PR #554 merge in [e7498302](https://github.com/BYK/loreai/commit/e7498302485efd062fde1535d7530b1401493457)
- (opencode) Redirect all configured providers through gateway by @BYK in [#562](https://github.com/BYK/loreai/pull/562)
- OAuth worker header simulation and proactive batch bypass by @BYK in [#502](https://github.com/BYK/loreai/pull/502)
- OpenAI Responses API gateway translation (builds on #483) by @sergical in [#485](https://github.com/BYK/loreai/pull/485)
- Wire ensureSelfEntity() into curator pipeline by @BYK in [#484](https://github.com/BYK/loreai/pull/484)
- Extract evictIdleSessions() for testability, clean up consolidation cooldown by @BYK in [#481](https://github.com/BYK/loreai/pull/481)
- Address review findings from PR #475 and #477 by @BYK in [#479](https://github.com/BYK/loreai/pull/479)
- Filter embedding API key errors and harden beforeSend patterns by @BYK in [#477](https://github.com/BYK/loreai/pull/477)
- Auto-disable batch API for providers that return 404 by @BYK in [#476](https://github.com/BYK/loreai/pull/476)
- OpenAI protocol translation, curator validation, and batch queue 404 handling by @BYK in [#475](https://github.com/BYK/loreai/pull/475)
- Batch consolidation for large entry counts by @BYK in [#474](https://github.com/BYK/loreai/pull/474)
- Consolidation retry storm, idle curation frequency, and session memory leak by @BYK in [#473](https://github.com/BYK/loreai/pull/473)
- Use tool_use/tool_result in recall follow-up to prevent result leaking by @BYK in [#472](https://github.com/BYK/loreai/pull/472)
- Consolidate Sentry beforeSend filter for embedding and WASM errors by @BYK in [#466](https://github.com/BYK/loreai/pull/466)
- Handle WASM abort in embedding worker and suppress shutdown noise by @BYK in [#464](https://github.com/BYK/loreai/pull/464)
- Stop background worker 401 storm when OAuth token expires by @BYK in [#463](https://github.com/BYK/loreai/pull/463)

### Documentation 📚

#### Site

- Fix 5 accuracy/sidebar issues from post-merge audit of #640 by @BYK in [#646](https://github.com/BYK/loreai/pull/646)
- Add Setup command page + trim duplicated Codex sections by @BYK in [#640](https://github.com/BYK/loreai/pull/640)
- Fix self-hosted terminology contradiction + deduplicate comparison by @BYK in [#547](https://github.com/BYK/loreai/pull/547)
- Use 'fair source' terminology and add portability clarification by @BYK in [3f2c63e9](https://github.com/BYK/loreai/commit/3f2c63e915c5c8d649f0e9b24f40d316c0fbcc4d)
- Add 'Why Lore' comparison page and extract shared theme by @BYK in [#542](https://github.com/BYK/loreai/pull/542)

#### Other

- (gateway) Clarify stateless Responses API comments (post-#517 review) by @BYK in [#519](https://github.com/BYK/loreai/pull/519)
- Align site and README with pitch deck positioning by @BYK in [#615](https://github.com/BYK/loreai/pull/615)
- Apply consistent shared-context positioning across site and README by @BYK in [#586](https://github.com/BYK/loreai/pull/586)
- Add 'Your tools change. Your memory doesn't.' tagline by @BYK in [#500](https://github.com/BYK/loreai/pull/500)
- Add RSI/harness self-improvement framing to marketing copy by @BYK in [#499](https://github.com/BYK/loreai/pull/499)

### Internal Changes 🔧

#### Gateway

- Replace Bun runtime APIs with Node.js equivalents by @BYK in [#583](https://github.com/BYK/loreai/pull/583)
- Replace 5 last* SessionState fields with UpstreamSnapshot by @BYK in [#575](https://github.com/BYK/loreai/pull/575)

#### Other

- (ci) Quiet test harness noise + pretest hook for bundle by @BYK in [#608](https://github.com/BYK/loreai/pull/608)
- (core) Strengthen IDF cascade comparator tests by @BYK in [#642](https://github.com/BYK/loreai/pull/642)
- (deps) Switch package manager from bun to pnpm by @BYK in [#578](https://github.com/BYK/loreai/pull/578)
- (docs-preview) Add workflow_dispatch trigger for manual deploys by @BYK in [aa3d40cb](https://github.com/BYK/loreai/commit/aa3d40cb90a76abc5cc61c5cb0985968827e2d7b)
- (publish) Pin Craft to 2.26.5 to fix silent publish failure by @BYK in [#653](https://github.com/BYK/loreai/pull/653)
- (site) Consolidate logo & favicon assets, auto-generate at build time by @BYK in [#616](https://github.com/BYK/loreai/pull/616)
- (test) Remove redundant typeof guard in quota URL capture by @BYK in [#534](https://github.com/BYK/loreai/pull/534)
- (ui) Optimize dashboard/costs page queries and add response timeout by @BYK in [#561](https://github.com/BYK/loreai/pull/561)
- Install rcodesign for macOS binary ad-hoc signing by @BYK in [#636](https://github.com/BYK/loreai/pull/636)
- Rename nuum-dev references to lore-dev and modernize project naming by @BYK in [#619](https://github.com/BYK/loreai/pull/619)
- Add actionlint to catch workflow YAML errors by @BYK in [#612](https://github.com/BYK/loreai/pull/612)
- Remove @types/bun and add macOS binary quarantine strip by @BYK in [#591](https://github.com/BYK/loreai/pull/591)
- Add docs preview workflow and skip CI for docs-only changes by @BYK in [#544](https://github.com/BYK/loreai/pull/544)
- Block live models.dev fetch in test preload by @BYK in [#540](https://github.com/BYK/loreai/pull/540)
- Stabilize distillation perf-regression guards (#538) by @BYK in [#539](https://github.com/BYK/loreai/pull/539)
- Enable Biome lint rules and fix all findings by @BYK in [#537](https://github.com/BYK/loreai/pull/537)
- Apply Biome safe lint autofixes by @BYK in [#535](https://github.com/BYK/loreai/pull/535)
- Introduce Biome and apply repo-wide formatting by @BYK in [#533](https://github.com/BYK/loreai/pull/533)
- Add coexistence test for per-agent auto-import + fix stale JSDoc by @BYK in [#520](https://github.com/BYK/loreai/pull/520)
- OAuth worker header simulation tests and prompt-caching-scope beta by @BYK in [#504](https://github.com/BYK/loreai/pull/504)

### Other

- content(site): sharpen competitive positioning on Why Lore page by @BYK in [#631](https://github.com/BYK/loreai/pull/631)
- Enlarge social icons in site nav by @sylncnr in [#556](https://github.com/BYK/loreai/pull/556)
- Keep social icons visible in site nav by @sylncnr in [#555](https://github.com/BYK/loreai/pull/555)
- Polish site logo and add separated logo assets by @sylncnr in [#549](https://github.com/BYK/loreai/pull/549)

## 0.24.1

### Bug Fixes 🐛

- Retry with token-level truncation on ONNX OOM in embedding worker by @BYK in [#457](https://github.com/BYK/loreai/pull/457)

## 0.24.0

### New Features ✨

- Workspace discovery for monorepo support by @BYK in [#451](https://github.com/BYK/loreai/pull/451)

### Bug Fixes 🐛

- (ci) Write Craft publish-state file so retries skip already-published targets by @BYK in [#449](https://github.com/BYK/loreai/pull/449)
- Detect and recover from stale OAuth credentials in background workers by @BYK in [#454](https://github.com/BYK/loreai/pull/454)
- Recover from prompt overflow errors and add safety margins by @BYK in [#452](https://github.com/BYK/loreai/pull/452)

### Internal Changes 🔧

- (publish) Finalize Sentry release after publishing by @BYK in [#450](https://github.com/BYK/loreai/pull/450)

## 0.23.0

### New Features ✨

#### Cch

- Add seeds for Claude Code up to 2.1.146 by @github-actions in [#436](https://github.com/BYK/loreai/pull/436)
- Add seeds for Claude Code up to 2.1.145 by @github-actions in [#412](https://github.com/BYK/loreai/pull/412)
- Add seeds for Claude Code up to 2.1.144 by @github-actions in [#379](https://github.com/BYK/loreai/pull/379)

#### Ui

- Visual cost bars, savings hero, and daily trend chart by @BYK in [#418](https://github.com/BYK/loreai/pull/418)
- Chat-bubble conversation view for session page by @BYK in [#398](https://github.com/BYK/loreai/pull/398)

#### Other

- Migrate eval system to vitest-evals by @BYK in [#441](https://github.com/BYK/loreai/pull/441)
- Allow multiple recall tool calls per request (multi-turn recall) by @BYK in [#404](https://github.com/BYK/loreai/pull/404)
- Improve recall tool description + add cross-session cue eval scenarios by @BYK in [#396](https://github.com/BYK/loreai/pull/396)
- Inflate + replay compatibility — skip filler turns in gateway replay by @BYK in [#393](https://github.com/BYK/loreai/pull/393)
- Wire --inflate flag into eval CLI for 400K token scenario testing by @BYK in [#386](https://github.com/BYK/loreai/pull/386)
- Lightweight cross-session action tag context for curator by @BYK in [#385](https://github.com/BYK/loreai/pull/385)
- Scenario inflator for 400K token eval scenarios by @BYK in [#384](https://github.com/BYK/loreai/pull/384)
- Add local LLM provider support (vllm, ollama, llama.cpp, etc.) by @BYK in [#383](https://github.com/BYK/loreai/pull/383)
- Add temperature parameter to LLMClient interface by @BYK in [#382](https://github.com/BYK/loreai/pull/382)
- Lower echo threshold + clustering for broader behavioral pattern detection by @BYK in [#377](https://github.com/BYK/loreai/pull/377)
- Action tagging in distillation for implicit behavioral pattern detection by @BYK in [#376](https://github.com/BYK/loreai/pull/376)
- Vector similarity-based behavioral pattern detection by @BYK in [#375](https://github.com/BYK/loreai/pull/375)
- Add session recording, replay, and scenario filtering to eval harness by @BYK in [#374](https://github.com/BYK/loreai/pull/374)
- Add comprehensive eval suite for Lore's five key dimensions by @BYK in [#369](https://github.com/BYK/loreai/pull/369)
- Tool-call-aware cache warming + /lore:warm:* commands + UI controls by @BYK in [#370](https://github.com/BYK/loreai/pull/370)

### Bug Fixes 🐛

- (cache-warmer) Tighten warming heuristics to reduce net negative spend by @BYK in [#429](https://github.com/BYK/loreai/pull/429)
- (eval) Build realistic Lore context for QA questions by @BYK in [#414](https://github.com/BYK/loreai/pull/414)
- (ui) Daily cost trend chart not rendering bars by @BYK in [#426](https://github.com/BYK/loreai/pull/426)
- 1h TTL cache write pricing and dynamic savings/overhead wording by @BYK in [#445](https://github.com/BYK/loreai/pull/445)
- Resolve Sentry issues — JSONC config, ENOENT guard, Node.js port fallback, transient error filtering by @BYK in [#443](https://github.com/BYK/loreai/pull/443)
- Use compaction as primary baseline, fix threshold, update marketing by @BYK in [#437](https://github.com/BYK/loreai/pull/437)
- Context health note — signal omitted details instead of false assurance by @BYK in [#434](https://github.com/BYK/loreai/pull/434)
- Scripted interceptor for eval replay + distillation prompt tuning by @BYK in [#433](https://github.com/BYK/loreai/pull/433)
- Downweight knowledge in recall when session content exists by @BYK in [#432](https://github.com/BYK/loreai/pull/432)
- Store scripted assistant content in eval + session-affinity recall boost by @BYK in [#431](https://github.com/BYK/loreai/pull/431)
- Add amnesia mode and x-lore-no-store to prevent QA contamination in recall by @BYK in [#430](https://github.com/BYK/loreai/pull/430)
- Prevent tool_use/tool_result mismatch at gradient prefix/raw boundary (#424) by @BYK in [#428](https://github.com/BYK/loreai/pull/428)
- Resume sessions across client restarts instead of orphaning them by @BYK in [#427](https://github.com/BYK/loreai/pull/427)
- Create dev shims in gateway build so workspace consumers resolve bun exports by @BYK in [#425](https://github.com/BYK/loreai/pull/425)
- Drop callCount from dedup tests — still flaky after #419 by @BYK in [#421](https://github.com/BYK/loreai/pull/421)
- Use promise identity in dedup tests to eliminate cross-test flakiness by @BYK in [#419](https://github.com/BYK/loreai/pull/419)
- Build Bun-native ESM bundle for OpenCode plugin by @BYK in [#415](https://github.com/BYK/loreai/pull/415)
- Remove distilled=0 filter from temporal BM25 search by @BYK in [#413](https://github.com/BYK/loreai/pull/413)
- Add deepseek- dash-prefix routing to UPSTREAM_ROUTES by @rgutzen in [#406](https://github.com/BYK/loreai/pull/406)
- Add anti-imitation instruction to recall tool description by @BYK in [#411](https://github.com/BYK/loreai/pull/411)
- Inject X-Lore-Project header to eliminate cwd fallback warning by @BYK in [#408](https://github.com/BYK/loreai/pull/408)
- Code block alignment in Simplicity & Migration sections by @BYK in [#407](https://github.com/BYK/loreai/pull/407)
- Background worker rate-limit resilience for Claude Max by @BYK in [#397](https://github.com/BYK/loreai/pull/397)
- QA prompt instructs LLM to use recall tool by @BYK in [#400](https://github.com/BYK/loreai/pull/400)
- Pin user assertions in distillation to prevent loss in long sessions by @BYK in [#394](https://github.com/BYK/loreai/pull/394)
- Fall back to upstream when compaction summary generation fails by @BYK in [#392](https://github.com/BYK/loreai/pull/392)
- Pass local:true when starting gateway in-process to prevent hosted mode by @BYK in [#390](https://github.com/BYK/loreai/pull/390)
- Curator uses distilled observations when all messages are distilled by @BYK in [#389](https://github.com/BYK/loreai/pull/389)
- Judge prompt should not penalize extra correct information by @BYK in [#388](https://github.com/BYK/loreai/pull/388)
- Remove distilled=0 filter from temporal vector search by @BYK in [#387](https://github.com/BYK/loreai/pull/387)
- Preserve temporal embeddings on distillation + expose source IDs in recall by @BYK in [#380](https://github.com/BYK/loreai/pull/380)
- Improve distillation detail preservation for code-specific artifacts by @BYK in [#378](https://github.com/BYK/loreai/pull/378)
- Warmup cooldown timing + rising cost threshold + accurate TTL pricing by @BYK in [#373](https://github.com/BYK/loreai/pull/373)
- Improve curator preference detection and evolution handling by @BYK in [#372](https://github.com/BYK/loreai/pull/372)

### Documentation 📚

- Replace waitlist form with Loops.so integration by @BYK in [#447](https://github.com/BYK/loreai/pull/447)
- Hero stat 13/20 → 2.6x total recall by @BYK in [#444](https://github.com/BYK/loreai/pull/444)
- Update website copy — sessions lasting days, crystal-clear memory by @BYK in [#442](https://github.com/BYK/loreai/pull/442)
- Add releasing instructions to AGENTS.md by @BYK in [#438](https://github.com/BYK/loreai/pull/438)
- Update eval results — context retention 3.9→4.6, +77% vs tail-window by @BYK in [#435](https://github.com/BYK/loreai/pull/435)
- Update website and README with context retention eval results by @BYK in [#420](https://github.com/BYK/loreai/pull/420)
- Update website hero stats with 400K eval results by @BYK in [#405](https://github.com/BYK/loreai/pull/405)
- Update README with 400K token eval results by @BYK in [#403](https://github.com/BYK/loreai/pull/403)

### Internal Changes 🔧

- (deps) Bump pytest from 8.2.2 to 9.0.3 in /packages/core/eval/fixtures/projects/python-api in the pip group across 1 directory by @dependabot in [#371](https://github.com/BYK/loreai/pull/371)
- Disable eval workflow on PRs by @BYK in [#446](https://github.com/BYK/loreai/pull/446)
- Improve distillation detail retention at 400K+ token sessions by @BYK in [#423](https://github.com/BYK/loreai/pull/423)
- Remove deprecated eval infra and update docs with new eval results by @BYK in [#422](https://github.com/BYK/loreai/pull/422)

### Other

- eval: add 2.3M-token mega-session scenario — Lore 4.0 vs Compaction 2.4 (+70%) by @BYK in [#440](https://github.com/BYK/loreai/pull/440)

## 0.22.0

### New Features ✨

- (cch) Add seeds for Claude Code up to 2.1.143 by @github-actions in [#356](https://github.com/BYK/loreai/pull/356)
- (website) Add unified architecture section — context + memory as one pipeline by @BYK in [0a6587a9](https://github.com/BYK/loreai/commit/0a6587a986bc26519e27f15825f920c5227de450)
- Rewrite README to align with new website messaging by @BYK in [#366](https://github.com/BYK/loreai/pull/366)
- Marketing rewrite + product improvements inspired by Stellman/Orosz articles by @BYK in [#362](https://github.com/BYK/loreai/pull/362)

### Bug Fixes 🐛

- Expand OpenCode plugin GATEWAY_PROVIDERS to route all proxiable providers through gateway by @BYK in [#365](https://github.com/BYK/loreai/pull/365)
- Resolve high priority bugs from quality playbook phase 3 by @BYK in [#364](https://github.com/BYK/loreai/pull/364)
- Stop attributing all turns after warmup as cache warming savings by @BYK in [#363](https://github.com/BYK/loreai/pull/363)
- Add PNG/ICO favicon fallbacks for Firefox Android by @BYK in [9d31559e](https://github.com/BYK/loreai/commit/9d31559efc8cbc407eb7a1f773133cebaf668ee9)
- Add favicon to website matching dashboard by @BYK in [8e34d32d](https://github.com/BYK/loreai/commit/8e34d32deb8db65b5800ef5dcd0eabacce99b993)

## 0.21.0

### New Features ✨

- Display subagent sessions as collapsible tree with cost roll-up by @BYK in [#360](https://github.com/BYK/loreai/pull/360)
- Persist table sort order to localStorage by @BYK in [#354](https://github.com/BYK/loreai/pull/354)

### Bug Fixes 🐛

- Correct cache bust detection causing false unsustainable warnings by @BYK in [#359](https://github.com/BYK/loreai/pull/359)
- Improve LTM preference injection — skip relevance scoring, dedicated budget, meaningful confidence by @BYK in [#358](https://github.com/BYK/loreai/pull/358)
- Forward anthropic-beta header in cache-warmer to support beta-gated body fields by @BYK in [#357](https://github.com/BYK/loreai/pull/357)
- Prevent splitSegments infinite recursion and add global background work throttling by @BYK in [#355](https://github.com/BYK/loreai/pull/355)

## 0.20.2

### Bug Fixes 🐛

- Review follow-ups for unsustainable warning PR by @BYK in [#352](https://github.com/BYK/loreai/pull/352)
- Surface unsustainable warning on all gradient return paths by @BYK in [#351](https://github.com/BYK/loreai/pull/351)

### Internal Changes 🔧

- Replace EMA-driven context cap with tier-based cost-aware decisions by @BYK in [#348](https://github.com/BYK/loreai/pull/348)

### Other

- release: 0.20.1 by @BYK in [abc0dc89](https://github.com/BYK/loreai/commit/abc0dc8980f82b8df300bb6dd41394da45c46d2c)

## 0.20.1

### Internal Changes 🔧

- Replace EMA-driven context cap with tier-based cost-aware decisions by @BYK in [#348](https://github.com/BYK/loreai/pull/348)

## 0.20.0

### New Features ✨

- (cch) Add seeds for Claude Code up to 2.1.142 by @github-actions in [#329](https://github.com/BYK/loreai/pull/329)
- REST API for remote data management, recall, and import by @BYK in [#337](https://github.com/BYK/loreai/pull/337)
- Lore start defaults to hosted mode, opt out with --local by @BYK in [#334](https://github.com/BYK/loreai/pull/334)
- LORE_HOSTED_MODE — disable FS operations on client-controlled paths by @BYK in [#333](https://github.com/BYK/loreai/pull/333)
- X-Lore-Git-Remote header and LORE_REMOTE_URL for remote gateway project grouping by @BYK in [#331](https://github.com/BYK/loreai/pull/331)

### Bug Fixes 🐛

- Resolve pi build rootDir error by adding types export to core by @BYK in [#346](https://github.com/BYK/loreai/pull/346)
- Prevent Sentry noise from embedding failures and fix surrogate pair truncation by @BYK in [#344](https://github.com/BYK/loreai/pull/344)
- Pre-truncate long texts to prevent ONNX OOM and report embedding errors to Sentry by @BYK in [#343](https://github.com/BYK/loreai/pull/343)
- Break Layer 4 cache hit rate death spiral by @BYK in [#341](https://github.com/BYK/loreai/pull/341)
- Exempt sub-agent sessions from cache warming by @BYK in [#340](https://github.com/BYK/loreai/pull/340)
- Harden remote import error handling and clean up code by @BYK in [#339](https://github.com/BYK/loreai/pull/339)
- Import dedup checks remote DB when LORE_REMOTE_URL is set by @BYK in [#338](https://github.com/BYK/loreai/pull/338)
- Stop merging sub-agent turns into parent session by @BYK in [#335](https://github.com/BYK/loreai/pull/335)
- Use text blocks in recall follow-up to prevent tool leaking to client by @BYK in [#332](https://github.com/BYK/loreai/pull/332)
- Keep recall tool in follow-up request to prevent API rejection by @BYK in [#330](https://github.com/BYK/loreai/pull/330)

### Internal Changes 🔧

- (ui) Unify Per Session and Live Sessions tables into shared renderer by @BYK in [#336](https://github.com/BYK/loreai/pull/336)
- Extract ltmDiffThreshold() helper to deduplicate step 6 and 7b by @BYK in [#342](https://github.com/BYK/loreai/pull/342)

## 0.19.0

### New Features ✨

- (cch) Add seeds for Claude Code up to 2.1.141 by @github-actions in [#297](https://github.com/BYK/loreai/pull/297)
- Adaptive dedup threshold with automatic and manual calibration by @BYK in [#321](https://github.com/BYK/loreai/pull/321)
- Add logo favicon to web dashboard pages by @BYK in [f94c4cf6](https://github.com/BYK/loreai/commit/f94c4cf6e6c66137cf26de20a6abfb4958ea3d4d)
- Show live/total breakdown in dashboard and cost pills by @BYK in [#317](https://github.com/BYK/loreai/pull/317)
- 3-block system prompt for cache-efficient LTM injection by @BYK in [#311](https://github.com/BYK/loreai/pull/311)
- Defer context-dependent LTM to turn 2, add hybrid vector+FTS5 scoring by @BYK in [#310](https://github.com/BYK/loreai/pull/310)
- Add OpenAI Batch API support for worker calls by @BYK in [#309](https://github.com/BYK/loreai/pull/309)
- Re-run forSession() for fresh LTM on Layer 4 emergency reset by @BYK in [#305](https://github.com/BYK/loreai/pull/305)
- Crash-safe state persistence via periodic flush by @BYK in [#303](https://github.com/BYK/loreai/pull/303)

### Bug Fixes 🐛

- Redirect GET / to /ui dashboard by @BYK in [#327](https://github.com/BYK/loreai/pull/327)
- Preserve thinking blocks in recall follow-up to prevent API rejection by @BYK in [#326](https://github.com/BYK/loreai/pull/326)
- Resolve embedding worker crash in CJS bundle (LOREAI-GATEWAY-D/E) by @BYK in [#325](https://github.com/BYK/loreai/pull/325)
- Pass project_id (not path) to projectName() on warming costs table by @BYK in [#324](https://github.com/BYK/loreai/pull/324)
- Prevent fatal crash when startServer() called with missing hosts by @BYK in [#322](https://github.com/BYK/loreai/pull/322)
- Remove text from logo SVG, keep icon only by @BYK in [42e27682](https://github.com/BYK/loreai/commit/42e27682fccbab2832f2a2b8a6d3551ce80b1dd1)
- Use icon-only logo (no text) for favicon by @BYK in [ecab9388](https://github.com/BYK/loreai/commit/ecab9388fc9cb411f6cb9761c862d61918cd2223)
- Prevent test data from leaking into production DB by @BYK in [#320](https://github.com/BYK/loreai/pull/320)
- Use export for env vars in install script examples by @BYK in [#319](https://github.com/BYK/loreai/pull/319)
- Key global histograms by project_id instead of directory path by @BYK in [#318](https://github.com/BYK/loreai/pull/318)
- Tidy dashboard and cost intelligence pills for scope consistency by @BYK in [#316](https://github.com/BYK/loreai/pull/316)
- Pass --since tag to craft changelog for shallow clone compatibility by @BYK in [#315](https://github.com/BYK/loreai/pull/315)
- Show craft stderr on nightly version failure for debugging by @BYK in [#314](https://github.com/BYK/loreai/pull/314)
- Compute nightly version from next semver bump instead of current release by @BYK in [#313](https://github.com/BYK/loreai/pull/313)
- Address review findings from 3-block system prompt PR by @BYK in [#312](https://github.com/BYK/loreai/pull/312)
- Strip recall marker text from temporal storage to prevent FTS echo by @BYK in [#306](https://github.com/BYK/loreai/pull/306)
- Pre-populate headerSessionIndex from DB on startup by @BYK in [#304](https://github.com/BYK/loreai/pull/304)
- Prevent layer-4 stickiness trap and refactor compression stages by @BYK in [#300](https://github.com/BYK/loreai/pull/300)
- Add concurrency guards and persist volatile session state across restarts by @BYK in [#298](https://github.com/BYK/loreai/pull/298)

### Documentation 📚

- Recover install.sh curl copy/paste block on landing page by @BYK in [eb671df7](https://github.com/BYK/loreai/commit/eb671df78080438fa7d55acbe35b8cd0e30a11d6)
- Change Lore to Lore.AI and adjust scaling by @sylncnr in [#308](https://github.com/BYK/loreai/pull/308)
- Update landing page branding and header layout by @sylncnr in [#307](https://github.com/BYK/loreai/pull/307)

## 0.18.0

### New Features ✨

- (cch) Add seeds for Claude Code up to 2.1.140 by @github-actions in [#283](https://github.com/BYK/loreai/pull/283)
- (cli) Forward extra arguments to launched agent by @BYK in [#284](https://github.com/BYK/loreai/pull/284)
- (core) Detect repeated user instructions for LTM curation by @BYK in [#269](https://github.com/BYK/loreai/pull/269)
- (gateway) Add OpenAI Responses API wire protocol support by @BYK in [#263](https://github.com/BYK/loreai/pull/263)
- (warming) Replace per-window survival with commitment-based warming model by @BYK in [#280](https://github.com/BYK/loreai/pull/280)
- Add embedding-based dedup and 'lore data reindex' command by @BYK in [#288](https://github.com/BYK/loreai/pull/288)
- Migrate embeddings from fastembed/BGE Small to transformers.js/Nomic v1.5 by @BYK in [#287](https://github.com/BYK/loreai/pull/287)
- Add nightly build support to install script by @BYK in [#275](https://github.com/BYK/loreai/pull/275)
- Change default port from 6969 to 3207 with fallback chain by @BYK in [#273](https://github.com/BYK/loreai/pull/273)
- Decouple Pi plugin from @loreai/core via gateway /v1/compact endpoint by @BYK in [#271](https://github.com/BYK/loreai/pull/271)
- Boost vector search weight in RRF for semantic queries by @BYK in [#260](https://github.com/BYK/loreai/pull/260)
- Rename data directory from opencode-lore to lore with auto-migration by @BYK in [#259](https://github.com/BYK/loreai/pull/259)
- Add curator observability and fix pattern extraction false positives by @BYK in [#257](https://github.com/BYK/loreai/pull/257)
- Add cache warming dashboard page and session section by @BYK in [#256](https://github.com/BYK/loreai/pull/256)
- Show dashboard URL on startup and add `lore logs` command by @BYK in [#255](https://github.com/BYK/loreai/pull/255)
- Improve meta-request detection to prevent distilling title/summary conversations by @BYK in [#253](https://github.com/BYK/loreai/pull/253)
- Add conversation import system for extracting knowledge from prior AI agent history by @BYK in [#252](https://github.com/BYK/loreai/pull/252)
- Add user-level knowledge page to dashboard by @BYK in [#248](https://github.com/BYK/loreai/pull/248)

### Bug Fixes 🐛

- (cch) Make seed check CI version-agnostic and extract all missing versions by @BYK in [#279](https://github.com/BYK/loreai/pull/279)
- Include global entries in dedup scan by @BYK in [#295](https://github.com/BYK/loreai/pull/295)
- Tune embedding dedup threshold to 0.935 by @BYK in [#293](https://github.com/BYK/loreai/pull/293)
- Raise embedding dedup threshold from 0.85 to 0.92 by @BYK in [#291](https://github.com/BYK/loreai/pull/291)
- Use token-budget batching to prevent OOM on long texts by @BYK in [#290](https://github.com/BYK/loreai/pull/290)
- Prevent OOM in embedding backfill with long texts by @BYK in [#289](https://github.com/BYK/loreai/pull/289)
- Add word-overlap dedup for knowledge entries by @BYK in [#286](https://github.com/BYK/loreai/pull/286)
- Raise default maxListeners to suppress benign gz stream warning by @BYK in [#285](https://github.com/BYK/loreai/pull/285)
- Deduplicate concurrent models.dev fetch requests by @BYK in [#282](https://github.com/BYK/loreai/pull/282)
- Improve lore import UX — stdout logging, prompt ordering, only-ask-once by @BYK in [#278](https://github.com/BYK/loreai/pull/278)
- Upgrade double-lock, flag parsing, and message ordering by @BYK in [#277](https://github.com/BYK/loreai/pull/277)
- Cache inferred project path in session state to avoid cwd fallback by @BYK in [#276](https://github.com/BYK/loreai/pull/276)
- Correct cost intelligence accuracy and add overhead breakdown by @BYK in [#272](https://github.com/BYK/loreai/pull/272)
- Filter automated turns from cache warming gap histograms by @BYK in [#270](https://github.com/BYK/loreai/pull/270)
- Streaming robustness, RRF list priority, and CLI suggestion quality by @BYK in [#268](https://github.com/BYK/loreai/pull/268)
- Quality improvements across cache, recall, streaming, and CLI by @BYK in [#267](https://github.com/BYK/loreai/pull/267)
- Prevent post-idle compaction from busting /keep sessions on 5m TTL by @BYK in [#266](https://github.com/BYK/loreai/pull/266)
- Use persisted real worker costs in historical estimates instead of heuristic by @BYK in [#265](https://github.com/BYK/loreai/pull/265)
- Remove stale project path caching that caused cross-project misattribution by @BYK in [#262](https://github.com/BYK/loreai/pull/262)
- Filter distilled messages from temporal FTS search and purge worker boilerplate by @BYK in [#261](https://github.com/BYK/loreai/pull/261)
- Skip post-idle compaction when cache warmer kept the cache warm by @BYK in [#258](https://github.com/BYK/loreai/pull/258)
- Prevent subagent turns from inflating session messageCount by @BYK in [#254](https://github.com/BYK/loreai/pull/254)
- Write informational CLI messages to stdout instead of stderr by @BYK in [#249](https://github.com/BYK/loreai/pull/249)
- Import knowledge from .lore.md on file change and new session start by @BYK in [#247](https://github.com/BYK/loreai/pull/247)
- Reuse existing gateway instead of crashing on EADDRINUSE by @BYK in [#246](https://github.com/BYK/loreai/pull/246)
- Avoid Bun NAPI teardown crash on gateway exit by @BYK in [#245](https://github.com/BYK/loreai/pull/245)

### Documentation 📚

- Comprehensive mobile layout and grid overflow fixes by @sylncnr in [#250](https://github.com/BYK/loreai/pull/250)

### Internal Changes 🔧

- (ci) Upgrade GitHub Actions to Node.js 24 compatible versions by @BYK in [#281](https://github.com/BYK/loreai/pull/281)

### Other

- cleanup: remove "gateway mode" language by @BYK in [#274](https://github.com/BYK/loreai/pull/274)

## 0.17.1

### Bug Fixes 🐛

- Start gateway in-process instead of spawning a subprocess by @BYK in [#243](https://github.com/BYK/loreai/pull/243)
- Configure Craft statusProvider to wait for CI before publishing by @BYK in [#241](https://github.com/BYK/loreai/pull/241)

## 0.17.0

### New Features ✨

#### Gateway

- 3-tier session identification via client headers by @BYK in [#203](https://github.com/BYK/loreai/pull/203)
- Vendor fastembed for linux-arm64 binaries by @BYK in [#200](https://github.com/BYK/loreai/pull/200)
- Pin worker cch to known version/seed and re-sign conversation turns by @BYK in [#199](https://github.com/BYK/loreai/pull/199)
- Direct-bundle fastembed via bun --compile by @BYK in [#197](https://github.com/BYK/loreai/pull/197)

#### Other

- (cch) Add 2.1.138 seed, version fallback, and automated extraction pipeline by @BYK in [#212](https://github.com/BYK/loreai/pull/212)
- (ui) Add markdown rendering to web dashboard by @BYK in [#217](https://github.com/BYK/loreai/pull/217)
- Persist live session cost data (warmup, TTL, batch savings) across restarts by @BYK in [50685ede](https://github.com/BYK/loreai/commit/50685ede4a3a91a073ef17a089ccc49ba4720512)
- Add column sorting and filtering to web UI tables by @BYK in [#233](https://github.com/BYK/loreai/pull/233)
- Reduce distillation overhead with meta-distill separation, sliding expansion guard, and batch tracking by @BYK in [#229](https://github.com/BYK/loreai/pull/229)
- Improve project naming from git remote and add project delete/rename by @BYK in [#224](https://github.com/BYK/loreai/pull/224)
- Cost intelligence dashboard with per-session tracking and historical backdating by @BYK in [#222](https://github.com/BYK/loreai/pull/222)
- Speculative cache warming with survival analysis and user controls by @BYK in [#214](https://github.com/BYK/loreai/pull/214)
- Token-based distillation segmentation, √N budget, and expansion guard by @BYK in [#213](https://github.com/BYK/loreai/pull/213)
- Dynamic max_tokens sizing for workers and conversation passthrough by @BYK in [#211](https://github.com/BYK/loreai/pull/211)
- Prevent Claude Code auto-compaction with defense-in-depth by @BYK in [#210](https://github.com/BYK/loreai/pull/210)
- Identify projects by git remote to unify worktrees and clones by @BYK in [#208](https://github.com/BYK/loreai/pull/208)
- Data management CLI, recall command, web dashboard, and multi-host binding by @BYK in [#201](https://github.com/BYK/loreai/pull/201)
- Provider-aware worker model selection with multi-provider pricing by @BYK in [#186](https://github.com/BYK/loreai/pull/186)
- Cost-aware worker model, accurate cache pricing, and human-friendly invalidation reasons by @BYK in [#182](https://github.com/BYK/loreai/pull/182)
- Cost-aware cache optimization to reduce opus-4-6 write costs by @BYK in [#181](https://github.com/BYK/loreai/pull/181)

### Bug Fixes 🐛

#### Gateway

- Normalize cc_version suffix and max_tokens in cache analytics by @BYK in [#209](https://github.com/BYK/loreai/pull/209)
- Compute cch billing hash for worker requests using bearer tokens by @BYK in [#193](https://github.com/BYK/loreai/pull/193)
- Catch port-in-use errors and memoize gateway init (LOREAI-GATEWAY-2) by @BYK in [#191](https://github.com/BYK/loreai/pull/191)
- Suppress verbose startup banner in embedded mode by @BYK in [#190](https://github.com/BYK/loreai/pull/190)

#### Other

- (core) Make fastembed optional to survive CUDA 13 install failures by @BYK in [#192](https://github.com/BYK/loreai/pull/192)
- Prevent compaction summary leaking as subagent task_result to parent session by @BYK in [#236](https://github.com/BYK/loreai/pull/236)
- Increase flaky perf test threshold from 1s to 2s by @BYK in [#235](https://github.com/BYK/loreai/pull/235)
- Recover missing call_type column on distillations table by @BYK in [#232](https://github.com/BYK/loreai/pull/232)
- Update historical estimates note to reflect batch API tracking by @BYK in [357bd93c](https://github.com/BYK/loreai/commit/357bd93c83f97bad925828489eab1525175923d1)
- Remap @sentry/bun to @sentry/node in CJS npm bundle by @BYK in [#231](https://github.com/BYK/loreai/pull/231)
- Guard against test runs polluting the production database by @BYK in [#230](https://github.com/BYK/loreai/pull/230)
- Improve search quality with progressive FTS relaxation, temporal vector search, and UI overhaul by @BYK in [#228](https://github.com/BYK/loreai/pull/228)
- Binary smoke tests on macOS/Windows — isMainThread re-entry for worker thread by @BYK in [#227](https://github.com/BYK/loreai/pull/227)
- Scope test DELETE to project, add cache invalidation and recovery CLI by @BYK in [#226](https://github.com/BYK/loreai/pull/226)
- Use valid JSON placeholder in max_tokens normalization (LOREAI-GATEWAY-5) by @BYK in [#223](https://github.com/BYK/loreai/pull/223)
- Remove handleOverflowRecovery to stop race with built-in compaction by @BYK in [#220](https://github.com/BYK/loreai/pull/220)
- Worker calls falling back to stale Sonnet 4 instead of Sonnet 4.6 by @BYK in [#218](https://github.com/BYK/loreai/pull/218)
- Prevent subagent turns from polluting parent session's temporal history by @BYK in [#216](https://github.com/BYK/loreai/pull/216)
- Isolate subagent turns from parent session's dynamic max_tokens EMA by @BYK in [#215](https://github.com/BYK/loreai/pull/215)
- Per-session urgentDistillation and layer 1 distillation trigger by @BYK in [#204](https://github.com/BYK/loreai/pull/204)
- Per-session cch + split retry budget + unblock fastembed backfill by @BYK in [#195](https://github.com/BYK/loreai/pull/195)
- Increase Bun.serve idleTimeout for LLM streaming responses by @BYK in [#189](https://github.com/BYK/loreai/pull/189)
- Handle client disconnect in streaming pipeline (LOREAI-GATEWAY-3) by @BYK in [#188](https://github.com/BYK/loreai/pull/188)
- Normalize Claude CLI cch= hash in cache analytics by @BYK in [#187](https://github.com/BYK/loreai/pull/187)
- Use claude-sonnet-4-6 for worker model default (same price, latest version) by @BYK in [06353151](https://github.com/BYK/loreai/commit/0635315124d07b23cc128954231131cdc51ac2fc)
- Prevent ReadableStream controller double-close in streaming pipeline by @BYK in [#183](https://github.com/BYK/loreai/pull/183)

### Documentation 📚

- Add codebase overview to AGENTS.md to eliminate redundant explore runs by @BYK in [#234](https://github.com/BYK/loreai/pull/234)

### Internal Changes 🔧

- Strip Pi plugin to gateway-only mode by @BYK in [#238](https://github.com/BYK/loreai/pull/238)
- Strip OpenCode plugin to gateway-only mode by @BYK in [#237](https://github.com/BYK/loreai/pull/237)
- Move fastembed ONNX inference to worker thread (#196) by @BYK in [#225](https://github.com/BYK/loreai/pull/225)
- Skip redundant .lore.md import/export via mtime + content hash cache by @BYK in [#219](https://github.com/BYK/loreai/pull/219)
- Drop darwin-x64 (Intel macOS) target by @BYK in [#198](https://github.com/BYK/loreai/pull/198)

### Other

- debug: verify worker file exists before compile by @BYK in [25bd12fd](https://github.com/BYK/loreai/commit/25bd12fda775d2fa05c6e4736616ddb6fcc0c364)
- debug: log compile command to diagnose CI binary smoke test failure by @BYK in [c954862c](https://github.com/BYK/loreai/commit/c954862cc5c5aea63937828c2bc907fa5baa7935)

## 0.16.0

### New Features ✨

- (gateway) Add SENTRY_ENABLED toggle and environment tagging by @BYK in [#178](https://github.com/BYK/loreai/pull/178)
- Simplify worker model to session model, use live models.dev pricing by @BYK in [#179](https://github.com/BYK/loreai/pull/179)

## 0.15.0

### New Features ✨

#### Compact

- Anchor /compact on prior summary via SDK live read by @BYK in [#100](https://github.com/BYK/loreai/pull/100)
- Adopt upstream SUMMARY_TEMPLATE for /compact prompt by @BYK in [#92](https://github.com/BYK/loreai/pull/92)

#### Distill

- Anchor meta-distillation on prior summary; loadForSession excludes archived by @BYK in [#101](https://github.com/BYK/loreai/pull/101)
- Truncate oversized tool outputs in distillation input by @BYK in [#94](https://github.com/BYK/loreai/pull/94)

#### Gateway

- Debug ID source maps + zero runtime dependencies by @BYK in [#171](https://github.com/BYK/loreai/pull/171)
- Background version check with upgrade nag by @BYK in [#168](https://github.com/BYK/loreai/pull/168)
- Implement delta-based self-upgrade system by @BYK in [#166](https://github.com/BYK/loreai/pull/166)
- Show env vars and agent integration info on lore start by @BYK in [#165](https://github.com/BYK/loreai/pull/165)
- CLI skeleton with npm bundle, binary build, and CI smoke tests by @BYK in [#159](https://github.com/BYK/loreai/pull/159)
- Ground-truth cache analytics with request body prefix diff by @BYK in [#155](https://github.com/BYK/loreai/pull/155)
- Worker model discovery via /v1/models API + models.dev pricing by @BYK in [#142](https://github.com/BYK/loreai/pull/142)
- Transparent recall tool interception by @BYK in [#139](https://github.com/BYK/loreai/pull/139)
- Per-session auth isolation + OAuth Bearer support by @BYK in [#135](https://github.com/BYK/loreai/pull/135)
- Replace content markers with fingerprint-based session tracking by @BYK in [#125](https://github.com/BYK/loreai/pull/125)

#### Gradient

- Range-aware file read deduplication by @BYK in [#120](https://github.com/BYK/loreai/pull/120)
- Token-budget tail sizing in layer 4 by @BYK in [#104](https://github.com/BYK/loreai/pull/104)
- Cold-cache idle-resume cache refresh by @BYK in [#95](https://github.com/BYK/loreai/pull/95)

#### Worker Model

- Prefer non-reasoning models and disable thinking on worker calls by @BYK in [#122](https://github.com/BYK/loreai/pull/122)
- Wire up dynamic model selection on session idle by @BYK in [#118](https://github.com/BYK/loreai/pull/118)

#### Other

- (db) Persist r_compression and c_norm on distillations (schema v12) by @BYK in [#116](https://github.com/BYK/loreai/pull/116)
- (pi) @loreai/pi extension — Lore memory for Pi coding-agent by @BYK in [#78](https://github.com/BYK/loreai/pull/78)
- (recovery) Media-aware overflow recovery preserves user intent by @BYK in [#99](https://github.com/BYK/loreai/pull/99)
- (website) Add landing page by @sylncnr in [#152](https://github.com/BYK/loreai/pull/152)
- Sentry observability with AI monitoring, metadata table, and cost metrics by @BYK in [#176](https://github.com/BYK/loreai/pull/176)
- Wire structured logs and error capture to Sentry in prod builds by @BYK in [#170](https://github.com/BYK/loreai/pull/170)
- Web install script and updated landing page by @BYK in [#163](https://github.com/BYK/loreai/pull/163)
- Layered cache breakpoints and LTM content-diff pinning by @BYK in [#157](https://github.com/BYK/loreai/pull/157)
- Emit '[Searching memory...]' indicator for Case 2 (mixed tools) by @BYK in [6ef1b7b0](https://github.com/BYK/loreai/commit/6ef1b7b0a8cbcbd4accc952ccb3477fa6f47775d)
- Local embeddings, exact keyword boost, and pattern extraction by @BYK in [#136](https://github.com/BYK/loreai/pull/136)
- Batch queue for Anthropic Message Batches API (50% worker cost savings) by @BYK in [#134](https://github.com/BYK/loreai/pull/134)
- Context health diagnostics — C_norm, R_compression, time-gap segmentation, recall recency by @BYK in [#113](https://github.com/BYK/loreai/pull/113)
- Cost reduction — layer-0 cap, worker model, tighter defaults by @BYK in [#105](https://github.com/BYK/loreai/pull/105)

### Bug Fixes 🐛

#### Ci

- Use non-hidden placeholder for release-patches artifact by @BYK in [ac910438](https://github.com/BYK/loreai/commit/ac91043841c984d7f2f753237fcfb344ec9023dc)
- Use non-hidden placeholder for release-patches artifact by @BYK in [ea2cdf02](https://github.com/BYK/loreai/commit/ea2cdf023c128cb5a872aa1844f35d0915699022)
- Always upload release-patches artifact on release branches by @BYK in [9bf811fa](https://github.com/BYK/loreai/commit/9bf811fad0fcf7b3a0356e45cf9ef24ead353466)
- Always upload release-patches artifact on release branches by @BYK in [3131210c](https://github.com/BYK/loreai/commit/3131210c36b8e9fd7fb26949d74a23edb25082a6)
- Include @loreai/gateway in pack and publish targets by @BYK in [0b8a2213](https://github.com/BYK/loreai/commit/0b8a221390891a7d683dd6e3bc924d0f357ac10d)

#### Db

- Use os.homedir() for cross-platform data directory resolution by @BYK in [#131](https://github.com/BYK/loreai/pull/131)
- Recover missing kv_meta from partial migration failure by @BYK in [#114](https://github.com/BYK/loreai/pull/114)
- Prevent singleton poisoning when migrate() throws by @BYK in [#111](https://github.com/BYK/loreai/pull/111)

#### Gateway

- Align npm package with sentry-cli pattern by @BYK in [b190738a](https://github.com/BYK/loreai/commit/b190738a8ddec006dd0e6946b68d57e43fc1947b)
- Don't wipe dist-bin/ between cross-platform binary builds by @BYK in [a6d4db7f](https://github.com/BYK/loreai/commit/a6d4db7fd06d2efdcc06be2d694083e830557beb)
- Add worker retry with backoff and batch API circuit breaker by @BYK in [#164](https://github.com/BYK/loreai/pull/164)
- Suppress agent detection noise in embedded server mode by @BYK in [#161](https://github.com/BYK/loreai/pull/161)
- Preserve thinking block signature through Lore format round-trip by @BYK in [#162](https://github.com/BYK/loreai/pull/162)
- Cache analytics JSON path missing array index for first element by @BYK in [#156](https://github.com/BYK/loreai/pull/156)

#### Gradient

- Deterministic timestamps in sanitizeToolParts by @BYK in [#124](https://github.com/BYK/loreai/pull/124)
- Protect active tool-call chains from output stripping by @BYK in [#109](https://github.com/BYK/loreai/pull/109)

#### Opencode

- Robust context-overflow detection with upstream regex list by @BYK in [#93](https://github.com/BYK/loreai/pull/93)
- Hoist ltmSessionCache to avoid TDZ on startup by @BYK in [#77](https://github.com/BYK/loreai/pull/77)

#### Release

- Include gateway in bump-version.sh for Craft publish by @BYK in [8db81083](https://github.com/BYK/loreai/commit/8db8108387e1eea706c56866cb9312f80a02ed4d)
- Patch bun.lock workspace versions during bump by @BYK in [#88](https://github.com/BYK/loreai/pull/88)
- Custom bump script to work around npm workspace:* incompatibility by @BYK in [#83](https://github.com/BYK/loreai/pull/83)

#### Other

- (cache) Remove idle-handler LTM cache invalidation to preserve warm prefix by @BYK in [#160](https://github.com/BYK/loreai/pull/160)
- (distill) Wrap metaDistill store+archive in a transaction by @BYK in [#103](https://github.com/BYK/loreai/pull/103)
- (pi) Add pi.extensions manifest and externalize pi ecosystem deps by @BYK in [#90](https://github.com/BYK/loreai/pull/90)
- (publish) Add registry-url to setup-node for npm OIDC by @BYK in [#85](https://github.com/BYK/loreai/pull/85)
- Include binary and patch artifacts in Craft release workflow by @BYK in [#172](https://github.com/BYK/loreai/pull/172)
- Pin @huggingface/hub@2.11.0 to avoid broken xetchunk-wasm workspace refs by @BYK in [#150](https://github.com/BYK/loreai/pull/150)
- Resolve all 11 audit vulnerabilities (7 high, 4 moderate) by @BYK in [#149](https://github.com/BYK/loreai/pull/149)
- Resolve typecheck error in content-based fingerprint and increase hysteresis to 15% with high-water mark budget by @BYK in [4e59e007](https://github.com/BYK/loreai/commit/4e59e00776913e9fbe7d604a3746ed7b57ada856)
- Eliminate gradient cache busts with deterministic IDs, offset-from-end pins, and cost-aware cap by @BYK in [13f09ad3](https://github.com/BYK/loreai/commit/13f09ad326f91d5a8b0bdc3f56af166bef4dbfc5)
- Stabilize gradient cache with budget snapshot, hysteresis, and per-session LTM by @BYK in [#144](https://github.com/BYK/loreai/pull/144)
- Type errors in Case 2 integration tests by @BYK in [77eb640e](https://github.com/BYK/loreai/commit/77eb640ec3f7920a462f628d59d42ba3a209db30)
- Deprecated worker models, invalid cache TTL format, and batch error logging by @BYK in [#140](https://github.com/BYK/loreai/pull/140)
- Prevent re-entrant deadlock in event hook (MaxListenersExceeded hang) by @BYK in [#138](https://github.com/BYK/loreai/pull/138)
- Reduce cache-bust cost with idle threshold, sticky layers, bust tracking, and meta-distill gating by @BYK in [#132](https://github.com/BYK/loreai/pull/132)
- CROSS JOIN for FTS5 queries — prevent server freeze on recall by @BYK in [#107](https://github.com/BYK/loreai/pull/107)
- Add root exports trampoline for file:// plugin loading by @BYK in [#73](https://github.com/BYK/loreai/pull/73)

### Documentation 📚

- Update landing page with gateway architecture and waitlist form by @sylncnr in [#153](https://github.com/BYK/loreai/pull/153)
- Add prompt change discipline guide by @BYK in [#97](https://github.com/BYK/loreai/pull/97)
- Per-package README and LICENSE for npm by @BYK in [#80](https://github.com/BYK/loreai/pull/80)

### Internal Changes 🔧

#### Agents Md

- Sync curator entries before release by @BYK in [#82](https://github.com/BYK/loreai/pull/82)
- Monorepo milestone — root trampoline documented by @BYK in [#74](https://github.com/BYK/loreai/pull/74)
- Sync curator-managed knowledge entries by @BYK in [#70](https://github.com/BYK/loreai/pull/70)

#### Core

- Decouple from @opencode-ai/sdk with host-agnostic types and LLMClient by @BYK in [#76](https://github.com/BYK/loreai/pull/76)
- Add esbuild build script for node + bun targets by @BYK in [#75](https://github.com/BYK/loreai/pull/75)
- Abstract SQLite driver behind #db/driver subpath by @BYK in [#72](https://github.com/BYK/loreai/pull/72)

#### Gradient

- Batch distillation consumption at turn boundaries by @BYK in [#123](https://github.com/BYK/loreai/pull/123)
- Pin reasoning preservation across all gradient layers by @BYK in [#96](https://github.com/BYK/loreai/pull/96)

#### Opencode

- Skip duplicated logic when gateway is active by @BYK in [#158](https://github.com/BYK/loreai/pull/158)
- Add upstream-drift contract tests for hook invocation by @BYK in [#102](https://github.com/BYK/loreai/pull/102)

#### Other

- (gateway) Unified recall marker-and-expand strategy by @BYK in [#154](https://github.com/BYK/loreai/pull/154)
- (temporal) Unambiguous chunk terminator in partsToText by @BYK in [#98](https://github.com/BYK/loreai/pull/98)
- Add dist-bin/ to gitignore by @BYK in [#169](https://github.com/BYK/loreai/pull/169)
- Add nightly builds with delta patches and GHCR distribution by @BYK in [#167](https://github.com/BYK/loreai/pull/167)
- Use models.dev unified JSON API for cost data by @BYK in [#143](https://github.com/BYK/loreai/pull/143)
- Case 2 (mixed tools) integration tests for recall interception by @BYK in [#141](https://github.com/BYK/loreai/pull/141)
- Migrate knowledge entries from AGENTS.md to .lore.md by @BYK in [da2a18bb](https://github.com/BYK/loreai/commit/da2a18bb4e4c1200601b57d68ab4e70bbd0b688c)
- Remove gateway observer hooks and dead recorder exports by @BYK in [#130](https://github.com/BYK/loreai/pull/130)
- Remove read-time temporal enrichment from distillation prefix by @BYK in [#129](https://github.com/BYK/loreai/pull/129)
- Update license to FSL-1.1-Apache-2.0 by @BYK in [#126](https://github.com/BYK/loreai/pull/126)
- Update repository URLs to BYK/loreai after rename by @BYK in [#86](https://github.com/BYK/loreai/pull/86)
- Rename opencode-lore to @loreai/opencode with legacy mirror by @BYK in [#81](https://github.com/BYK/loreai/pull/81)
- Multi-package release pipeline for @loreai scope by @BYK in [#79](https://github.com/BYK/loreai/pull/79)
- Split into @loreai/core + opencode-lore monorepo by @BYK in [#71](https://github.com/BYK/loreai/pull/71)

### Other

- release: 0.14.0 by @BYK in [ec0ad773](https://github.com/BYK/loreai/commit/ec0ad773468f7b632f5b21624d8e1f6de8a0c904)
- Create CNAME by @BYK in [a892d4c9](https://github.com/BYK/loreai/commit/a892d4c95d8c41917266c232641e21f861e4d815)
- Delete CNAME by @BYK in [fdff9751](https://github.com/BYK/loreai/commit/fdff975152570cd71dfbfacd4295c7076384f771)
- Create CNAME by @BYK in [3734d0fa](https://github.com/BYK/loreai/commit/3734d0fa534f3b0db39f53ff2d987c62e9c8fd63)
- release: 0.13.4 by @BYK in [ff3d1645](https://github.com/BYK/loreai/commit/ff3d1645c21617fee177b2d02504010b0be197d3)
- release: 0.13.3 by @BYK in [3ee00766](https://github.com/BYK/loreai/commit/3ee007663fa02be76fa45f1f221b00bc66297355)
- release: 0.12.0 by @BYK in [389e73c5](https://github.com/BYK/loreai/commit/389e73c5bdb29c549b5dd7389f3405dccccd182d)
- release: 0.11.1 by @BYK in [43ead9f3](https://github.com/BYK/loreai/commit/43ead9f33427d9673944298b11ae39ccd989665c)
- release: 0.11.0 by @BYK in [cc12aafb](https://github.com/BYK/loreai/commit/cc12aafb2c25b51e9738d4b0da2037391b4efc29)
- release: 0.10.2 by @BYK in [0fe8fbcf](https://github.com/BYK/loreai/commit/0fe8fbcf03f757e519068c86551f14f0940ef5ad)
- release: 0.10.1 by @BYK in [fa8e4704](https://github.com/BYK/loreai/commit/fa8e4704f5a32933e2f92eafe8e8e35f3c206f08)
- release: 0.10.0 by @BYK in [e08f26fb](https://github.com/BYK/loreai/commit/e08f26fb7d34bfe27f4992c406a2f96ff09a6ca8)

## 0.14.0

### New Features ✨

#### Gateway

- Debug ID source maps + zero runtime dependencies by @BYK in [#171](https://github.com/BYK/loreai/pull/171)
- Background version check with upgrade nag by @BYK in [#168](https://github.com/BYK/loreai/pull/168)
- Implement delta-based self-upgrade system by @BYK in [#166](https://github.com/BYK/loreai/pull/166)
- Show env vars and agent integration info on lore start by @BYK in [#165](https://github.com/BYK/loreai/pull/165)
- CLI skeleton with npm bundle, binary build, and CI smoke tests by @BYK in [#159](https://github.com/BYK/loreai/pull/159)
- Ground-truth cache analytics with request body prefix diff by @BYK in [#155](https://github.com/BYK/loreai/pull/155)

#### Other

- (website) Add landing page by @sylncnr in [#152](https://github.com/BYK/loreai/pull/152)
- Wire structured logs and error capture to Sentry in prod builds by @BYK in [#170](https://github.com/BYK/loreai/pull/170)
- Web install script and updated landing page by @BYK in [#163](https://github.com/BYK/loreai/pull/163)
- Layered cache breakpoints and LTM content-diff pinning by @BYK in [#157](https://github.com/BYK/loreai/pull/157)

### Bug Fixes 🐛

#### Gateway

- Add worker retry with backoff and batch API circuit breaker by @BYK in [#164](https://github.com/BYK/loreai/pull/164)
- Suppress agent detection noise in embedded server mode by @BYK in [#161](https://github.com/BYK/loreai/pull/161)
- Preserve thinking block signature through Lore format round-trip by @BYK in [#162](https://github.com/BYK/loreai/pull/162)
- Cache analytics JSON path missing array index for first element by @BYK in [#156](https://github.com/BYK/loreai/pull/156)

#### Other

- (cache) Remove idle-handler LTM cache invalidation to preserve warm prefix by @BYK in [#160](https://github.com/BYK/loreai/pull/160)
- Include binary and patch artifacts in Craft release workflow by @BYK in [#172](https://github.com/BYK/loreai/pull/172)

### Documentation 📚

- Update landing page with gateway architecture and waitlist form by @sylncnr in [#153](https://github.com/BYK/loreai/pull/153)

### Internal Changes 🔧

- (gateway) Unified recall marker-and-expand strategy by @BYK in [#154](https://github.com/BYK/loreai/pull/154)
- (opencode) Skip duplicated logic when gateway is active by @BYK in [#158](https://github.com/BYK/loreai/pull/158)
- Add dist-bin/ to gitignore by @BYK in [#169](https://github.com/BYK/loreai/pull/169)
- Add nightly builds with delta patches and GHCR distribution by @BYK in [#167](https://github.com/BYK/loreai/pull/167)

### Other

- Create CNAME by @BYK in [a653c597](https://github.com/BYK/loreai/commit/a653c597a6c460e3de59b9ee2ac17afee9d3b656)
- Delete CNAME by @BYK in [226d17a9](https://github.com/BYK/loreai/commit/226d17a9de33cff88ad581e5e4ef3cf79aaf272b)
- Create CNAME by @BYK in [b8384c82](https://github.com/BYK/loreai/commit/b8384c82806cf995bb5361143f0c045f5ba477ee)

## 0.13.4

### Bug Fixes 🐛

- Pin @huggingface/hub@2.11.0 to avoid broken xetchunk-wasm workspace refs by @BYK in [#150](https://github.com/BYK/loreai/pull/150)
- Resolve all 11 audit vulnerabilities (7 high, 4 moderate) by @BYK in [#149](https://github.com/BYK/loreai/pull/149)

## 0.13.3

### New Features ✨

#### Gateway

- Worker model discovery via /v1/models API + models.dev pricing by @BYK in [#142](https://github.com/BYK/loreai/pull/142)
- Transparent recall tool interception by @BYK in [#139](https://github.com/BYK/loreai/pull/139)
- Per-session auth isolation + OAuth Bearer support by @BYK in [#135](https://github.com/BYK/loreai/pull/135)
- Replace content markers with fingerprint-based session tracking by @BYK in [#125](https://github.com/BYK/loreai/pull/125)

#### Worker Model

- Prefer non-reasoning models and disable thinking on worker calls by @BYK in [#122](https://github.com/BYK/loreai/pull/122)
- Wire up dynamic model selection on session idle by @BYK in [#118](https://github.com/BYK/loreai/pull/118)

#### Other

- (db) Persist r_compression and c_norm on distillations (schema v12) by @BYK in [#116](https://github.com/BYK/loreai/pull/116)
- (gradient) Range-aware file read deduplication by @BYK in [#120](https://github.com/BYK/loreai/pull/120)
- Emit '[Searching memory...]' indicator for Case 2 (mixed tools) by @BYK in [a5a8e215](https://github.com/BYK/loreai/commit/a5a8e2151d3a25757b6b9ebd65b0fbbb08f78ce6)
- Local embeddings, exact keyword boost, and pattern extraction by @BYK in [#136](https://github.com/BYK/loreai/pull/136)
- Batch queue for Anthropic Message Batches API (50% worker cost savings) by @BYK in [#134](https://github.com/BYK/loreai/pull/134)

### Bug Fixes 🐛

- (ci) Include @loreai/gateway in pack and publish targets by @BYK in [a5c6bc0c](https://github.com/BYK/loreai/commit/a5c6bc0c02c8c94466f8f84afa453c5dce2c5d17)
- (db) Use os.homedir() for cross-platform data directory resolution by @BYK in [#131](https://github.com/BYK/loreai/pull/131)
- (gradient) Deterministic timestamps in sanitizeToolParts by @BYK in [#124](https://github.com/BYK/loreai/pull/124)
- (release) Include gateway in bump-version.sh for Craft publish by @BYK in [eefdb53f](https://github.com/BYK/loreai/commit/eefdb53f9fcd18b6a3c623f61b863b38078e3146)
- Resolve typecheck error in content-based fingerprint and increase hysteresis to 15% with high-water mark budget by @BYK in [c8dcf035](https://github.com/BYK/loreai/commit/c8dcf0354fee7bd052c1e9776a7fac0af5b8501a)
- Eliminate gradient cache busts with deterministic IDs, offset-from-end pins, and cost-aware cap by @BYK in [321accc3](https://github.com/BYK/loreai/commit/321accc32dfdb54a654fe52923fbda2e613d90a0)
- Stabilize gradient cache with budget snapshot, hysteresis, and per-session LTM by @BYK in [#144](https://github.com/BYK/loreai/pull/144)
- Type errors in Case 2 integration tests by @BYK in [4e2282d8](https://github.com/BYK/loreai/commit/4e2282d8c3df5e44a69e97fa870f5bd6b30d18a6)
- Deprecated worker models, invalid cache TTL format, and batch error logging by @BYK in [#140](https://github.com/BYK/loreai/pull/140)
- Prevent re-entrant deadlock in event hook (MaxListenersExceeded hang) by @BYK in [#138](https://github.com/BYK/loreai/pull/138)
- Reduce cache-bust cost with idle threshold, sticky layers, bust tracking, and meta-distill gating by @BYK in [#132](https://github.com/BYK/loreai/pull/132)

### Internal Changes 🔧

- (gradient) Batch distillation consumption at turn boundaries by @BYK in [#123](https://github.com/BYK/loreai/pull/123)
- Use models.dev unified JSON API for cost data by @BYK in [#143](https://github.com/BYK/loreai/pull/143)
- Case 2 (mixed tools) integration tests for recall interception by @BYK in [#141](https://github.com/BYK/loreai/pull/141)
- Migrate knowledge entries from AGENTS.md to .lore.md by @BYK in [107346f1](https://github.com/BYK/loreai/commit/107346f1415bea442f636bb85da84e94c014b37b)
- Remove gateway observer hooks and dead recorder exports by @BYK in [#130](https://github.com/BYK/loreai/pull/130)
- Remove read-time temporal enrichment from distillation prefix by @BYK in [#129](https://github.com/BYK/loreai/pull/129)
- Update license to FSL-1.1-Apache-2.0 by @BYK in [#126](https://github.com/BYK/loreai/pull/126)

## 0.12.0

### New Features ✨

- Context health diagnostics — C_norm, R_compression, time-gap segmentation, recall recency by @BYK in [#113](https://github.com/BYK/loreai/pull/113)

### Bug Fixes 🐛

- (db) Recover missing kv_meta from partial migration failure by @BYK in [#114](https://github.com/BYK/loreai/pull/114)

## 0.11.1

### Bug Fixes 🐛

- (db) Prevent singleton poisoning when migrate() throws by @BYK in [#111](https://github.com/BYK/loreai/pull/111)
- (gradient) Protect active tool-call chains from output stripping by @BYK in [#109](https://github.com/BYK/loreai/pull/109)

## 0.11.0

### New Features ✨

#### Compact

- Anchor /compact on prior summary via SDK live read by @BYK in [#100](https://github.com/BYK/loreai/pull/100)
- Adopt upstream SUMMARY_TEMPLATE for /compact prompt by @BYK in [#92](https://github.com/BYK/loreai/pull/92)

#### Distill

- Anchor meta-distillation on prior summary; loadForSession excludes archived by @BYK in [#101](https://github.com/BYK/loreai/pull/101)
- Truncate oversized tool outputs in distillation input by @BYK in [#94](https://github.com/BYK/loreai/pull/94)

#### Gradient

- Token-budget tail sizing in layer 4 by @BYK in [#104](https://github.com/BYK/loreai/pull/104)
- Cold-cache idle-resume cache refresh by @BYK in [#95](https://github.com/BYK/loreai/pull/95)

#### Other

- (recovery) Media-aware overflow recovery preserves user intent by @BYK in [#99](https://github.com/BYK/loreai/pull/99)
- Cost reduction — layer-0 cap, worker model, tighter defaults by @BYK in [#105](https://github.com/BYK/loreai/pull/105)

### Bug Fixes 🐛

- (distill) Wrap metaDistill store+archive in a transaction by @BYK in [#103](https://github.com/BYK/loreai/pull/103)
- (opencode) Robust context-overflow detection with upstream regex list by @BYK in [#93](https://github.com/BYK/loreai/pull/93)
- CROSS JOIN for FTS5 queries — prevent server freeze on recall by @BYK in [#107](https://github.com/BYK/loreai/pull/107)

### Documentation 📚

- Add prompt change discipline guide by @BYK in [#97](https://github.com/BYK/loreai/pull/97)

### Internal Changes 🔧

- (gradient) Pin reasoning preservation across all gradient layers by @BYK in [#96](https://github.com/BYK/loreai/pull/96)
- (opencode) Add upstream-drift contract tests for hook invocation by @BYK in [#102](https://github.com/BYK/loreai/pull/102)
- (temporal) Unambiguous chunk terminator in partsToText by @BYK in [#98](https://github.com/BYK/loreai/pull/98)

## 0.10.2

### Bug Fixes 🐛

- (pi) Add pi.extensions manifest and externalize pi ecosystem deps by @BYK in [#90](https://github.com/BYK/loreai/pull/90)

## 0.10.1

### Bug Fixes 🐛

- (release) Patch bun.lock workspace versions during bump by @BYK in [#88](https://github.com/BYK/loreai/pull/88)

## 0.10.0

### New Features ✨

- (pi) @loreai/pi extension — Lore memory for Pi coding-agent by @BYK in [#78](https://github.com/BYK/loreai/pull/78)

### Bug Fixes 🐛

- (opencode) Hoist ltmSessionCache to avoid TDZ on startup by @BYK in [#77](https://github.com/BYK/loreai/pull/77)
- (publish) Add registry-url to setup-node for npm OIDC by @BYK in [#85](https://github.com/BYK/loreai/pull/85)
- (release) Custom bump script to work around npm workspace:* incompatibility by @BYK in [#83](https://github.com/BYK/loreai/pull/83)
- Add root exports trampoline for file:// plugin loading by @BYK in [#73](https://github.com/BYK/loreai/pull/73)

### Documentation 📚

- Per-package README and LICENSE for npm by @BYK in [#80](https://github.com/BYK/loreai/pull/80)

### Internal Changes 🔧

#### Agents Md

- Sync curator entries before release by @BYK in [#82](https://github.com/BYK/loreai/pull/82)
- Monorepo milestone — root trampoline documented by @BYK in [#74](https://github.com/BYK/loreai/pull/74)
- Sync curator-managed knowledge entries by @BYK in [#70](https://github.com/BYK/loreai/pull/70)

#### Core

- Decouple from @opencode-ai/sdk with host-agnostic types and LLMClient by @BYK in [#76](https://github.com/BYK/loreai/pull/76)
- Add esbuild build script for node + bun targets by @BYK in [#75](https://github.com/BYK/loreai/pull/75)
- Abstract SQLite driver behind #db/driver subpath by @BYK in [#72](https://github.com/BYK/loreai/pull/72)

#### Other

- Update repository URLs to BYK/loreai after rename by @BYK in [#86](https://github.com/BYK/loreai/pull/86)
- Rename opencode-lore to @loreai/opencode with legacy mirror by @BYK in [#81](https://github.com/BYK/loreai/pull/81)
- Multi-package release pipeline for @loreai scope by @BYK in [#79](https://github.com/BYK/loreai/pull/79)
- Split into @loreai/core + opencode-lore monorepo by @BYK in [#71](https://github.com/BYK/loreai/pull/71)

## 0.9.1

### Bug Fixes 🐛

- Sanitize unpaired Unicode surrogates in recall and temporal storage by @BYK in [#68](https://github.com/BYK/opencode-lore/pull/68)
- Resilient worker prompting with agent-not-found retry by @BYK in [#67](https://github.com/BYK/opencode-lore/pull/67)

## 0.9.0

### New Features ✨

- Lat.md integration, knowledge cross-references, and integrity checking by @BYK in [#65](https://github.com/BYK/opencode-lore/pull/65)

## 0.8.0

### New Features ✨

- Content-aware deduplication pre-pass in gradient transform by @BYK in [#60](https://github.com/BYK/opencode-lore/pull/60)
- Multi-provider embeddings, distillation vector search, and cross-project recall by @BYK in [#58](https://github.com/BYK/opencode-lore/pull/58)

### Bug Fixes 🐛

- Switch publish workflow to Node 24, drop broken npm upgrade step by @BYK in [#62](https://github.com/BYK/opencode-lore/pull/62)
- Lower curation threshold, add per-session tracking, and improve observability by @BYK in [#56](https://github.com/BYK/opencode-lore/pull/56)

## 0.7.1

### Bug Fixes 🐛

- Sanitize pending/running tool parts to prevent orphaned tool_use by @BYK in [#54](https://github.com/BYK/opencode-lore/pull/54)

## 0.7.0

### New Features ✨

- Add Voyage AI embedding search by @BYK in [#50](https://github.com/BYK/opencode-lore/pull/50)
- Add search config surface and LLM query expansion by @BYK in [#49](https://github.com/BYK/opencode-lore/pull/49)
- Replace forSession() scoring with FTS5 BM25 by @BYK in [#48](https://github.com/BYK/opencode-lore/pull/48)
- Add RRF score fusion and rewrite recall tool by @BYK in [#47](https://github.com/BYK/opencode-lore/pull/47)
- Improve FTS5 search foundations by @BYK in [#46](https://github.com/BYK/opencode-lore/pull/46)

### Bug Fixes 🐛

- Catch unhandled exceptions in transform hooks and avoid loading embedding BLOBs by @BYK in [#52](https://github.com/BYK/opencode-lore/pull/52)
- Auto-enable embeddings when VOYAGE_API_KEY is set by @BYK in [#51](https://github.com/BYK/opencode-lore/pull/51)

## 0.6.2

### Bug Fixes 🐛

- Prevent EROFS crash when launched outside a git repo by @BYK in [#43](https://github.com/BYK/opencode-lore/pull/43)
- Cache LTM per session to preserve prompt cache hit rate by @BYK in [#42](https://github.com/BYK/opencode-lore/pull/42)

## 0.6.1

### Bug Fixes 🐛

- Rotate worker sessions after each LLM call and add recall error handling by @BYK in [#38](https://github.com/BYK/opencode-lore/pull/38)

## 0.6.0

### New Features ✨

- Research-informed compaction improvements by @BYK in [#35](https://github.com/BYK/opencode-lore/pull/35)

### Bug Fixes 🐛

- Prevent cross-project knowledge entries from leaking into AGENTS.md by @BYK in [#36](https://github.com/BYK/opencode-lore/pull/36)

## 0.5.3

### Bug Fixes 🐛

- Prevent excessive background LLM requests causing rate limiting and sluggishness by @BYK in [#33](https://github.com/BYK/opencode-lore/pull/33)
- Upgrade zod from v3 to v4 by @BYK in [#32](https://github.com/BYK/opencode-lore/pull/32)
- Drop trailing pure-text assistant messages at layer 0 too by @BYK in [#31](https://github.com/BYK/opencode-lore/pull/31)
- Isolate test suite from live lore DB via LORE_DB_PATH preload by @BYK in [b96cb956](https://github.com/BYK/opencode-lore/commit/b96cb95629cdd8257290e1d36932cc67fbce0a2b)

### Internal Changes 🔧

- Remove leaked test fixture entries from AGENTS.md by @BYK in [54dbae18](https://github.com/BYK/opencode-lore/commit/54dbae1832959aff8f513c23338585ed4b18dec7)

## 0.5.2

### Bug Fixes 🐛

- Make AGENTS.md export merge-friendly with sorted entries and blank line separators by @BYK in [#28](https://github.com/BYK/opencode-lore/pull/28)

### Other

- release: 0.5.2 by @BYK in [#29](https://github.com/BYK/opencode-lore/pull/29)

## 0.5.1

- Suppress informational log messages in TUI mode by @BYK in [#26](https://github.com/BYK/opencode-lore/pull/26)

## 0.5.0

### New Features ✨

- Add knowledge.enabled option to disable LTM system by @BYK in [#23](https://github.com/BYK/opencode-lore/pull/23)

## 0.4.4

### Bug Fixes 🐛

- (gradient) Persist forceMinLayer and auto-recover from context overflow by @BYK in [#21](https://github.com/BYK/opencode-lore/pull/21)

## 0.4.3

### Bug Fixes 🐛

- (gradient) Apply safety multiplier to uncalibrated layer-0 check by @BYK in [452c013a](https://github.com/BYK/opencode-lore/commit/452c013a492c097003142ad0ec34ce09889d0ced)

## 0.4.2

### Bug Fixes 🐛

- (agents-file) Self-heal duplicate lore sections and support old marker variants by @BYK in [aa83eb00](https://github.com/BYK/opencode-lore/commit/aa83eb003a682dff8a4e7415abbb5a07e2f9f189)

### Internal Changes 🔧

- (agents-file) Clean up fixed-UUID entries in afterAll to prevent ltm test collisions by @BYK in [f5c43486](https://github.com/BYK/opencode-lore/commit/f5c4348634b05a25458a1f1b9b135c2e7f5a383b)

## 0.4.1

### Bug Fixes 🐛

- (agents-file) Always commit agents file, soften auto-maintained wording by @BYK in [e5918a65](https://github.com/BYK/opencode-lore/commit/e5918a65da36ec31c7f307786a1561c8e1c296ab)
- (gradient) Use chars/3 estimation and fix calibration to use compressed window estimate by @BYK in [e2287a20](https://github.com/BYK/opencode-lore/commit/e2287a2073ff51691cecf615d4c65b02faac612b)

## 0.4.0

### New Features ✨

- (ltm) Tighten entry budget, add consolidation pass by @BYK in [74728df1](https://github.com/BYK/opencode-lore/commit/74728df154a47529ceee418ddeaf7baf0e5aa38a)

### Internal Changes 🔧

- Use Craft composite action with app token for release by @BYK in [48b7a858](https://github.com/BYK/opencode-lore/commit/48b7a858679ebddc84f6a3b90f3c75dcb0326b39)
- Use Craft reusable workflow for release by @BYK in [2ed8af27](https://github.com/BYK/opencode-lore/commit/2ed8af27ff89f16b76fecc5d5ac9886ec81956d2)

## 0.3.9

### Internal Changes 🔧

- Use Craft github artifact provider and oidc: true for npm target by @BYK in [d0dc35aa](https://github.com/BYK/opencode-lore/commit/d0dc35aacbff2981f994e27932da3a3e9e2c6f3f)
- Use Craft npm target with OIDC, pack tarball on release branches by @BYK in [68e650a4](https://github.com/BYK/opencode-lore/commit/68e650a4f919d856e62c39d52e62135ad92fa643)

## 0.3.7

- No documented changes.

## 0.3.6

### Bug Fixes 🐛

- (ci) Keep registry-url but strip \_authToken for OIDC auto-detection by @BYK in [15085e37](https://github.com/BYK/opencode-lore/commit/15085e37ed2980ca204b1be6050b051125fa6fcc)

## 0.3.5

### Bug Fixes 🐛

- (ci) Remove registry-url from setup-node to let npm use native OIDC by @BYK in [9802054b](https://github.com/BYK/opencode-lore/commit/9802054b92f1f69a67969f25d50bf8bc58389bee)

## 0.3.4

### Bug Fixes 🐛

- (ci) Upgrade npm for OIDC trusted publishing (requires >=11.5.1) by @BYK in [42b2935b](https://github.com/BYK/opencode-lore/commit/42b2935b2da1d57b1c3988c6463e75983d55a9bf)

## 0.3.3

### Bug Fixes 🐛

#### Ci

- Use vars.APP_ID and github.token for failure steps by @BYK in [a6e1adae](https://github.com/BYK/opencode-lore/commit/a6e1adaef2285eaf062c5225c0f345aaf9c8a4d7)
- Stage CHANGELOG.md in preReleaseCommand and use PAT for tag creation by @BYK in [7461fa63](https://github.com/BYK/opencode-lore/commit/7461fa635247d06b321a7ed45ecf1b0468a004be)
- Checkout release branch for CHANGELOG.md and set git identity by @BYK in [30a318e6](https://github.com/BYK/opencode-lore/commit/30a318e68e121635f4ccea7b18ad311c94027240)
- Set artifactProvider to none for github-only target by @BYK in [87dafec1](https://github.com/BYK/opencode-lore/commit/87dafec1b4065ab0a4c81afd585d1d59742bfd1d)
- Wrap preReleaseCommand in bash for env var expansion by @BYK in [2dce6728](https://github.com/BYK/opencode-lore/commit/2dce67289e6705ee59da31edcee4485df0da9633)
- Revert to github-only Craft target with separate npm OIDC publish by @BYK in [a5646f0a](https://github.com/BYK/opencode-lore/commit/a5646f0abf25cd39d3be87153b4ff99c35bae2ef)
- Remove registry-url from setup-node to avoid OIDC interference by @BYK in [4f04d3c7](https://github.com/BYK/opencode-lore/commit/4f04d3c7a62191288c3b26f90963297c0cd491f6)
- Upgrade npm for OIDC trusted publishing (requires >=11.5.1) by @BYK in [ceeccf00](https://github.com/BYK/opencode-lore/commit/ceeccf00d944bc89f8b324bb22148e5eb62793b9)
- Configure artifact provider for npm tarball lookup by @BYK in [697a98cf](https://github.com/BYK/opencode-lore/commit/697a98cf73316ca1e0643df18b3abf3e5636616f)
- Add actions:read permission for artifact download by @BYK in [cc05628c](https://github.com/BYK/opencode-lore/commit/cc05628c504bf6de3ecf2c7938c71dc386c98638)
- Resolve version from Craft output instead of branch name by @BYK in [bd53d77c](https://github.com/BYK/opencode-lore/commit/bd53d77cdaa2e40e852a418a35b23fe6f22be169)
- Add production environment to release job for PAT access by @BYK in [f3a6ebd5](https://github.com/BYK/opencode-lore/commit/f3a6ebd50e28c377d407cfc4d00137cf6ac0a1e7)
- Use PAT for release branch push to trigger CI by @BYK in [b171b8c2](https://github.com/BYK/opencode-lore/commit/b171b8c225a884ea7cac56c36d660b056b8feaa6)
- Use composite action for release to get issues:write permission by @BYK in [8da99bc0](https://github.com/BYK/opencode-lore/commit/8da99bc0036f15d227931f624b27a15d6bcaa58b)
- Use Craft CLI directly instead of composite action by @BYK in [58dc4e87](https://github.com/BYK/opencode-lore/commit/58dc4e874dbca3b0772d5913d1b013e7f2425513)

### Documentation 📚

- Add conventional commits convention to AGENTS.md by @BYK in [3dec8769](https://github.com/BYK/opencode-lore/commit/3dec876938abeb5b65d846ebd428335dc0d7463d)

### Internal Changes 🔧

- Use GitHub App token for release and publish workflows by @BYK in [3b8d87d7](https://github.com/BYK/opencode-lore/commit/3b8d87d7b66209e513b9f26ba279968f93b96b10)
- Upload npm tarball artifact on release branches by @BYK in [9d700397](https://github.com/BYK/opencode-lore/commit/9d700397c22f57b533f4ee44e23b7f16134a14c5)
- Run CI on release branches for Craft status checks by @BYK in [067d1205](https://github.com/BYK/opencode-lore/commit/067d12052ec5689a3cac7807c2336544fc4055a5)
- Use Craft npm target with OIDC trusted publishing by @BYK in [20c1be34](https://github.com/BYK/opencode-lore/commit/20c1be34864604257794df9a7c9cc1f4e27eb992)
- Upgrade to Craft 2.22 reusable workflow with accepted-label publish flow by @BYK in [7261873b](https://github.com/BYK/opencode-lore/commit/7261873b079efa4e3dfa9b56aa8f28d31a8740af)
- Add Craft release workflow with npm trusted publishing by @BYK in [6b0ad08b](https://github.com/BYK/opencode-lore/commit/6b0ad08b67e5fc4deb6065a09136498e2c01a469)

