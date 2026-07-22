# Changelog
## 0.38.0

### New Features ✨

#### Cch

- Add seeds for Claude Code up to 2.1.217 by @github-actions in [#1440](https://github.com/BYK/loreai/pull/1440)
- Add seeds for Claude Code up to 2.1.216 by @github-actions in [#1419](https://github.com/BYK/loreai/pull/1419)
- Add seeds for Claude Code up to 2.1.215 by @github-actions in [#1384](https://github.com/BYK/loreai/pull/1384)
- Add seeds for Claude Code up to 2.1.214 by @github-actions in [#1375](https://github.com/BYK/loreai/pull/1375)
- Add seeds for Claude Code up to 2.1.212 by @github-actions in [#1356](https://github.com/BYK/loreai/pull/1356)
- Add seeds for Claude Code up to 2.1.211 by @github-actions in [#1347](https://github.com/BYK/loreai/pull/1347)
- Add seeds for Claude Code up to 2.1.210 by @github-actions in [#1339](https://github.com/BYK/loreai/pull/1339)
- Add seeds for Claude Code up to 2.1.209 by @github-actions in [#1324](https://github.com/BYK/loreai/pull/1324)
- Add seeds for Claude Code up to 2.1.207 by @github-actions in [#1258](https://github.com/BYK/loreai/pull/1258)
- Add seeds for Claude Code up to 2.1.206 by @github-actions in [#1242](https://github.com/BYK/loreai/pull/1242)
- Add seeds for Claude Code up to 2.1.205 by @github-actions in [#1232](https://github.com/BYK/loreai/pull/1232)
- Add seeds for Claude Code up to 2.1.204 by @github-actions in [#1219](https://github.com/BYK/loreai/pull/1219)
- Add seeds for Claude Code up to 2.1.202 by @github-actions in [#1199](https://github.com/BYK/loreai/pull/1199)

#### Cli

- `lore admin grant` operator command for tier promotion (#827) by @BYK in [#1364](https://github.com/BYK/loreai/pull/1364)
- `lore data vacuum` to reclaim the bloated DB file (#1221) by @BYK in [#1226](https://github.com/BYK/loreai/pull/1226)
- Lore log / lore diff — surface knowledge version history (#962) by @BYK in [#1218](https://github.com/BYK/loreai/pull/1218)

#### Core

- Semantic linter funnel — diff-vs-invariant judge, filters, gate logic by @BYK in [#1361](https://github.com/BYK/loreai/pull/1361)
- Persist raw input/output token buckets in session_state by @BYK in [#1332](https://github.com/BYK/loreai/pull/1332)
- Relevance floor for session knowledge (stop off-task surfacing) by @BYK in [#1318](https://github.com/BYK/loreai/pull/1318)
- Default knowledge.contextSources to ["distillation"] for reliable cross-session fact application by @BYK in [#1293](https://github.com/BYK/loreai/pull/1293)
- High-salience 'Established facts' block in system[2] for reliable application on weaker models by @BYK in [#1276](https://github.com/BYK/loreai/pull/1276)
- Self-heal a latched local embedding provider via periodic re-probe by @BYK in [#1275](https://github.com/BYK/loreai/pull/1275)
- Client key rotation — epoch-aware DEKs + rotateScopeKey + seal/open (E-4c-3b, #827) by @BYK in [#1273](https://github.com/BYK/loreai/pull/1273)
- Group DEK wrapping + mint-safe member scope-key reads (E-4c-2, #827) by @BYK in [#1267](https://github.com/BYK/loreai/pull/1267)
- Passive 'facts just there' — fold relevance-ranked distillation+temporal into system[2] (#961) by @BYK in [#1228](https://github.com/BYK/loreai/pull/1228)
- Automatic free-page reclaim on the idle tick (#1221) by @BYK in [#1227](https://github.com/BYK/loreai/pull/1227)
- Throttle the temporal re-chunk backfill CPU on constrained hosts by @BYK in [#1184](https://github.com/BYK/loreai/pull/1184)
- Local knowledge version compaction + de-CASCADE ref FKs (#909) by @BYK in [#1213](https://github.com/BYK/loreai/pull/1213)
- Objective, justifier-free coding-agent degradation signals (#961) by @BYK in [#1185](https://github.com/BYK/loreai/pull/1185)

#### Eval

- Decision-evolution + negative-control recall scenario (#1403) by @BYK in [#1431](https://github.com/BYK/loreai/pull/1431)
- Offline no-spend context-rot A/B from recorded results (#961) by @BYK in [#1202](https://github.com/BYK/loreai/pull/1202)
- Objective retrieval scoring, separated from the LLM judge (#961) by @BYK in [#1186](https://github.com/BYK/loreai/pull/1186)

#### Gateway

- Wire discover→invite + auto-deploy Edge Functions (E-5-d-2, #630) by @BYK in [#1396](https://github.com/BYK/loreai/pull/1396)
- Email team invites via SMTP2GO (E-5-e, #630/#827) by @BYK in [#1392](https://github.com/BYK/loreai/pull/1392)
- GitHub repo-collaborator discovery (#630, E-5-d Slice 1) by @BYK in [#1388](https://github.com/BYK/loreai/pull/1388)
- Route GitHub Models for the semantic-linter judge (#1368) by @BYK in [#1373](https://github.com/BYK/loreai/pull/1373)
- `lore invariant-check` CLI command by @BYK in [#1362](https://github.com/BYK/loreai/pull/1362)
- Friendlier hint for pass-through 429 on OAuth sessions by @BYK in [#1369](https://github.com/BYK/loreai/pull/1369)
- Route OpenRouter worker calls to the cheapest provider (:floor) by @BYK in [#1349](https://github.com/BYK/loreai/pull/1349)
- Log subagent flag + resolved LTM budget for one-grep triage by @BYK in [#1336](https://github.com/BYK/loreai/pull/1336)
- Materiality gate for knowledge-delta emission by @BYK in [#1328](https://github.com/BYK/loreai/pull/1328)
- Github-provision Edge Function + login wiring (E-5-a-2, #827) by @BYK in [#1316](https://github.com/BYK/loreai/pull/1316)
- Tell the agent Lore manages the context window by @BYK in [#1303](https://github.com/BYK/loreai/pull/1303)
- Lore team CLI + team scope_keys sync (E-4c-4, #827) by @BYK in [#1278](https://github.com/BYK/loreai/pull/1278)
- Surface degraded memory (embeddings + workers) via /health and lore doctor by @BYK in [#1274](https://github.com/BYK/loreai/pull/1274)
- Publish identity public key to the directory (E-3b, #827) by @BYK in [#1260](https://github.com/BYK/loreai/pull/1260)
- Telemetry for empty completions returned to the client by @BYK in [#1205](https://github.com/BYK/loreai/pull/1205)
- Env-gated warmup cache-divergence probe by @BYK in [#1200](https://github.com/BYK/loreai/pull/1200)

#### Import

- Native mem0 connector for the structured-import lane by @BYK in [#1417](https://github.com/BYK/loreai/pull/1417)
- Structured-memory import lane for migrating Engram memory by @BYK in [#1415](https://github.com/BYK/loreai/pull/1415)
- Worktree-aware detection + multi-agent selection by @BYK in [#1344](https://github.com/BYK/loreai/pull/1344)

#### Invariant Check

- --effort knob + invariantCheck.effort config by @BYK in [#1393](https://github.com/BYK/loreai/pull/1393)
- Prose-tolerant judge parsing + unparseable visibility by @BYK in [#1390](https://github.com/BYK/loreai/pull/1390)

#### Supabase

- GitHub Teams provisioning RPC + schema (E-5-a-1, #827) by @BYK in [#1313](https://github.com/BYK/loreai/pull/1313)
- Pin membership/role helper oracles to self (E, #827) by @BYK in [#1286](https://github.com/BYK/loreai/pull/1286)
- Multi-epoch scope_keys + atomic rotate_scope_key (E-4c-3a, #827) by @BYK in [#1271](https://github.com/BYK/loreai/pull/1271)
- Team lifecycle RPCs — create/add/remove/set-role (E-4c-1, #827) by @BYK in [#1264](https://github.com/BYK/loreai/pull/1264)
- Enforce_row_quota membership guard + effective_tier (E-4b, #827) by @BYK in [#1263](https://github.com/BYK/loreai/pull/1263)
- Per-verb write-gate — viewers read, editors/admins write (E-4a, #827) by @BYK in [#1262](https://github.com/BYK/loreai/pull/1262)
- Identity_pub directory + member-aware scope_keys RLS (E-3a, #827) by @BYK in [#1259](https://github.com/BYK/loreai/pull/1259)
- Membership-based content RLS (E-2, #827) by @BYK in [#1257](https://github.com/BYK/loreai/pull/1257)
- Org → scope registry + FK relax (E-1, #827) by @BYK in [#1256](https://github.com/BYK/loreai/pull/1256)
- Enforce append-only on temporal_messages (D-3a, #826) by @BYK in [#1243](https://github.com/BYK/loreai/pull/1243)
- Pro-tier remote mirror for distillations + temporal (D-1, #826) by @BYK in [#1240](https://github.com/BYK/loreai/pull/1240)
- Server-side tombstone reaper (#909) by @BYK in [#1233](https://github.com/BYK/loreai/pull/1233)
- Raise free-tier entity-graph caps (#1221 follow-up) by @BYK in [#1230](https://github.com/BYK/loreai/pull/1230)
- Server-side recency eviction for entity_aliases + entity_relations (#1191b PR2a) by @BYK in [#1206](https://github.com/BYK/loreai/pull/1206)
- Server-side continuous top-N eviction for knowledge (#1191b PR1) by @BYK in [#1203](https://github.com/BYK/loreai/pull/1203)

#### Sync

- Domain auto-join (Model B: verified-admin claim + approve-on-join) (E-5-b, #827) by @BYK in [#1354](https://github.com/BYK/loreai/pull/1354)
- Offline (--offline) team invites with ephemeral key delivery (E-5-c-2, #827) by @BYK in [#1352](https://github.com/BYK/loreai/pull/1352)
- Direct email team invites with zero-follow-up DEK sharing (E-5-c-1, #827) by @BYK in [#1346](https://github.com/BYK/loreai/pull/1346)
- Encrypt entity-graph content columns on the wire (C-4, #825) by @BYK in [#1341](https://github.com/BYK/loreai/pull/1341)
- Re-enqueue the linked entity graph on team approval (#1307) by @BYK in [#1311](https://github.com/BYK/loreai/pull/1311)
- Decrypt each pulled row with its own scope's DEK (E-5-F2, #827) by @BYK in [#1310](https://github.com/BYK/loreai/pull/1310)
- Resolve team scope + migrate knowledge & entity graph on promotion (E-5-F3-3, #827) by @BYK in [#1304](https://github.com/BYK/loreai/pull/1304)
- Project→team-scope binding + promotion policy plumbing (E-5-F3-1, #827) by @BYK in [#1296](https://github.com/BYK/loreai/pull/1296)
- Pull-only mirror of the org/scope registry (E-5 foundation, #827) by @BYK in [#1290](https://github.com/BYK/loreai/pull/1290)
- Gate Pro fanout (distillations + temporal) on git_remote (P2c, #1246) by @BYK in [#1253](https://github.com/BYK/loreai/pull/1253)
- Gate indirect child content on parent syncability (P2b, #1246) by @BYK in [#1252](https://github.com/BYK/loreai/pull/1252)
- Gate knowledge + entities content on git_remote (P2a, #1246) by @BYK in [#1251](https://github.com/BYK/loreai/pull/1251)
- Cross-device project-identity mapping (P1, #1246) by @BYK in [#1247](https://github.com/BYK/loreai/pull/1247)
- Restore-residency for pulled temporal messages (D-4a, #826) by @BYK in [#1245](https://github.com/BYK/loreai/pull/1245)
- Arm Pro-tier distillation + temporal backup, client side (D-3b, #826) by @BYK in [#1244](https://github.com/BYK/loreai/pull/1244)
- Tier-aware synced-table selection (D-2, #826) by @BYK in [#1241](https://github.com/BYK/loreai/pull/1241)
- Safe-reap watermark so no active device misses a deletion (#909) by @BYK in [#1235](https://github.com/BYK/loreai/pull/1235)
- Server-side entity eviction via synced sync_rank (#1191b PR2b) by @BYK in [#1207](https://github.com/BYK/loreai/pull/1207)
- Seed knowledge_meta for live entries only (JOIN knowledge_current) by @BYK in [#1198](https://github.com/BYK/loreai/pull/1198)
- Align the knowledge_meta seed with knowledge's value order by @BYK in [#1196](https://github.com/BYK/loreai/pull/1196)
- Value-rank the entity-graph seed (entities/aliases/relations) — #1191a by @BYK in [#1194](https://github.com/BYK/loreai/pull/1194)
- Show initial-sync progress — "Performing initial sync…" with a live bar by @BYK in [#1192](https://github.com/BYK/loreai/pull/1192)
- Seed the outbox by value so a capped free tier syncs the most useful knowledge first by @BYK in [#1189](https://github.com/BYK/loreai/pull/1189)

#### Upgrade

- Sentry tracing + metrics for the delta-upgrade path by @BYK in [#1443](https://github.com/BYK/loreai/pull/1443)
- TTY progress bars for delta-patch apply and full download by @BYK in [#1442](https://github.com/BYK/loreai/pull/1442)

#### Other

- (core,gateway) Persist per-bucket worker cost breakdown for cost observability by @BYK in [#1268](https://github.com/BYK/loreai/pull/1268)
- (distillation) Reduce oversized user blobs by embedding relevance by @BYK in [#1351](https://github.com/BYK/loreai/pull/1351)
- (gradient) Per-model quality knee from config + literature-seeded family table (#1404) by @BYK in [#1410](https://github.com/BYK/loreai/pull/1410)
- (knowledge) Let the curator re-title an entry whose scope broadened by @BYK in [#1422](https://github.com/BYK/loreai/pull/1422)
- (ltm) Per-entry team-promotion review gate + review CLI (E-5-F3-2, #827) by @BYK in [#1298](https://github.com/BYK/loreai/pull/1298)
- (opencode) Flag Task sub-agents to the gateway (x-parent-session-id) by @BYK in [#1309](https://github.com/BYK/loreai/pull/1309)
- (pattern-extract) Gate noisy titles so seeds stay discoverable by @BYK in [#1416](https://github.com/BYK/loreai/pull/1416)
- (provenance) Capture tool_calls.input_path (file-provenance foundation) by @BYK in [#1424](https://github.com/BYK/loreai/pull/1424)
- (recall) Surface resolved code anchors + discoverable-title guidance by @BYK in [#1414](https://github.com/BYK/loreai/pull/1414)
- (website) Add system-preference dark mode to marketing pages by @BYK in [#1319](https://github.com/BYK/loreai/pull/1319)

### Bug Fixes 🐛

#### Build

- Embed only the target platform's native assets per binary by @BYK in [#1449](https://github.com/BYK/loreai/pull/1449)
- Serialize SEA binary injects to avoid postject WASM race by @BYK in [#1447](https://github.com/BYK/loreai/pull/1447)

#### Core

- Record stated facts neutrally, strip turn-scoped 'don't act on this' framing (#1383) by @BYK in [#1391](https://github.com/BYK/loreai/pull/1391)
- Fall back to WASM ONNX runtime when native can't load the model (#1379) by @BYK in [#1387](https://github.com/BYK/loreai/pull/1387)
- Drain in-flight distillation embeds on shutdown + warm-start worker (#1331) by @BYK in [#1385](https://github.com/BYK/loreai/pull/1385)
- FTS fallback for passive context-sources (#961 Gap 2b) by @BYK in [#1378](https://github.com/BYK/loreai/pull/1378)
- Pin vec0 storage-mode read across cutover race (no such column: embedding) by @BYK in [#1355](https://github.com/BYK/loreai/pull/1355)
- GetLtmBudget ceiling caps only the floor + stabilize small windows by @BYK in [#1306](https://github.com/BYK/loreai/pull/1306)
- Make LTM budget context-aware and sub-agent-aware by @BYK in [#1302](https://github.com/BYK/loreai/pull/1302)
- Key project identity on origin, not upstream by @BYK in [#1301](https://github.com/BYK/loreai/pull/1301)
- Fire remote-backfill reseed event from backfillGitRemotes by @BYK in [#1285](https://github.com/BYK/loreai/pull/1285)
- Fail fast with an actionable error when SQLite lacks FTS5 by @BYK in [#1266](https://github.com/BYK/loreai/pull/1266)
- Batch instruction-detect cross-session FTS into one query by @BYK in [#1265](https://github.com/BYK/loreai/pull/1265)
- Fast-first-retry backoff for embedding init failures by @BYK in [#1229](https://github.com/BYK/loreai/pull/1229)
- Checkpoint the SQLite WAL so it can't grow unbounded (#1221) by @BYK in [#1225](https://github.com/BYK/loreai/pull/1225)
- Declare onnxruntime-node + sharp as optional deps so the plugin worker resolves the native ONNX backend by @BYK in [#1223](https://github.com/BYK/loreai/pull/1223)
- Scope knowledge vector search to the current project (cross-project leak) by @BYK in [#1208](https://github.com/BYK/loreai/pull/1208)

#### Deps

- Clear all 15 open Dependabot alerts by @BYK in [#1423](https://github.com/BYK/loreai/pull/1423)
- Override qs to >=6.15.2 to fix DoS (GHSA-q8mj-m7cp-5q26) by @BYK in [#1224](https://github.com/BYK/loreai/pull/1224)

#### Gateway

- ChatGPT-backend workers reuse session model; prefer gpt-5.6-luna for real openai by @BYK in [#1437](https://github.com/BYK/loreai/pull/1437)
- True-streaming passthrough for codex/openai-responses main turn by @BYK in [#1435](https://github.com/BYK/loreai/pull/1435)
- Raise default reasoning budget 8192 → 16384 (land curator on attempt 1) by @BYK in [#1430](https://github.com/BYK/loreai/pull/1430)
- Reasoning floor keys off any reasoning capability, not toggle-only by @BYK in [#1426](https://github.com/BYK/loreai/pull/1426)
- Reasoning-headroom floor for OpenAI-protocol workers (no explicit effort) by @BYK in [#1418](https://github.com/BYK/loreai/pull/1418)
- Worker reasoning-truncation — align OpenAI budget + retry-on-length by @BYK in [#1413](https://github.com/BYK/loreai/pull/1413)
- Lineage-aware worker model selection + data-policy 404 auto-recovery by @BYK in [#1407](https://github.com/BYK/loreai/pull/1407)
- Surface reasoning-only worker completions from the OpenAI SSE path (#1334) by @BYK in [#1386](https://github.com/BYK/loreai/pull/1386)
- Provider-aware worker key scheme — Bearer for GitHub Models (Seer #1373) by @BYK in [#1376](https://github.com/BYK/loreai/pull/1376)
- Defer lore-run auto-import until a credential is available by @BYK in [#1366](https://github.com/BYK/loreai/pull/1366)
- Scope worker-incapable streak per worker + derive degradation cause by @BYK in [#1342](https://github.com/BYK/loreai/pull/1342)
- Inject knowledge-delta as a user→assistant pair (stop M3 acknowledging it) by @BYK in [#1315](https://github.com/BYK/loreai/pull/1315)
- Stabilize OpenAI content shape to stop per-turn cache busts by @BYK in [#1327](https://github.com/BYK/loreai/pull/1327)
- Cache accounting on the codex-worker Responses path by @BYK in [#1326](https://github.com/BYK/loreai/pull/1326)
- Parse cache-write tokens on the OpenAI/OpenRouter response path by @BYK in [#1322](https://github.com/BYK/loreai/pull/1322)
- Emit cache_control on the OpenAI/OpenRouter request path by @BYK in [#1321](https://github.com/BYK/loreai/pull/1321)
- Lore doctor treats intentionally-disabled embeddings as PASS, not WARN by @BYK in [#1284](https://github.com/BYK/loreai/pull/1284)
- Don't escalate credential-class worker failures to Sentry (3J) by @BYK in [#1269](https://github.com/BYK/loreai/pull/1269)
- Don't flood WARN logs on expected orphan pull-skips by @BYK in [#1222](https://github.com/BYK/loreai/pull/1222)
- Make cost-tracker auto-compact threshold client-metered-window aware by @BYK in [#1216](https://github.com/BYK/loreai/pull/1216)
- Don't let one orphan pull row abort the whole sync by @BYK in [#1215](https://github.com/BYK/loreai/pull/1215)
- Clamp client usage cap to 200K unless request enables context-1m by @BYK in [#1214](https://github.com/BYK/loreai/pull/1214)
- Stream buffered non-Anthropic upstreams to Anthropic clients (#1052) by @BYK in [#1212](https://github.com/BYK/loreai/pull/1212)
- Point the worker-degradation warning at `lore doctor` (not the non-existent `lore status`) by @BYK in [#1209](https://github.com/BYK/loreai/pull/1209)
- Accumulate mislabeled SSE completions through the stream accumulators by @BYK in [#1204](https://github.com/BYK/loreai/pull/1204)
- Route all *.githubcopilot.com hosts to /chat/completions by @BYK in [#1201](https://github.com/BYK/loreai/pull/1201)
- Tolerate mislabeled SSE when reading non-streaming completions by @BYK in [#1195](https://github.com/BYK/loreai/pull/1195)

#### Gradient

- Thread budget snapshot into isLargeColdStart to kill limits/knee race (#1401) by @BYK in [#1408](https://github.com/BYK/loreai/pull/1408)
- Fill-fraction quality model fixes cheap-cache compression (#961) by @BYK in [#1400](https://github.com/BYK/loreai/pull/1400)
- Force compression on degraded windows via graduated quality multiplier (#961) by @BYK in [#1370](https://github.com/BYK/loreai/pull/1370)

#### Import

- Read engram export from a file, not stdout (#1398) by @BYK in [#1438](https://github.com/BYK/loreai/pull/1438)
- Resolve mem0 embedded home dir cross-platform (os.homedir, not $HOME) by @BYK in [#1425](https://github.com/BYK/loreai/pull/1425)
- Make `lore import` authenticate + stop zero-result imports poisoning the auto-import gate by @BYK in [#1406](https://github.com/BYK/loreai/pull/1406)

#### Setup

- Don't crash lore doctor on an unreadable JSON backup sidecar by @BYK in [#1299](https://github.com/BYK/loreai/pull/1299)
- Store JSON config backup in a sidecar file, not a \_loreBackup key by @BYK in [#1297](https://github.com/BYK/loreai/pull/1297)

#### Supabase

- Revoke outstanding invite tokens on scope member removal (#1345, E-5-c F-2) by @BYK in [#1381](https://github.com/BYK/loreai/pull/1381)
- GitHub-provision role upgrade-on-resync + role validation (#1314 parts 2-4) by @BYK in [#1380](https://github.com/BYK/loreai/pull/1380)
- Detach team-org ownership on account deletion (#1314 part 1) by @BYK in [#1374](https://github.com/BYK/loreai/pull/1374)
- Drop unused idx_identity_pub_updated + document remaining advisors by @BYK in [#1340](https://github.com/BYK/loreai/pull/1340)
- Revoke default PUBLIC/anon EXECUTE on definer functions by @BYK in [#1338](https://github.com/BYK/loreai/pull/1338)
- Single SELECT policy on identity_pub (multiple_permissive_policies) by @BYK in [#1337](https://github.com/BYK/loreai/pull/1337)
- Pin empty search_path on flagged trigger functions by @BYK in [#1335](https://github.com/BYK/loreai/pull/1335)
- Wrap auth.<fn>() in RLS policies to fix initplan re-evaluation by @BYK in [#1333](https://github.com/BYK/loreai/pull/1333)

#### Sync

- Migrate an orphaned entity graph back to personal on team knowledge deletion (#1312, E-5-F3) by @BYK in [#1382](https://github.com/BYK/loreai/pull/1382)
- Propagate remote registry-mirror deletions via authoritative snapshot (#1294) by @BYK in [#1372](https://github.com/BYK/loreai/pull/1372)
- Reap orphaned ephemeral-invite scope_keys rows (#1353) by @BYK in [#1360](https://github.com/BYK/loreai/pull/1360)
- Recover sync_conflicts.local_content + surface real errors by @BYK in [#1325](https://github.com/BYK/loreai/pull/1325)
- Belt-and-suspenders gate on the temporal row's own project (#826) by @BYK in [#1255](https://github.com/BYK/loreai/pull/1255)
- Dedupe reseed of temporal referenced by multiple distillations (#1253) by @BYK in [#1254](https://github.com/BYK/loreai/pull/1254)
- Make projects delete-invisible so reconcile never tombstones the mapping (#1246) by @BYK in [#1248](https://github.com/BYK/loreai/pull/1248)
- Converge pulled entity_relations UNIQUE collisions instead of skipping (#1217) by @BYK in [#1236](https://github.com/BYK/loreai/pull/1236)
- Converge pulled entity_alias UNIQUE collisions instead of skipping (#1217) by @BYK in [#1234](https://github.com/BYK/loreai/pull/1234)
- Eviction polish — knowledge_meta cap headroom + relation cascade only when both endpoints gone (#1191b) by @BYK in [#1210](https://github.com/BYK/loreai/pull/1210)
- Classify PGRST schema errors as poison + route deletes through the classifier (#1188) by @BYK in [#1193](https://github.com/BYK/loreai/pull/1193)
- De-spam the quota-pause WARN — log once per pause, not every cycle by @BYK in [#1190](https://github.com/BYK/loreai/pull/1190)
- Don't send a phantom content_hash on join-table deletes (PGRST204) by @BYK in [#1187](https://github.com/BYK/loreai/pull/1187)
- Eager-mint the scope DEK at `lore sync enable` (#1182) by @BYK in [#1183](https://github.com/BYK/loreai/pull/1183)

#### Other

- (ci) Run semantic-linter via built CLI bundle, not tsx by @BYK in [#1377](https://github.com/BYK/loreai/pull/1377)
- (distill) Preserve leading user prose during blob reduction (#1343 follow-up) by @BYK in [#1367](https://github.com/BYK/loreai/pull/1367)
- (embedding) Bump onnxruntime-node 1.21.0 → 1.27.0 to fix Node 24 HandleScope crash by @BYK in [#1444](https://github.com/BYK/loreai/pull/1444)
- (eval) Decision-recall negative-control baseline must be "raw", not "no-memory" by @BYK in [#1433](https://github.com/BYK/loreai/pull/1433)
- (ltm) Run context-source fold even when the knowledge table is empty (#961) by @BYK in [#1432](https://github.com/BYK/loreai/pull/1432)
- (markdown) Converge normalize() for html-block-in-list divergence (#1357) by @BYK in [#1359](https://github.com/BYK/loreai/pull/1359)
- (onboarding) Provider-neutral import messages + first-run UX by @BYK in [#1439](https://github.com/BYK/loreai/pull/1439)
- (responses) Extract text from structured function_call_output.output by @BYK in [#1291](https://github.com/BYK/loreai/pull/1291)
- (team) Empty-discover guard + prod env for fn deploy + deflake reaper test (#1396/#1397) by @BYK in [#1399](https://github.com/BYK/loreai/pull/1399)

### Documentation 📚

- (gradient) Record #1404-B negative result — keep literature quality-knee priors (#1404) by @BYK in [#1441](https://github.com/BYK/loreai/pull/1441)
- (lint) Document why unbound-method and no-non-null-assertion stay warn by @BYK in [#1292](https://github.com/BYK/loreai/pull/1292)
- (website) Add 'Distill the knowledge, not the model' blog post by @BYK in [#1317](https://github.com/BYK/loreai/pull/1317)
- Semantic linter (CI invariant-check) guide by @BYK in [#1411](https://github.com/BYK/loreai/pull/1411)

### Internal Changes 🔧

#### Core

- Batch recordToolCalls tool_use seeds into one multi-row upsert (#1178 / 3G) by @BYK in [#1395](https://github.com/BYK/loreai/pull/1395)
- Direct coverage for WASM-respawn per-request error suppression (#1379 B2) by @BYK in [#1389](https://github.com/BYK/loreai/pull/1389)
- Fix stale getGitRemote docstring + non-vacuous upstream fallback by @BYK in [#1305](https://github.com/BYK/loreai/pull/1305)
- Memoize project path→id resolution per connection (3K) by @BYK in [#1272](https://github.com/BYK/loreai/pull/1272)

#### Gateway

- Remove dead string branch in OpenAI conversation breakpoint by @BYK in [#1330](https://github.com/BYK/loreai/pull/1330)
- Clarify OpenAI conversation-breakpoint content branch by @BYK in [#1329](https://github.com/BYK/loreai/pull/1329)
- Make context-note tests exercise a genuinely empty baseline by @BYK in [#1308](https://github.com/BYK/loreai/pull/1308)
- Unit coverage for lore team CLI (E-4c-4, #827) by @BYK in [#1280](https://github.com/BYK/loreai/pull/1280)
- Cover worker-cost-breakdown aggregation + UI rendering (#1268 follow-up) by @BYK in [#1270](https://github.com/BYK/loreai/pull/1270)
- Unit-cover publishIdentityPub (#1260 follow-up) by @BYK in [#1261](https://github.com/BYK/loreai/pull/1261)

#### Lint

- Enforce no-base-to-string (fix 102 unsafe stringifications) by @BYK in [#1288](https://github.com/BYK/loreai/pull/1288)
- Enforce restrict-template-expressions by @BYK in [#1283](https://github.com/BYK/loreai/pull/1283)
- Enforce no-explicit-any + no-redundant-type-constituents by @BYK in [#1282](https://github.com/BYK/loreai/pull/1282)
- Enforce no-unnecessary-type-assertion (−169 redundant casts) by @BYK in [#1281](https://github.com/BYK/loreai/pull/1281)
- Adopt oxc stack (oxlint + oxfmt), retire Biome by @BYK in [#1277](https://github.com/BYK/loreai/pull/1277)

#### Sync

- Unit coverage for E-5-c invite client + auto-wrap (#827) by @BYK in [#1350](https://github.com/BYK/loreai/pull/1350)
- Clean projects in the top-level engine beforeEach (#1246) by @BYK in [#1250](https://github.com/BYK/loreai/pull/1250)
- Tier-2 end-to-end project-identity restore round-trip (D-4b, #1246) by @BYK in [#1249](https://github.com/BYK/loreai/pull/1249)
- End-to-end encrypted knowledge round-trip through the real engine (#825) by @BYK in [#1181](https://github.com/BYK/loreai/pull/1181)

#### Other

- (ci) Format invariant-check report.mjs (oxfmt) by @BYK in [#1371](https://github.com/BYK/loreai/pull/1371)
- (import) Raise commandImport patch coverage to 100% by @BYK in [#1348](https://github.com/BYK/loreai/pull/1348)
- (lore) Update .lore.md knowledge by @BYK in [18db36d1](https://github.com/BYK/loreai/commit/18db36d142498e3f93772d0d183c5212f1febfcf)
- (upgrade) Speed up delta-patch apply on the 310MB binary by @BYK in [#1436](https://github.com/BYK/loreai/pull/1436)
- Bump Node 20 actions to Node 24 majors (deprecation) by @BYK in [#1394](https://github.com/BYK/loreai/pull/1394)
- Advisory semantic-linter GitHub Action + workflow by @BYK in [#1363](https://github.com/BYK/loreai/pull/1363)

### Other

- revert(core): remove no-op "Established facts" salience block (#1276) by @BYK in [#1287](https://github.com/BYK/loreai/pull/1287)

## 0.37.0

### New Features ✨

- (sync) Passphrase UX to activate knowledge encryption (C-4b, #825) by @BYK in [#1174](https://github.com/BYK/loreai/pull/1174)

### Bug Fixes 🐛

#### Core

- Break the temporal re-chunk livelock on a row that crashes the process by @BYK in [#1176](https://github.com/BYK/loreai/pull/1176)
- Bound embedding-pool memory to one pool-share of free RAM by @BYK in [#1175](https://github.com/BYK/loreai/pull/1175)
- Collapse per-entry outcomeImpact N+1 on the consolidation path by @BYK in [#1177](https://github.com/BYK/loreai/pull/1177)
- Self-heal a transient local-embedding init failure instead of latching by @BYK in [#1173](https://github.com/BYK/loreai/pull/1173)

#### Other

- (sync) Scope_keys.wrapped_dek first-write-wins on the server (#825) by @BYK in [#1179](https://github.com/BYK/loreai/pull/1179)

## 0.36.0

### New Features ✨

#### Cch

- Add seeds for Claude Code up to 2.1.201 by @github-actions in [#1164](https://github.com/BYK/loreai/pull/1164)
- Add seeds for Claude Code up to 2.1.200 by @github-actions in [#1160](https://github.com/BYK/loreai/pull/1160)
- Add seeds for Claude Code up to 2.1.199 by @github-actions in [#1154](https://github.com/BYK/loreai/pull/1154)

#### Core

- Local encryption key store + passphrase escrow (C-2, #825) by @BYK in [#1167](https://github.com/BYK/loreai/pull/1167)
- Auto-target CLAUDE.md for Claude Code, AGENTS.md otherwise by @BYK in [#1163](https://github.com/BYK/loreai/pull/1163)
- Client-side encryption primitives (C-1, #825) by @BYK in [#1162](https://github.com/BYK/loreai/pull/1162)
- Sync knowledge_meta as a convergent PN-counter register (A2 3b-2) by @BYK in [#941](https://github.com/BYK/loreai/pull/941)

#### Sync

- Client-side encryption of knowledge content (C-4, #825) by @BYK in [#1171](https://github.com/BYK/loreai/pull/1171)
- Remote mirror for the encryption key store (C-3, #825) by @BYK in [#1169](https://github.com/BYK/loreai/pull/1169)

#### Other

- (supabase) Remote knowledge_meta sync — arm cross-device confidence (A2 3b-2 remote half) by @BYK in [#1158](https://github.com/BYK/loreai/pull/1158)
- Native Google Gemini (generateContent) protocol + Gemini CLI support by @BYK in [#1159](https://github.com/BYK/loreai/pull/1159)
- Support GitHub Copilot CLI (`lore run` / `lore setup`) by @BYK in [#1157](https://github.com/BYK/loreai/pull/1157)

### Bug Fixes 🐛

#### Core

- Cap native ONNX intra-op threads to the cgroup CPU quota by @BYK in [#1170](https://github.com/BYK/loreai/pull/1170)
- Clamp embedding memory sizing to the cgroup limit (container OOM) by @BYK in [#1168](https://github.com/BYK/loreai/pull/1168)

#### Gateway

- Forward Claude Code side-channel calls upstream untouched by @BYK in [#1161](https://github.com/BYK/loreai/pull/1161)
- Stop mislabeling idle-resume tail growth as an "earlier message modified" edit by @BYK in [#1156](https://github.com/BYK/loreai/pull/1156)
- Cache breakpoint at the distilled-prefix boundary (stop mid-conversation busts collapsing to the ~54K head) by @BYK in [#1155](https://github.com/BYK/loreai/pull/1155)

### Internal Changes 🔧

#### Gateway

- Rebuild the npm bundle on demand instead of asserting against a stale one by @BYK in [#1165](https://github.com/BYK/loreai/pull/1165)
- Drop dead capitalized x-goog-api-key check by @BYK in [#1166](https://github.com/BYK/loreai/pull/1166)

## 0.35.0

### New Features ✨

#### Cch

- Add seeds for Claude Code up to 2.1.198 by @github-actions in [#1117](https://github.com/BYK/loreai/pull/1117)
- Add seeds for Claude Code up to 2.1.197 by @github-actions in [#1073](https://github.com/BYK/loreai/pull/1073)
- Add seeds for Claude Code up to 2.1.196 by @github-actions in [#1053](https://github.com/BYK/loreai/pull/1053)
- Add seeds for Claude Code up to 2.1.195 by @github-actions in [#1031](https://github.com/BYK/loreai/pull/1031)

#### Core

- Show cumulative temporal re-chunk progress in logs by @BYK in [#1152](https://github.com/BYK/loreai/pull/1152)
- Detect & surface knowledge contradictions — engine + CLI (#1123) by @BYK in [#1146](https://github.com/BYK/loreai/pull/1146)
- Make the local-embedding stack an optional dependency (#1026) by @BYK in [#1128](https://github.com/BYK/loreai/pull/1128)
- Re-chunk existing temporal messages into vec0 multi-vector on startup by @BYK in [#1087](https://github.com/BYK/loreai/pull/1087)
- Split read-path awaited timer into embed vs vectorSearch (#999) by @BYK in [#1074](https://github.com/BYK/loreai/pull/1074)
- Embed temporal messages as one vec0 chunk per part-aware unit by @BYK in [#1068](https://github.com/BYK/loreai/pull/1068)
- Harden vec0 rollout with a load-time KNN smoke guard by @BYK in [#1062](https://github.com/BYK/loreai/pull/1062)
- Collapse temporal chunk hits to max-sim message hits by @BYK in [#1063](https://github.com/BYK/loreai/pull/1063)
- Embed part-selective text for temporal messages by @BYK in [#1061](https://github.com/BYK/loreai/pull/1061)
- Cut vector storage over to FLAT vec0 with partition keys by @BYK in [#1051](https://github.com/BYK/loreai/pull/1051)
- Traverse the entity graph during recall (entity-graph fan-in) by @BYK in [#1047](https://github.com/BYK/loreai/pull/1047)

#### Gateway

- Npm bundle prefers native ONNX Runtime, falls back to WASM (2/3) by @BYK in [#1149](https://github.com/BYK/loreai/pull/1149)
- Contradictions banner on /ui/knowledge — resolve/dismiss (#1123) by @BYK in [#1147](https://github.com/BYK/loreai/pull/1147)
- Per-platform @loreai/onnxruntime-<os>-<arch> package generator (1/3) by @BYK in [#1148](https://github.com/BYK/loreai/pull/1148)
- Tag cache-bust metric with idle_resume (separate avoidable warm rewrites from free cold ones) by @BYK in [#1130](https://github.com/BYK/loreai/pull/1130)
- Binary smoke for the read-worker offload seam (#1029) by @BYK in [#1122](https://github.com/BYK/loreai/pull/1122)
- Runtime + UI toggle to disable cache warming by @BYK in [#1114](https://github.com/BYK/loreai/pull/1114)
- Surface warmup net (savings − cost) in cost log and UI by @BYK in [#1112](https://github.com/BYK/loreai/pull/1112)
- Idle-gate the temporal re-chunk backfill against live traffic by @BYK in [#1108](https://github.com/BYK/loreai/pull/1108)
- Resolve worker model to newest in family by @BYK in [#1086](https://github.com/BYK/loreai/pull/1086)
- Ship native sqlite-vec in the standalone binary by @BYK in [#1030](https://github.com/BYK/loreai/pull/1030)

#### Setup

- Add `lore setup hermes` handler (#648, part 2) by @BYK in [#1141](https://github.com/BYK/loreai/pull/1141)
- Add `lore setup pi` handler (#648, part 1) by @BYK in [#1139](https://github.com/BYK/loreai/pull/1139)

#### Website

- Prune orphaned standard.site document records by @BYK in [#1043](https://github.com/BYK/loreai/pull/1043)
- Implement the standard.site protocol for the blog by @BYK in [#1037](https://github.com/BYK/loreai/pull/1037)
- Add full-content RSS feed for the blog by @BYK in [#1035](https://github.com/BYK/loreai/pull/1035)

#### Other

- (release) Publish per-platform @loreai/onnxruntime-* packages (3/3) by @BYK in [#1150](https://github.com/BYK/loreai/pull/1150)
- (telemetry) P50/p95 vector KNN read-latency to confirm the vec0 win (#1065) by @BYK in [#1095](https://github.com/BYK/loreai/pull/1095)
- Vendor sqlite-vec 0.1.10 with DiskANN + rescore by @BYK in [#1038](https://github.com/BYK/loreai/pull/1038)

### Bug Fixes 🐛

#### Core

- Re-point vec0 partition keys when a session/project moves (#1138) by @BYK in [#1140](https://github.com/BYK/loreai/pull/1140)
- Reclaim vec0 orphans on non-prune base-row deletes (#1132) by @BYK in [#1137](https://github.com/BYK/loreai/pull/1137)
- Bound embedding cap by the fixed WASM heap ceiling (#999) by @BYK in [#1134](https://github.com/BYK/loreai/pull/1134)
- Drop pruned rows' vec0 chunks so orphans don't accumulate by @BYK in [#1129](https://github.com/BYK/loreai/pull/1129)
- Surface skipped-blob count + arm temporal walk on vec0 cutover by @BYK in [#1101](https://github.com/BYK/loreai/pull/1101)
- Silence transformers.js input-tensor dump on expected embed OOM by @BYK in [#1120](https://github.com/BYK/loreai/pull/1120)
- Drain distillation background work in tests (#885 DB-isolation flake) by @BYK in [#1116](https://github.com/BYK/loreai/pull/1116)
- Preserve warm prefix caches across idle resume by @BYK in [#1102](https://github.com/BYK/loreai/pull/1102)
- Checkpoint temporal re-chunk cursor per row + log backlog/progress by @BYK in [#1104](https://github.com/BYK/loreai/pull/1104)
- Skip stale-dimension blobs during vec0 cutover instead of aborting by @BYK in [#1098](https://github.com/BYK/loreai/pull/1098)
- Make temporal.prune resilient to db()-swap missing-table race (#1001) by @BYK in [#1071](https://github.com/BYK/loreai/pull/1071)
- Bound and sub-batch temporal multi-vector chunk fan-out (#1072) by @BYK in [#1075](https://github.com/BYK/loreai/pull/1075)

#### Gateway

- Don't re-anchor the durable delta on a warm idle resume (kills the #1 cache-bust) by @BYK in [#1151](https://github.com/BYK/loreai/pull/1151)
- Block cache warming for sessions under emergency compaction by @BYK in [#1121](https://github.com/BYK/loreai/pull/1121)
- Show historical cache-warming row when only a cost was incurred (Sentry bot) by @BYK in [#1118](https://github.com/BYK/loreai/pull/1118)
- Credit warmup hits pro-rata, not the full refreshed prefix by @BYK in [#1105](https://github.com/BYK/loreai/pull/1105)
- Extend worker temperature-deprecation handling to the batch path by @BYK in [#1110](https://github.com/BYK/loreai/pull/1110)
- Resolve worker capability from the canonical vendor (follow-up to #1109) by @BYK in [#1113](https://github.com/BYK/loreai/pull/1113)
- Gate temporal re-chunk backfill on embed-pool idle, not session activity by @BYK in [#1111](https://github.com/BYK/loreai/pull/1111)
- Stop sonnet-5 workers breaking (adaptive thinking + deprecated sampling), data-driven via models.dev by @BYK in [#1109](https://github.com/BYK/loreai/pull/1109)
- Drop deprecated temperature param on worker 400 by @BYK in [#1100](https://github.com/BYK/loreai/pull/1100)
- Surface real batch item errors instead of 'error: undefined' by @BYK in [#1099](https://github.com/BYK/loreai/pull/1099)
- Reconstruct zai worker path under /v4 instead of doubling /v1 (#1093) by @BYK in [#1097](https://github.com/BYK/loreai/pull/1097)
- Route reconstructed openai requests host-aware for Google (#1070) by @BYK in [#1076](https://github.com/BYK/loreai/pull/1076)
- Forward github-copilot to its real /chat/completions endpoint (#1052) by @BYK in [#1066](https://github.com/BYK/loreai/pull/1066)
- Scope upstream re-compression by destination origin (#1032) by @BYK in [#1064](https://github.com/BYK/loreai/pull/1064)
- Scope upstream re-compression to the client's provider (#1032) by @BYK in [#1059](https://github.com/BYK/loreai/pull/1059)
- Decode and re-compress zstd request bodies from Codex (#1032) by @BYK in [#1049](https://github.com/BYK/loreai/pull/1049)

#### Other

- (cost-tracker) Per-model auto-compact threshold for the avoided-compactions estimate (#983) by @BYK in [#1096](https://github.com/BYK/loreai/pull/1096)
- (embedding) Keep the worker thread's stderr off the host TUI by @BYK in [#1055](https://github.com/BYK/loreai/pull/1055)
- (pi) Stop the extension from corrupting Pi's TUI by @BYK in [#1036](https://github.com/BYK/loreai/pull/1036)
- (plugins) Keep the in-process gateway from corrupting the host TUI by @BYK in [#1050](https://github.com/BYK/loreai/pull/1050)
- (website) Cap standard.site document textContent size by @BYK in [#1045](https://github.com/BYK/loreai/pull/1045)

### Documentation 📚

#### Website

- Publish Lore memory-management principles post (#1125) by @BYK in [#1131](https://github.com/BYK/loreai/pull/1131)
- Frame Lore as continual learning in token space (#1124) by @BYK in [#1127](https://github.com/BYK/loreai/pull/1127)
- Tighten "Why memory is not enough" blog post by @BYK in [#1034](https://github.com/BYK/loreai/pull/1034)

#### Other

- (core) Clarify blob-fallback recency caps; note chunk-policy re-arm for future migrations by @BYK in [#1133](https://github.com/BYK/loreai/pull/1133)
- (gateway) Document verified `HERMES_INFERENCE_PROVIDER` behavior (#649) by @BYK in [#1142](https://github.com/BYK/loreai/pull/1142)

### Internal Changes 🔧

#### Core

- Rename WASM_SUSTAINABLE_MAX_TOKENS → EMBED_TOKEN_CEILING by @BYK in [#1145](https://github.com/BYK/loreai/pull/1145)
- Remove unused getOriginalFetch() accessor by @BYK in [#1119](https://github.com/BYK/loreai/pull/1119)
- Parallelize embedding into a memory-gated worker pool (#999) by @BYK in [#1115](https://github.com/BYK/loreai/pull/1115)
- Share fetch-interceptor original-fetch via Symbol.for global by @BYK in [#1103](https://github.com/BYK/loreai/pull/1103)
- Batch action-tag session counts into one distillations scan (#1023) by @BYK in [#1069](https://github.com/BYK/loreai/pull/1069)
- Chunk unbounded IN in offloaded alias-batch helpers (#1022) by @BYK in [#1067](https://github.com/BYK/loreai/pull/1067)
- Offload entity-graph knowledge hydration in recall (#1048) by @BYK in [#1057](https://github.com/BYK/loreai/pull/1057)
- De-flake embedding OOM recovery (env-independent start cap) by @BYK in [#1054](https://github.com/BYK/loreai/pull/1054)
- Vec storage-mode seam (read-mode + write helpers) by @BYK in [#1044](https://github.com/BYK/loreai/pull/1044)

#### Gateway

- Run native onnxruntime-node (not WASM) in the SEA binary by @BYK in [#1143](https://github.com/BYK/loreai/pull/1143)
- Inline @loreai/core into the Bun bundle, drop external-core dep by @BYK in [#1106](https://github.com/BYK/loreai/pull/1106)
- Memoize worker-model resolution per models.dev snapshot by @BYK in [#1094](https://github.com/BYK/loreai/pull/1094)
- Cover the off-thread read-worker vec path in --check-vec (#1033) by @BYK in [#1060](https://github.com/BYK/loreai/pull/1060)

#### Hermes

- Detect real ContextEngine ABC drift against installed hermes-agent (#1136) by @BYK in [#1144](https://github.com/BYK/loreai/pull/1144)
- Enforce the real ContextEngine ABC contract in CI (#1042) by @BYK in [#1135](https://github.com/BYK/loreai/pull/1135)
- Run the lore-hermes Python plugin tests in CI by @BYK in [#1040](https://github.com/BYK/loreai/pull/1040)

#### Ltm

- Offload peekProjectRefs knowledge scan to the read-worker pool by @BYK in [#1091](https://github.com/BYK/loreai/pull/1091)
- Offload forProject() scans to the read-worker pool by @BYK in [#1088](https://github.com/BYK/loreai/pull/1088)

#### Other

- (cache-analytics) Memoize normalized previous body across turns by @BYK in [#1085](https://github.com/BYK/loreai/pull/1085)
- (entities) Offload the project entity-catalog scan to the read-worker pool by @BYK in [#1089](https://github.com/BYK/loreai/pull/1089)
- (gradient) Pre-load the distillation snapshot off-thread before transform() by @BYK in [#1090](https://github.com/BYK/loreai/pull/1090)
- (pi) Exercise the extension against the real Pi runtime by @BYK in [#1046](https://github.com/BYK/loreai/pull/1046)
- (pi,opencode) Basic e2e tests for the plugin adapters by @BYK in [#1039](https://github.com/BYK/loreai/pull/1039)
- (pipeline) Batch post-response temporal writes into one transaction by @BYK in [#1092](https://github.com/BYK/loreai/pull/1092)
- (vec) Return to upstream sqlite-vec 0.1.9, drop the vendored fork by @BYK in [#1058](https://github.com/BYK/loreai/pull/1058)

## 0.34.0

### New Features ✨

#### Cache Economics

- PR2b — flip warmer + compaction onto unified strategy by @BYK in [#896](https://github.com/BYK/loreai/pull/896)
- Single evaluator + shadow-mode wiring (no behavior change) by @BYK in [#844](https://github.com/BYK/loreai/pull/844)

#### Cch

- Add seeds for Claude Code up to 2.1.193 by @github-actions in [#1004](https://github.com/BYK/loreai/pull/1004)
- Add seeds for Claude Code up to 2.1.191 by @github-actions in [#984](https://github.com/BYK/loreai/pull/984)
- Add seeds for Claude Code up to 2.1.190 by @github-actions in [#978](https://github.com/BYK/loreai/pull/978)
- Add seeds for Claude Code up to 2.1.187 by @github-actions in [#953](https://github.com/BYK/loreai/pull/953)
- Add seeds for Claude Code up to 2.1.186 by @github-actions in [#924](https://github.com/BYK/loreai/pull/924)
- Add seeds for Claude Code up to 2.1.185 by @github-actions in [#865](https://github.com/BYK/loreai/pull/865)
- Add seeds for Claude Code up to 2.1.183 by @github-actions in [#817](https://github.com/BYK/loreai/pull/817)

#### Core

- Generic off-thread read-RPC pool; route forSession reads (#966) by @BYK in [#1005](https://github.com/BYK/loreai/pull/1005)
- Measure read-path main-thread blocking to Sentry (#966 B, measure-first) by @BYK in [#993](https://github.com/BYK/loreai/pull/993)
- Off-thread vector search via read-worker pool (#966) by @BYK in [#989](https://github.com/BYK/loreai/pull/989)
- Log sqlite-vec native-vs-fallback path at startup by @BYK in [#985](https://github.com/BYK/loreai/pull/985)
- Native sqlite-vec vector search over BLOB columns with JS fallback by @BYK in [#967](https://github.com/BYK/loreai/pull/967)
- Route bust-spiral detection to host hook for Sentry alerting (#797) by @BYK in [#951](https://github.com/BYK/loreai/pull/951)
- Meta-aware cost model for #947 by @BYK in [#950](https://github.com/BYK/loreai/pull/950)
- Teach curator to capture recurring procedures as runbooks (#914) by @BYK in [#923](https://github.com/BYK/loreai/pull/923)
- Move knowledge confidence to a knowledge_meta register (A2 sub-PR 3b-1) by @BYK in [#929](https://github.com/BYK/loreai/pull/929)
- Broaden verifier recall for the outcome-reward loop (#497 follow-up) by @BYK in [#927](https://github.com/BYK/loreai/pull/927)
- Feed outcome signal into curator consolidation (#497 follow-up) by @BYK in [#921](https://github.com/BYK/loreai/pull/921)
- Surface knowledge "outcome impact" in lore data show (#497 follow-up) by @BYK in [#906](https://github.com/BYK/loreai/pull/906)
- Outcome-reward — adjust knowledge confidence by verifier results (#497) by @BYK in [#902](https://github.com/BYK/loreai/pull/902)
- Flip update()/remove() onto append-only versioning (A2 sub-PR 2b-2b) by @BYK in [#853](https://github.com/BYK/loreai/pull/853)
- Append-only invariants + partial-mirror obligations (A2 sub-PR 2b-2a) by @BYK in [#850](https://github.com/BYK/loreai/pull/850)
- Key knowledge cross-references on logical_id (A2 sub-PR 2b-1) by @BYK in [#848](https://github.com/BYK/loreai/pull/848)
- Route knowledge retrieval reads through knowledge_current (A2 sub-PR 2a) by @BYK in [#847](https://github.com/BYK/loreai/pull/847)
- Shared cache-economics decision module (no wiring yet) by @BYK in [#842](https://github.com/BYK/loreai/pull/842)
- Append-only knowledge scaffolding (A2 sub-PR 1) by @BYK in [#839](https://github.com/BYK/loreai/pull/839)
- Global dead-knowledge sweep across all projects by @BYK in [#820](https://github.com/BYK/loreai/pull/820)

#### Gateway

- Support Claude via Google Vertex AI (#870 part 2) by @BYK in [#987](https://github.com/BYK/loreai/pull/987)
- Route AWS Bedrock via bedrock-mantle (native Anthropic API) by @BYK in [#935](https://github.com/BYK/loreai/pull/935)
- Support Claude via AWS Bedrock through the gateway by @BYK in [#898](https://github.com/BYK/loreai/pull/898)
- `lore doctor` and `lore setup status` by @BYK in [#892](https://github.com/BYK/loreai/pull/892)
- Harden `lore setup` — liveness, undo, run-first guidance by @BYK in [#876](https://github.com/BYK/loreai/pull/876)
- `lore start --bg` daemon mode + `lore stop` by @BYK in [#875](https://github.com/BYK/loreai/pull/875)
- Capture client aborts that coincide with host pressure by @BYK in [#862](https://github.com/BYK/loreai/pull/862)
- Process resource gauge + startup-backfill span by @BYK in [#860](https://github.com/BYK/loreai/pull/860)
- Diagnose UNCACHED warmups (expiry vs body divergence) by @BYK in [#838](https://github.com/BYK/loreai/pull/838)

#### Ltm

- Refresh provenance metadata on update/remove (#627 Phase 2) by @BYK in [#986](https://github.com/BYK/loreai/pull/986)
- Capture gitHead from session-start probe into knowledge.metadata (#627 Phase 1) by @BYK in [#977](https://github.com/BYK/loreai/pull/977)

#### References

- Validate cited code symbols (#911) by @BYK in [#988](https://github.com/BYK/loreai/pull/988)
- Resolve file refs case-insensitively (#969) by @BYK in [#973](https://github.com/BYK/loreai/pull/973)

#### Sync

- Key the knowledge outbox by logical_id for all ops (#909 prereq) by @BYK in [#913](https://github.com/BYK/loreai/pull/913)
- Re-key remote knowledge sync on logical_id (A2 sub-PR 3) by @BYK in [#897](https://github.com/BYK/loreai/pull/897)
- Profiles pull-only mirror + plan-tier resolution (#824) by @BYK in [#828](https://github.com/BYK/loreai/pull/828)
- Scope seam (author_id/scope_id) + maintained usage counter by @BYK in [#830](https://github.com/BYK/loreai/pull/830)

#### Other

- (idle) PR3 — defer prefix-rewriting idle work on hold-warm sessions (D6′) by @BYK in [#905](https://github.com/BYK/loreai/pull/905)
- Reference-validity validator (#627 Phase 0) by @BYK in [#939](https://github.com/BYK/loreai/pull/939)
- Surface budget-overflow knowledge as a recall-by-id ToC (#917) by @BYK in [#930](https://github.com/BYK/loreai/pull/930)

### Bug Fixes 🐛

#### Cache Economics

- Normalize cacheSizeCompressed to cacheSizeFull's input scale by @BYK in [#887](https://github.com/BYK/loreai/pull/887)
- Source compressed size from the actual rebuilt window (layer ≥ 1) by @BYK in [#883](https://github.com/BYK/loreai/pull/883)
- Measure large sessions in shadow; review tidy-ups by @BYK in [#846](https://github.com/BYK/loreai/pull/846)

#### Cache Warmer

- Drop stale warmup body when idle distillation rewrites the prefix by @BYK in [#877](https://github.com/BYK/loreai/pull/877)
- Preserve real cache_control breakpoints in warmup body by @BYK in [#873](https://github.com/BYK/loreai/pull/873)

#### Core

- Emit read-path timing on forSession empty-knowledge fast path by @BYK in [#1014](https://github.com/BYK/loreai/pull/1014)
- Arm pattern-echo cooldown unconditionally by @BYK in [#1009](https://github.com/BYK/loreai/pull/1009)
- Cancel timed-out vector worker queries so the pool recovers by @BYK in [#1008](https://github.com/BYK/loreai/pull/1008)
- Don't re-run vector scan on main thread after pool timeout by @BYK in [#1006](https://github.com/BYK/loreai/pull/1006)
- Stop distilled-prefix oscillation via stable per-session usable (Bug 1) by @BYK in [#974](https://github.com/BYK/loreai/pull/974)
- Iterate normalize() to a fixpoint (#959) by @BYK in [#965](https://github.com/BYK/loreai/pull/965)
- Tighten isCapFit + stop clearing coldStart on recovery (#952) by @BYK in [#957](https://github.com/BYK/loreai/pull/957)
- Exempt meta-distillation prefix-rewrites from unsustainable warning by @BYK in [#926](https://github.com/BYK/loreai/pull/926)
- Mark consolidation verifier annotation as optional in prompts (Seer #921) by @BYK in [#922](https://github.com/BYK/loreai/pull/922)
- Drop outcomeImpact.lastVerdict — inaccurate recency hint (Seer #906) by @BYK in [#919](https://github.com/BYK/loreai/pull/919)
- Append-only id-resolution + import scoping follow-ups (#823) by @BYK in [#893](https://github.com/BYK/loreai/pull/893)
- Calibrate embedding cap constants from measured WASM footprint by @BYK in [#867](https://github.com/BYK/loreai/pull/867)
- Adaptive token cap for local embedding OOM recovery by @BYK in [#855](https://github.com/BYK/loreai/pull/855)

#### Gateway

- Declare @loreai/core as a runtime dependency (#998) by @BYK in [#1024](https://github.com/BYK/loreai/pull/1024)
- Re-anchor durable delta on compression instead of deleting by @BYK in [#1017](https://github.com/BYK/loreai/pull/1017)
- Trim mid-session knowledge delta to additive-only by @BYK in [#1013](https://github.com/BYK/loreai/pull/1013)
- Drop transient upstream network errors from Sentry by @BYK in [#1000](https://github.com/BYK/loreai/pull/1000)
- Scale 5m warmup margin by prefix size to avoid TTL-race partials by @BYK in [#1002](https://github.com/BYK/loreai/pull/1002)
- Compute delta nudge against original messages, not mutating out (Bug 2 follow-up) by @BYK in [#982](https://github.com/BYK/loreai/pull/982)
- Only credit a warmup hit when the returning turn read the cache (Bug C) by @BYK in [#979](https://github.com/BYK/loreai/pull/979)
- Persist nudged insertAt so steady-layer-1 drift stops recurring (Bug 2) by @BYK in [#976](https://github.com/BYK/loreai/pull/976)
- Stream recall follow-up for openai-codex (ChatGPT) backend by @BYK in [#968](https://github.com/BYK/loreai/pull/968)
- Make durable knowledge-delta append-only (cache-stable by construction) by @BYK in [#958](https://github.com/BYK/loreai/pull/958)
- Trigger durable knowledge-delta on DB mutation, not ranking churn by @BYK in [#954](https://github.com/BYK/loreai/pull/954)
- Defer prefix rewrites on cool-bust mid-flight (#946) by @BYK in [#949](https://github.com/BYK/loreai/pull/949)
- Suppress dramatic-drop warn for cool-* cache strategies by @BYK in [#948](https://github.com/BYK/loreai/pull/948)
- Exempt partial-cache-hit prefix-rewrite busts from unsustainable gate by @BYK in [#943](https://github.com/BYK/loreai/pull/943)
- Tag the global auth fallback from the upstream URL when header-less (#942) by @BYK in [#944](https://github.com/BYK/loreai/pull/944)
- Make the global auth fallback provider-aware (#829) by @BYK in [#940](https://github.com/BYK/loreai/pull/940)
- Bracket IPv6 host literals in handleNodeRequest (#907) by @BYK in [#912](https://github.com/BYK/loreai/pull/912)
- Probe for an existing gateway before binding (#908) by @BYK in [#920](https://github.com/BYK/loreai/pull/920)
- Per-model client usage cap + message_delta usage leak by @BYK in [#910](https://github.com/BYK/loreai/pull/910)
- Tolerate unavailable bind hosts (EADDRNOTAVAIL) by @BYK in [#904](https://github.com/BYK/loreai/pull/904)
- Probe all interfaces when detecting existing gateway by @BYK in [#903](https://github.com/BYK/loreai/pull/903)
- Retry provider error envelopes wrapped in HTTP 200 worker responses by @BYK in [#900](https://github.com/BYK/loreai/pull/900)
- Skip background work when worker model's provider has no credential by @BYK in [#895](https://github.com/BYK/loreai/pull/895)
- Drain in-flight background work on pipeline reset by @BYK in [#888](https://github.com/BYK/loreai/pull/888)
- Report UNCACHED warmup bodyBytes in UTF-8 bytes by @BYK in [#841](https://github.com/BYK/loreai/pull/841)
- Make getCircuitBreakerStatus a pure, decay-safe read by @BYK in [#837](https://github.com/BYK/loreai/pull/837)
- Scope cache-warmer circuit breaker per (session, model, upstream) by @BYK in [#836](https://github.com/BYK/loreai/pull/836)

#### Ltm

- Purge knowledge_session_injections on knowledge/session delete (#996) by @BYK in [#997](https://github.com/BYK/loreai/pull/997)
- Purge per-entry validation bookkeeping on knowledge delete (#990) by @BYK in [#994](https://github.com/BYK/loreai/pull/994)

#### Sync

- SeedOutbox re-seeds by content so a stale upsert can't mask an edit by @BYK in [#868](https://github.com/BYK/loreai/pull/868)
- Reconcile tombstones a deleted row even when a stale upsert outlived it by @BYK in [#866](https://github.com/BYK/loreai/pull/866)
- Reconcile re-syncs a row recreated across a disable/enable boundary by @BYK in [#861](https://github.com/BYK/loreai/pull/861)
- A remote tombstone never content-matches "skip" — propagate the delete by @BYK in [#856](https://github.com/BYK/loreai/pull/856)

#### Test

- Scope session-rotation counts by header (proper #859 fix) by @BYK in [#884](https://github.com/BYK/loreai/pull/884)
- Deflake session-rotation test when X-Lore-Project is absent by @BYK in [#879](https://github.com/BYK/loreai/pull/879)

#### Other

- (gradient) Clamp escalated compression-stage budgets to layer-0 ceiling by @BYK in [#872](https://github.com/BYK/loreai/pull/872)
- (pi) Migrate to @earendil-works/pi-coding-agent for security fixes by @BYK in [#813](https://github.com/BYK/loreai/pull/813)
- (vector-pool) Unref the per-request timeout timer (#989 review) by @BYK in [#991](https://github.com/BYK/loreai/pull/991)
- (website) Make docs links resolve on PR previews + CI guard by @BYK in [#960](https://github.com/BYK/loreai/pull/960)
- Stop distilled-prefix churn (warming gate + overhead scale fix) by @BYK in [#995](https://github.com/BYK/loreai/pull/995)

### Documentation 📚

#### Website

- Add Mermaid diagrams to architecture page by @BYK in [#777](https://github.com/BYK/loreai/pull/777)
- "Why memory is not enough" blog post + mobile hamburger nav by @BYK in [#1003](https://github.com/BYK/loreai/pull/1003)

#### Other

- Position .lore.md as git-native, PR-reviewable team memory (#915) by @BYK in [#918](https://github.com/BYK/loreai/pull/918)
- Fix stale § reference + missing trailing newline (#835 post-merge errata) by @BYK in [#890](https://github.com/BYK/loreai/pull/890)
- Codify review heuristics & workflow (#835) by @BYK in [#889](https://github.com/BYK/loreai/pull/889)

### Internal Changes 🔧

#### Core

- Resolve project id once in applyOps, not per op by @BYK in [#1021](https://github.com/BYK/loreai/pull/1021)
- Batch mergeSelfPersonDuplicates alias lookup into one query by @BYK in [#1020](https://github.com/BYK/loreai/pull/1020)
- Batch entitiesForSession ref-count ranking into one query by @BYK in [#1018](https://github.com/BYK/loreai/pull/1018)
- Batch + offload recall entity FTS and vector-hit hydration (#966) by @BYK in [#1019](https://github.com/BYK/loreai/pull/1019)
- Batch dedup_feedback inserts into one transaction by @BYK in [#1015](https://github.com/BYK/loreai/pull/1015)
- Route recall FTS fan-out off-thread + fix collateral-read main-thread stall (#966) by @BYK in [#1012](https://github.com/BYK/loreai/pull/1012)
- Batch curator entity-ref sync to load registry once by @BYK in [#1011](https://github.com/BYK/loreai/pull/1011)
- Cap the temporal vector scan by recency by @BYK in [#1007](https://github.com/BYK/loreai/pull/1007)
- Materialized per-session rollup for /ui/costs aggregates (#981) by @BYK in [#992](https://github.com/BYK/loreai/pull/992)
- Cover costs-page token-sum & recent-session aggregates (v58) by @BYK in [#980](https://github.com/BYK/loreai/pull/980)
- Cover normalize() cap/cycle branches via iterateToFixpoint (#970) by @BYK in [#972](https://github.com/BYK/loreai/pull/972)
- Index the costs-page assistant-message scan (v56) by @BYK in [#945](https://github.com/BYK/loreai/pull/945)
- Halve pairwise comparisons in promoteCrossProject by @BYK in [#934](https://github.com/BYK/loreai/pull/934)
- Reduce CPU spikes from vector search, fetch interceptor, and dedup by @BYK in [#933](https://github.com/BYK/loreai/pull/933)
- Worker-mock tests for embedding OOM recovery flow by @BYK in [#871](https://github.com/BYK/loreai/pull/871)

#### Gateway

- Bind test servers to port 0 to kill EADDRINUSE flake (closes #931) by @BYK in [#937](https://github.com/BYK/loreai/pull/937)
- Reduce redundant work in idle scheduler by @BYK in [#936](https://github.com/BYK/loreai/pull/936)
- Guard pipeline bustCause threading (closes #928) by @BYK in [#932](https://github.com/BYK/loreai/pull/932)

#### Sync

- Make the seedOutbox PRAGMA-count test non-vacuous by @BYK in [#882](https://github.com/BYK/loreai/pull/882)
- Memoize syncedColumns per connection (kills the push/pull PRAGMA N+1) by @BYK in [#878](https://github.com/BYK/loreai/pull/878)
- Resolve seedOutbox's synced columns once per table, not per row by @BYK in [#874](https://github.com/BYK/loreai/pull/874)
- Property/sequence tests for the sync engine state machine (#833) by @BYK in [#852](https://github.com/BYK/loreai/pull/852)
- RecoverMissingObjects recreates the 3-col outbox index (v52 consistency) by @BYK in [#864](https://github.com/BYK/loreai/pull/864)
- Index sync_outbox(table_name,row_id,seq) for seedOutbox's latest-op probe by @BYK in [#863](https://github.com/BYK/loreai/pull/863)
- Close genuine sync-data gaps found by mutation testing (#832) by @BYK in [#851](https://github.com/BYK/loreai/pull/851)
- AssertSyncInvariants() teardown — continuous invariant enforcement (#834) by @BYK in [#845](https://github.com/BYK/loreai/pull/845)
- Registry-contract + identity-lifecycle invariant batteries by @BYK in [#831](https://github.com/BYK/loreai/pull/831)

#### Other

- (cache-economics) Prove evaluateCacheStrategy is scale-unbiased (#886) by @BYK in [#891](https://github.com/BYK/loreai/pull/891)
- (cache-warmer) Cover shouldWarm Phase B continuation (PR #896 coverage) by @BYK in [#901](https://github.com/BYK/loreai/pull/901)
- (deps-dev) Bump undici from 7.27.2 to 7.28.0 in the npm_and_yarn group across 1 directory by @dependabot in [#819](https://github.com/BYK/loreai/pull/819)
- (gradient) Harden layer-1 clamp guard (adversarial review follow-up to #872) by @BYK in [#880](https://github.com/BYK/loreai/pull/880)
- (references) Guard Windows backslash path normalization by @BYK in [#971](https://github.com/BYK/loreai/pull/971)
- (test) Stryker mutation testing on the sync modules (#832) by @BYK in [#840](https://github.com/BYK/loreai/pull/840)
- Wire check-preview-links into ci-status (PR #960 follow-up) by @BYK in [#975](https://github.com/BYK/loreai/pull/975)

## 0.33.0

### New Features ✨

#### Cch

- Add seed for Claude Code 2.1.181 and harden oracle capture by @BYK in [#805](https://github.com/BYK/loreai/pull/805)
- Add seeds for Claude Code up to 2.1.179 by @github-actions in [#795](https://github.com/BYK/loreai/pull/795)

#### Core

- Knowledge confidence lifecycle — decay, reinforcement, value eviction by @BYK in [#816](https://github.com/BYK/loreai/pull/816)
- Bound curator cost by token budget and prune dead knowledge by @BYK in [#815](https://github.com/BYK/loreai/pull/815)
- Centralized DB query-tracing seam + upsert/transaction helpers by @BYK in [#802](https://github.com/BYK/loreai/pull/802)

#### Other

- (gateway) Measure system[0] cache-bust relocatability (#791) by @BYK in [#811](https://github.com/BYK/loreai/pull/811)
- Basic-tier cloud sync engine (knowledge + entity graph) (#467) by @BYK in [#782](https://github.com/BYK/loreai/pull/782)

### Bug Fixes 🐛

#### Gateway

- Stop consolidation retry storm across worktrees and concurrent sessions by @BYK in [#814](https://github.com/BYK/loreai/pull/814)
- Reserve max_tokens headroom for thinking-by-default models by @BYK in [#812](https://github.com/BYK/loreai/pull/812)
- Handle Claude Code billing headers without a cch segment by @BYK in [#809](https://github.com/BYK/loreai/pull/809)
- Stop spurious prompt-cache busts and false unsustainable warnings by @BYK in [#808](https://github.com/BYK/loreai/pull/808)
- Keep Claude Code 2.1.181+ emitting cch through the gateway by @BYK in [#806](https://github.com/BYK/loreai/pull/806)
- Restart-proof session adoption to stop cold-start busts (#796) by @BYK in [#804](https://github.com/BYK/loreai/pull/804)

#### Other

- (core) Quote FTS5 query terms to prevent keyword-injection syntax errors by @BYK in [#810](https://github.com/BYK/loreai/pull/810)

### Documentation 📚

- (env) Document LORE_NO_DB_TRACING in generated env docs by @BYK in [#803](https://github.com/BYK/loreai/pull/803)

### Internal Changes 🔧

- (deps-dev) Bump astro from 6.4.4 to 6.4.6 in the npm_and_yarn group across 1 directory by @dependabot in [#800](https://github.com/BYK/loreai/pull/800)

## 0.32.0

### New Features ✨

- (cch) Add seeds for Claude Code up to 2.1.178 by @github-actions in [#787](https://github.com/BYK/loreai/pull/787)

### Bug Fixes 🐛

#### Core

- Pin compressed sessions to Layer >= 1 — no Layer-0 re-entry (prefix front-bust) by @BYK in [#798](https://github.com/BYK/loreai/pull/798)
- Budget-aware distilled-prefix trim to stop spurious Layer 4 front-busts by @BYK in [#794](https://github.com/BYK/loreai/pull/794)
- Gate unsustainable warning to genuinely over-cap sessions by @BYK in [#788](https://github.com/BYK/loreai/pull/788)
- Stop curator from minting near-duplicate preferences by @BYK in [#783](https://github.com/BYK/loreai/pull/783)

#### Gateway

- Gate cache-warming on write-efficiency + quiet divergence log noise by @BYK in [#792](https://github.com/BYK/loreai/pull/792)
- Normalize moving cache_control breakpoint in cache analytics by @BYK in [#789](https://github.com/BYK/loreai/pull/789)
- Re-anchor durable delta on post-idle compact, not just layer change by @BYK in [#790](https://github.com/BYK/loreai/pull/790)
- Re-anchor durable knowledge-delta on compression (stop tool-pair stripping) by @BYK in [#786](https://github.com/BYK/loreai/pull/786)
- Stop background-worker 401s on non-Anthropic providers by @BYK in [#785](https://github.com/BYK/loreai/pull/785)

#### Other

- (deps) Bump @opentelemetry/core and protobufjs to patched versions by @BYK in [#793](https://github.com/BYK/loreai/pull/793)

## 0.31.2

### Bug Fixes 🐛

#### Core

- Stop LTM cache churn + close the cache-bust test blind spot by @BYK in [#778](https://github.com/BYK/loreai/pull/778)
- Stop layer-1 raw-window pin from marching every turn by @BYK in [#773](https://github.com/BYK/loreai/pull/773)

#### Gateway

- Gate tool-call warmup continuation on confirmed hits (Bug C) by @BYK in [#780](https://github.com/BYK/loreai/pull/780)
- Correct warmup hit accounting (phantom savings + ~10x undercount) by @BYK in [#779](https://github.com/BYK/loreai/pull/779)
- Gate billing-header re-sign on real header presence by @BYK in [#775](https://github.com/BYK/loreai/pull/775)
- Prevent cross-provider worker collusion + harden worker failure handling by @BYK in [#776](https://github.com/BYK/loreai/pull/776)

### Internal Changes 🔧

- (build) Run the build pipeline under Node (tsx), not Bun by @BYK in [#774](https://github.com/BYK/loreai/pull/774)

## 0.31.1

### Bug Fixes 🐛

- (core) Clamp tier-gate compressedEstimate to the layer-0 ceiling by @BYK in [#771](https://github.com/BYK/loreai/pull/771)

## 0.31.0

### New Features ✨

#### Cch

- Add seeds for Claude Code up to 2.1.177 by @github-actions in [#761](https://github.com/BYK/loreai/pull/761)
- Add seeds for Claude Code up to 2.1.176 by @github-actions in [#759](https://github.com/BYK/loreai/pull/759)

#### Other

- (auth) Folk Lore individual accounts via Supabase (Milestone 1, #467) by @BYK in [#765](https://github.com/BYK/loreai/pull/765)
- (gateway) Persist durable prompt deltas by @BYK in [#747](https://github.com/BYK/loreai/pull/747)

### Bug Fixes 🐛

#### Gateway

- Bundle ONNX WASM runtime so npm installs don't need onnxruntime-node (#763) by @BYK in [#769](https://github.com/BYK/loreai/pull/769)
- Stop prompt deltas from splitting tool_use/tool_result pairs by @BYK in [#768](https://github.com/BYK/loreai/pull/768)
- Make max_tokens sizing thinking-aware to prevent truncated turns by @BYK in [#767](https://github.com/BYK/loreai/pull/767)
- Prefer authoritative inference over a stale X-Lore-Project header by @BYK in [#762](https://github.com/BYK/loreai/pull/762)

#### Other

- (ci) Build @loreai/core in CCH seed check workflow by @BYK in [#758](https://github.com/BYK/loreai/pull/758)
- (cli,ui) Resilient dedup scan + knowledge merge UI by @BYK in [#760](https://github.com/BYK/loreai/pull/760)
- (deps) Force esbuild >=0.28.1 to resolve Dependabot alerts by @BYK in [#764](https://github.com/BYK/loreai/pull/764)

### Documentation 📚

- Regenerate environment.md for LORE_NO_BROWSER by @BYK in [#766](https://github.com/BYK/loreai/pull/766)

## 0.30.0

### New Features ✨

- (cch) Alert on duplicate billing-header sentinel (cache-bust early warning) by @BYK in [#745](https://github.com/BYK/loreai/pull/745)
- (cli) Add `lore data export` to regenerate .lore.md from the DB by @BYK in [#730](https://github.com/BYK/loreai/pull/730)

### Bug Fixes 🐛

#### Cch

- Handle 2.1.172+ hash preimage change (strip model + max_tokens) by @BYK in [#743](https://github.com/BYK/loreai/pull/743)
- Anchor cch signing to billing header to stop self-referential cache busts by @BYK in [#739](https://github.com/BYK/loreai/pull/739)
- Correct PRIME64_4 (Zig-std xxHash64), byte-safe capture, native scanner by @BYK in [#723](https://github.com/BYK/loreai/pull/723)

#### Core

- Freeze distilled prefix during warm sessions by @BYK in [#752](https://github.com/BYK/loreai/pull/752)
- Stop pattern-echo/consolidation thrash (semantic dedup + maxEntries bump) by @BYK in [#737](https://github.com/BYK/loreai/pull/737)
- Tombstone deleted knowledge to stop consolidation thrash by @BYK in [#729](https://github.com/BYK/loreai/pull/729)

#### Gateway

- Accurate divergence reason for turn-2 system[2] insertion by @BYK in [#756](https://github.com/BYK/loreai/pull/756)
- Await models.dev data on first request (cold-start budget) by @BYK in [#754](https://github.com/BYK/loreai/pull/754)
- Harden multi-model worker + budget paths by @BYK in [#753](https://github.com/BYK/loreai/pull/753)
- Skip meta-distillation while cache is warm by @BYK in [#751](https://github.com/BYK/loreai/pull/751)
- Stop context-health note from busting system[2] cache (#741) by @BYK in [#746](https://github.com/BYK/loreai/pull/746)
- Stop mid-session curation cache busts; refresh stale prefs on cold idle by @BYK in [#738](https://github.com/BYK/loreai/pull/738)
- Omit unsupported max_output_tokens for Codex by @BYK in [#735](https://github.com/BYK/loreai/pull/735)
- Stop system[2] cache busts from LTM re-ranking by @BYK in [#727](https://github.com/BYK/loreai/pull/727)

#### Other

- (gradient) Stabilize tool-output dedup across turns (messages[N] cache bust) by @BYK in [#736](https://github.com/BYK/loreai/pull/736)
- (opencode) Stop leaking helper exports that crash OpenCode v1.17.4 by @BYK in [#733](https://github.com/BYK/loreai/pull/733)
- (recall) Prevent off-topic cross-session archives from derailing new sessions by @BYK in [#728](https://github.com/BYK/loreai/pull/728)
- Intercept Codex /codex/responses and add body-shape protocol detection by @BYK in [#750](https://github.com/BYK/loreai/pull/750)

### Documentation 📚

- Reset .lore.md with latest state by @BYK in [4f4a567a](https://github.com/BYK/loreai/commit/4f4a567a1d0d1063a2db1b915a70c810b158b33f)

### Internal Changes 🔧

#### Gateway

- Cover cache stability across compression layers by @BYK in [#748](https://github.com/BYK/loreai/pull/748)
- E2e cache-stability guardrail by @BYK in [#742](https://github.com/BYK/loreai/pull/742)

#### Other

- (core) Regression for vector-scored system[2] set churn by @BYK in [#732](https://github.com/BYK/loreai/pull/732)
- (deps-dev) Bump esbuild from 0.25.12 to 0.28.1 in the npm_and_yarn group across 1 directory by @dependabot in [#755](https://github.com/BYK/loreai/pull/755)

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

