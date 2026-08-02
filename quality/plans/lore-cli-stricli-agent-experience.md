# Plan: Make Lore's CLI discoverable, agent-friendly, and consistent

North star: the new Sentry CLI in `~/Code/getsentry/cli`.

## Goal

Make `lore` a predictable interface for people, shell users, scripts, and coding agents.
Stricli becomes the canonical command schema. Help, structured introspection, generated
documentation, shell completion, and the installed Lore skill derive from that schema.

This is a staged migration, not a parser swap. Existing command behavior remains stable while
typed route definitions replace the current global `parseArgs` registry and handwritten dispatch.

## Why this work is needed

Lore's current CLI has three sources of truth:

- the root `OPTIONS` object and `switch` in `packages/gateway/src/cli/main.ts`;
- command-local positional parsing and validation;
- handwritten help in `packages/gateway/src/cli/help.ts` and command modules.

They have already drifted. The root help omits public commands and many `data` subcommands, while
handlers read flags such as recall's `--scope` and `--session` that the global parser does not
declare. Unknown value-bearing options are ambiguous because root parsing uses `strict: false`.
There is no shell completion, structured help contract, generated command reference, or CLI skill
installer.

Sentry's CLI avoids this drift by treating its Stricli route tree as executable schema. Lore should
adopt that design, adapted to Lore's local-first gateway, agent launcher, bundled npm package, and
standalone binary.

## Locked design decisions

1. **One canonical route tree.** Every visible command, hidden diagnostic, alias, positional, flag,
   default, and help description is registered in one Stricli tree.
2. **Local wrappers own policy.** Command modules import Lore's `buildCommand` and `buildRouteMap`,
   not Stricli builders. The wrappers add output, errors, common flags, hints, and later telemetry.
3. **Existing handlers migrate incrementally.** Do not rewrite storage, sync, setup, import, login,
   or upgrade business logic merely to adopt Stricli. First place typed adapters around it; split
   large modules only when doing so removes command parsing from domain logic.
4. **`lore` remains shorthand for `lore run`.** The no-argument default and root agent shorthands
   (`lore claude`, `lore opencode`, and peers) remain compatible.
5. **Agent arguments are opaque.** Once `run` selects an agent, trailing argv is forwarded
   byte-for-byte. `--` remains the unambiguous boundary. A pre-routing compatibility layer handles
   this before strict Stricli parsing.
6. **One result feeds human and machine output.** Information-producing commands return typed data;
   human rendering and JSON serialization consume the same value.
7. **Machine mode is clean.** `--json` never prompts and never writes hints, banners, spinners,
   update notices, or ANSI escapes to stdout. Streaming commands use JSON Lines where structured
   streaming makes sense.
8. **Help is an introspection API.** `lore help --json [command path...]` returns stable structured
   metadata for agents and tools.
9. **Skills and completions are generated, embedded, and installed offline.** The release artifact
   contains files generated from the exact route tree used by that version.
10. **Post-install integrations are best effort.** Completion and skill failures never turn a
    successful setup or upgrade into a failed binary installation.
11. **Compatibility routes are callable but hidden.** Existing aliases remain available without
    cluttering help, completion, docs, or skills.
12. **No flag-day command renaming.** First make the existing surface consistent. Any later command
    taxonomy cleanup requires aliases, deprecation policy, and usage evidence.

## Sentry principles to reuse

- Make the command tree executable metadata rather than prose.
- Keep `bin.ts` process-only, `cli.ts` orchestration-only, `app.ts` declarative, and handlers thin.
- Inject process state and writers through a command context so tests do not patch globals.
- Define shared flags once and derive injection, argv normalization, help, and completion from them.
- Keep latency-sensitive completion outside normal CLI startup, auth, gateway, database, and model
  initialization.
- Use concise briefs in command lists and richer descriptions with constraints and examples at leaf
  commands and route groups.
- Give agents stable JSON, bounded output, field selection, semantic exit codes, and exact recovery
  commands.
- Generate a compact top-level skill plus one reference file per visible route.
- Install generated files atomically and refresh them with the new binary after upgrades.
- Prefer explicit structural assertions and generated-artifact checks over broad snapshots.

## Sentry details not to copy

- Sentry auth guards, `.sentryclirc`, organization/project selection, API retry rules, and telemetry.
- Sentry's resource names and compatibility aliases.
- Per-command SDK generation in the first migration. Lore can add a library API later if users need
  one.
- Network-backed dynamic completion. Lore completion must remain local-only.
- Decorative help output. Lore should favor compact, low-token help from the start.

## Target architecture

```text
packages/gateway/src/cli/
  bin.ts                       process entry, terminal behavior, final rejection handling
  cli.ts                       argv preprocessing, fast paths, dispatch, update notices
  app.ts                       canonical Stricli application and top-level routes
  context.ts                   injected process/env/cwd/home/stdin/stdout/stderr/command path
  commands/
    help.ts
    run.ts
    start.ts
    stop.ts
    setup/
      index.ts
      apply.ts
      undo.ts
      status.ts
    data/
      index.ts
      list.ts
      show.ts
      ...
    entity/
    sync/
    team/
    auth/
    ...
  lib/
    command.ts                 mandatory command wrapper
    route-map.ts               mandatory route wrapper and standard aliases
    global-flags.ts            shared flag metadata
    argv.ts                    root/run shorthand and global-flag preprocessing
    output.ts                  typed human/JSON/JSONL rendering
    errors.ts                  semantic CLI errors and exit-code mapping
    introspect.ts              route metadata for help/docs/skills/completion
    help.ts                    human and structured help rendering
    completions.ts             Bash/Zsh/Fish generation and installation
    complete.ts                optional fast local dynamic completion protocol
    agent-skills.ts            atomic installation of embedded skill files
  generated/
    skill-content.ts           generated embedded files; do not edit
  version.ts

packages/gateway/script/
  generate-command-docs.ts
  generate-skill.ts
  generate-cli-artifacts.ts    shared check/write entry point if useful
```

Existing domain-heavy files may stay where they are during migration. Route modules can call their
exported handlers until parsing and output concerns have been extracted.

## Target command surface

Preserve these canonical paths in the first release:

```text
lore                              -> run
lore run [agent] [-- agent-argv]
lore <known-agent> [agent-argv]   -> run <known-agent> ...
lore start
lore stop
lore setup [app]
lore setup undo [app]
lore setup status
lore doctor
lore logs
lore import
lore recall <query...>
lore lint
lore log [id]
lore diff <id> [v1] [v2]
lore login
lore logout
lore whoami
lore sync [status|enable|disable|now]
lore team ...
lore entity ...
lore data ...
lore upgrade [version]
lore help [command path...]
lore completion <bash|zsh|fish>
lore setup integrations          optional explicit completion/skill refresh command
```

Keep `admin` and binary diagnostics registered as hidden routes. Keep `sync` defaulting to `status`.
Do not automatically add Sentry's generic CRUD aliases where they conflict with current Lore syntax.
Safe aliases such as `entity alias remove -> rm` remain hidden aliases in the route schema.

`recall` should declare a variadic query so `lore recall error handling` no longer drops words. This
is a bug fix, but it must have a regression test and a release note because it changes malformed
legacy behavior.

## Phase 0: Freeze the current contract

Build a compatibility suite before replacing parsing.

### Work

1. Add `packages/gateway/test/cli-routing.test.ts` around a dispatch seam that does not start a real
   gateway, model, browser, or agent.
2. Table-test every root command, visible and hidden.
3. Record defaults and aliases: no args, explicit `run`, every known agent shorthand, `sync`, entity
   `rm/remove`, and setup forms.
4. Build an adversarial argv matrix for `run`:
   - no agent and no agent flags;
   - explicit known agent;
   - arbitrary executable after `run`;
   - unknown boolean flags in auto-detect mode;
   - unknown value-bearing flags after an explicit agent;
   - `--` before agent arguments;
   - agent flags that collide with Lore flags (`--debug`, `--port`, `--model`, `--version`);
   - empty strings, repeated flags, `--flag=value`, and values beginning with `-`.
5. Add subprocess-level fixtures for stdout, stderr, and exit status for root help, version, unknown
   command, unknown flag, and representative usage errors.
6. Add a command inventory test that compares the intended command manifest with every route in the
   old dispatcher. This prevents migration omissions.

### Gate

The suite must pass on the old parser and later on the Stricli parser. Any intentional difference
gets an explicit test and changelog entry rather than an updated opaque snapshot.

## Phase 1: Establish the Stricli foundation

### Dependencies and build

1. Add exact versions of `@stricli/core` and `@stricli/auto-complete` to
   `packages/gateway/package.json`; do not rely on fossilize's transitive dependency.
2. Confirm esbuild bundles both packages into npm CJS/Bun outputs and SEA binaries. Keep them out of
   the `external` list in `packages/gateway/script/bundle.ts` and binary build scripts.
3. Add a package test proving the published tarball and standalone binaries need no undeclared
   Stricli runtime dependency.

### Core files

1. Create `context.ts` with injected `process`, `env`, `cwd`, `homeDir`, input/output streams, TTY
   state, and `commandPrefix`. Add optional clock and filesystem seams only where existing handlers
   need them.
2. Create local `buildCommand` and `buildRouteMap` wrappers. Add a lint or source-scan test that
   rejects direct Stricli builder imports outside these wrapper files and `app.ts` if required.
3. Create `app.ts` with the canonical route tree and Stricli application.
4. Move orchestration from `main.ts` into `cli.ts`: preprocessing, fast paths, Stricli execution,
   update-check lifecycle, and update-notice suppression.
5. Leave `bin.ts` responsible only for process wiring and top-level failures.
6. Register all hidden diagnostics in the route tree with hidden documentation metadata.

### Argv compatibility layer

Implement a small preprocessor before Stricli:

1. No args become `run`.
2. A first token matching `AGENTS[].binary` becomes `run <token> ...`.
3. `run` parsing stops at the selected agent or `--`; remaining raw tokens become one opaque
   `agentArgs` value and bypass Stricli scanning.
4. In auto-detect mode, preserve the current unknown-boolean forwarding behavior. Document that
   value-bearing unknown options require `--` unless a lossless parser can be proved.
5. Hoist only true global flags from safe positions. Never hoist across `--` or from opaque agent
   argv.
6. Normalize `--version` at nested paths only if the behavior is documented and compatibility tests
   approve it.

Keep preprocessing pure: `preprocessArgv(argv, agentRegistry) -> normalized argv + opaque payload`.
Property-test preservation and ordering. Never reconstruct raw agent arguments from parsed values.

### Gate

- Phase 0 compatibility matrix passes unchanged except approved fixes.
- Every route can render help without loading the database, gateway, model, or network clients.
- Both `lore` and `lore-gateway` binaries dispatch through the same application.

## Phase 2: Create shared output and error contracts

Stricli alone will not fix Lore's inconsistent output. Build this layer before converting every
command.

### Output

1. Define `CommandOutput<T>` and `OutputConfig<T>` in `lib/output.ts`.
2. A command returns typed domain data. The wrapper sends it to:
   - a human renderer for TTY/plain text;
   - JSON serialization for `--json`;
   - optional JSON Lines for streams;
   - a binary writer only for commands that explicitly declare binary output.
3. Add `--json` automatically only to commands with structured output.
4. Add `--fields <paths>` to potentially large outputs. Start with `data list/show`, `recall`,
   `entity list/show/search`, `log`, `diff`, `doctor`, `whoami`, `sync status`, and team listings.
5. Use explicit output schemas to validate field paths and add field names/types to help. Reuse an
   existing schema library if already suitable; otherwise add one deliberately rather than inventing
   an incomplete validator.
6. Keep prompts and progress on stderr. Disable them in JSON mode. Destructive commands must reject
   machine-mode ambiguity unless `--yes` or `--dry-run` makes intent explicit.
7. Consolidate duplicate table renderers from `data.ts` and `entity.ts` behind shared formatting.
8. Preserve cosmetic-output fail-safety: progress, tips, and update notices must never abort the
   underlying operation.

### Hints

Handlers may return one contextual hint after successful output. The wrapper prints it only in human
mode and only when stderr is suitable. Initial high-value hints:

- `setup`: how to run or undo setup;
- `doctor`: exact repair command for each failed check;
- `recall`: `--json`, `--fields`, and scope refinement when results are broad;
- `data list`: exact `show` command for an item;
- `login`: `whoami --verify`;
- `upgrade`: integrations were refreshed, or the exact refresh command if they were not.

Hints must be action-specific, deduplicated, and tested. Avoid generic marketing tips.

### Errors and exits

1. Extend `lib/errors.ts` into a typed CLI hierarchy with numeric ranges:
   - `10-19`: authentication/account;
   - `20-29`: usage, validation, and configuration;
   - `30-39`: gateway, network, and provider reachability;
   - `40-49`: unavailable feature or unsupported environment;
   - `50-59`: filesystem, database, import, sync, and upgrade operations;
   - `60-69`: command-specific failures.
2. Give every error an `exitCode` and predictable human structure:
   failure, `Try:` command, optional alternatives, optional diagnostic note.
3. In JSON mode, render a stable error object to stderr with code, category, message, recovery
   commands, and safe details. Do not leak credentials, tokens, raw provider responses, or sensitive
   argv.
4. Replace direct `process.exit()` in migrated handlers with thrown typed errors or returned status.
   Keep the shutdown hard-deadline and forced-exit paths separate; they are process semantics, not
   command errors.
5. Add fuzzy route correction and a small semantic suggestion registry based on observed mistakes.
   Do not guess a large synonym list without evidence.

### Gate

- Human and JSON forms derive from the same test fixture data.
- JSON stdout parses without stripping logs or banners.
- Hints never appear in JSON output.
- Exit-code tests cover each category and exact recovery command formatting.

## Phase 3: Migrate command families

Migrate in risk order. Each slice includes route metadata, typed arguments, structured output where
appropriate, focused tests, and removal of the corresponding old `switch` branch and global flags.

### Slice A: Read-only and self-contained

- `help`, `version`, `logs`, `recall`, `log`, `diff`, `whoami`, `doctor`.
- Convert `upgrade` parsing early because it already owns a self-contained schema, but defer updater
  behavior changes.
- Fix multiword recall queries with a failing regression test first.

### Slice B: Gateway lifecycle and setup

- `start`, `stop`, `setup`, `setup undo`, `setup status`.
- Preserve hosted/local/remote/background defaults exactly.
- Keep liveness probes and post-setup advice out of machine stdout.
- Introduce the explicit integrations refresh route if product wording supports it.

### Slice C: Data and entities

- Turn every current `data` and `entity` branch into a leaf command.
- Register the full existing tree, including maintenance commands omitted from root help.
- Mark destructive operations and enforce confirmation policy centrally.
- Keep `admin` hidden and service-role gated.

### Slice D: Auth, sync, and teams

- `login`, `logout`, `sync`, and nested `team` routes.
- Preserve auth-aware logic in gateway/CLI wrappers; do not push it into `packages/core`.
- Give status/list commands structured output before mutation commands.

### Slice E: Import and lint

- Migrate `import` after the output/error framework can represent dry-run plans, progress, auth
  rejection, and partial per-agent outcomes.
- Migrate `lint` with explicit advisory versus `--gate` exit semantics.

### Slice F: Run and root shorthand

- Move `run` last because it carries the highest parser and lifecycle risk.
- Switch from compatibility adapter to the final typed command only after the full pass-through matrix
  passes against real fixture executables that record argv exactly.

### Per-slice removal rule

Delete migrated flags from the old global `OPTIONS` registry and delete migrated dispatch branches.
Do not leave dual parsers for a command after its slice lands. Temporary compatibility code must have
a named removal milestone and a test proving which path is active.

## Phase 4: Great help and structured introspection

### Metadata standard

Every visible route must declare:

- a short imperative brief;
- a full description that answers what it does, when to use it, and material side effects;
- positional placeholders and constraints;
- flag descriptions, aliases, defaults, enum choices, and relevant environment variables;
- two to five realistic examples for non-trivial commands;
- output-mode and destructive-action notes where relevant;
- hidden/deprecated status and replacement command for compatibility routes.

### Human help

1. `lore help` shows a compact grouped command list, common flags, and a few first-run examples.
2. `lore help <path...>` and `<path> --help` show the same leaf metadata.
3. Route-group help lists all visible children and explains useful defaults.
4. Non-TTY help avoids decoration and stays token-efficient.
5. Unknown paths suggest close routes and exact `lore help ...` commands.
6. Move long environment-variable documentation to generated reference docs; top-level help lists
   only high-value variables.

### Structured help

`lore help --json [path...]` returns a versioned schema containing:

- command path, aliases, hidden/deprecated state;
- brief and full description;
- positionals and flags with types/defaults/enums;
- child routes;
- output fields for structured commands;
- environment variables;
- examples and exit-code categories.

Add a schema version so external agent tooling can detect incompatible changes.

### Gate

- A route-walk test rejects visible commands missing required metadata.
- Hidden routes never appear in normal help, completion, docs, or skills.
- Every example is parsed in a dry dispatch harness so stale examples fail tests.

## Phase 5: Shell completion

### Static completion

1. Generate Bash, Zsh, and Fish scripts from route metadata.
2. Include visible routes, aliases, flags, enums, defaults, and brief descriptions.
3. Add `lore completion bash|zsh|fish` to print scripts for manual/eval use.
4. Add installation helpers for standard per-user locations. Detect the active shell where possible,
   but support explicit shell selection.
5. Refresh completion files during `lore setup`, the explicit integrations refresh command, and
   after upgrades.

### Dynamic completion

Add a hidden `__complete` protocol only for values that can be read cheaply and locally, such as:

- known agent names;
- setup app names;
- project, knowledge, session, distillation, and entity identifiers;
- fixed team scopes already cached locally.

The protocol returns `value<TAB>description`, emits no stderr, and exits zero when data is missing or
the local cache/database cannot be read. It must never start the gateway, contact Supabase, call a
provider, initialize embeddings, trigger import/distillation, or write telemetry/state.

### Tests

- Cross-shell property tests ensure every visible route and flag appears once and hidden routes do
  not appear.
- Enum and alias tests compare generated completion with route metadata.
- E2E latency budget: warm completion under 500 ms, with no stderr and no filesystem writes outside
  the test home.
- A hermetic test fails if completion attempts network access, opens production data, or starts a
  gateway.

## Phase 6: Generate and auto-install the Lore CLI skill

### Generated shape

Generate:

```text
plugins/lore-cli/skills/lore-cli/SKILL.md
plugins/lore-cli/skills/lore-cli/references/cli.md
plugins/lore-cli/skills/lore-cli/references/<route-path>.md
plugins/lore-cli/.well-known/skills/index.json
packages/gateway/src/cli/generated/skill-content.ts
```

The compact `SKILL.md` should teach agents to:

- run the direct Lore command before inventing database or file access;
- use `lore help --json` to discover unfamiliar syntax;
- prefer `--json`, `--fields`, and `--limit` to bound context;
- treat recall output as a pointer and read source files for current code facts;
- use `--dry-run` and explicit confirmation before destructive operations;
- preserve project/session scope and never query unscoped identifiers;
- use `lore run -- ...` when forwarding ambiguous agent flags;
- interpret exit-code categories and execute provided recovery commands;
- never expose credentials or retain them in artifacts.

Each visible route gets a focused reference page generated from route metadata. Keep conceptual
guidance and curated examples in hand-written fragments so regeneration does not erase them.

### Installation

1. Embed generated files in the bundled package and standalone binary.
2. Detect existing compatible roots; initially support `~/.agents/skills/lore-cli` and
   `~/.claude/skills/lore-cli`. Add agent-specific roots only when their skill convention is verified.
3. Do not create a top-level agent root merely to claim support. Existing roots signal installation.
4. Write every file to a hidden temporary sibling and atomically rename it into place.
5. Remove temporary files after failures. Treat read-only roots and sharing violations as best-effort
   skips.
6. Install during `lore setup`; refresh during the explicit integrations command and after upgrade.
7. After binary replacement, invoke setup using the **new binary**, so generated files match the
   installed version.
8. Keep routine refresh silent. Report newly installed integrations in one concise success summary.

### Tests

- Generate one reference per visible route and none for hidden routes.
- Verify frontmatter, links, command examples, structured fields, and discovery manifest.
- Verify both roots, updates, read-only roots, atomic rename, concurrent scanning safety, rename
  failure cleanup, and no temporary leftovers.
- Verify setup/upgrade remains successful when skill installation fails.
- Add an optional model-backed evaluation: given realistic Lore tasks, does the skill cause the model
  to choose the right route, JSON/field limits, scope, dry-run, and `--` forwarding?

## Phase 7: Generated command documentation

1. Add `packages/gateway/script/generate-command-docs.ts` to emit one reference page per visible
   route and a command index.
2. Generate syntax, flags, aliases, defaults, environment links, output fields, and exit codes from
   route metadata.
3. Keep hand-written guides and realistic examples in fragment files loaded by route path.
4. Replace duplicated CLI tables in website/README docs with generated references or links.
5. Add `generate:cli`, `check:cli`, and focused package scripts. Run generation before gateway build,
   bundle, typecheck, and affected tests where needed.
6. CI runs generators in check mode and fails on a diff. Generated artifacts remain committed so
   reviewers can inspect command-surface changes.
7. Add stale-link and orphan-fragment checks: every fragment maps to a live visible route, and every
   generated reference is reachable from the index and skill.

## Phase 8: Setup and upgrade integration

1. Refactor setup's completion and skill installation into independent best-effort steps.
2. Show a final integration summary only for newly created files or actionable failures.
3. Refactor upgrade so the newly installed binary refreshes completions and skills.
4. Preserve installation method and current binary-integrity/version checks.
5. Suppress update notices during JSON output, completion, help generation, setup, upgrade, and hidden
   protocols.
6. Do not let a background update check delay command exit or contaminate machine output.
7. Test npm, pnpm, Bun, standalone, and unsupported-install-method flows with fake subprocesses. Never
   invoke a real package manager in tests.

## Test strategy

### Deterministic suites

- Route inventory and metadata completeness.
- Parser compatibility and exact agent argv preservation.
- Shared/global flag placement before and after route tokens, with `--` boundaries.
- Human/JSON equivalence and field filtering.
- JSON Lines streaming and stdout/stderr separation.
- Error categories, exit codes, recovery commands, and secret redaction.
- Help introspection schema and unknown-route suggestions.
- Generated docs, skills, and completion parity with the route tree.
- Skill/completion atomic installation and cleanup.
- Setup and upgrade best-effort integration behavior.
- Npm bundle and SEA smoke tests for help, completion, skills, and representative commands.

### Property and adversarial tests

- Arbitrary argv token sequences never reorder or mutate opaque agent arguments.
- Every visible route appears exactly once in help, docs, skill references, and all shells.
- No hidden route leaks into generated public artifacts.
- Every declared alias resolves to the same command and never shadows a canonical sibling.
- Every `--fields` selection is a valid subset of the declared output schema.
- Machine mode never writes non-JSON data to stdout.
- Cosmetic rendering failures never change command success or abort work.
- Generator output is deterministic across repeated runs.

### Manual acceptance

Test npm and standalone builds in clean temporary homes:

1. `lore`, `lore run claude`, and `lore claude` launch fixture agents with exact argv.
2. `lore help`, leaf help, and `lore help --json` are useful without network or local Lore state.
3. Bash, Zsh, and Fish complete routes, flags, enum values, and safe local identifiers.
4. `lore setup` installs the skill only into detected roots and does not create unrelated roots.
5. An upgraded binary refreshes its own generated integrations.
6. JSON commands pipe directly to `jq` with empty/non-JSON-free stderr where expected.
7. Destructive commands require explicit confirmation and offer dry-run where the operation supports
   it.

## Verification for every implementation PR

Run focused tests first, then the full project gates:

```bash
pnpm exec vitest run <focused test files>
pnpm test
pnpm run lint
pnpm run typecheck
pnpm run format:check
pnpm run build
```

For generator PRs, run generation twice and verify the second run produces no diff. For packaging
PRs, inspect npm tarball contents and smoke-test standalone binaries. Before merge, run the required
read-only adversarial correctness review from `quality/REVIEW.md`; add a separate security review for
argv handling, file installation, command execution, auth, secret redaction, or upgrade changes.

## Rollout and PR sequence

Keep each PR reviewable and independently useful:

1. **Contract tests:** current route inventory and run/pass-through compatibility matrix.
2. **Stricli foundation:** dependencies, context, wrappers, application, hidden routes, old handlers
   behind adapters.
3. **Output and errors:** shared result path, JSON/fields, semantic exits, hints.
4. **Read-only commands:** help/version/logs/recall/history/doctor/whoami.
5. **Lifecycle/setup commands:** start/stop/setup and integrations installation seam.
6. **Data/entity commands:** full nested route conversion and destructive policy.
7. **Auth/sync/team/import/lint:** remaining typed routes.
8. **Run command:** final opaque-argv implementation and removal of `parseArgs`/old dispatch.
9. **Completion:** static scripts, safe dynamic protocol, installer, latency tests.
10. **Skill:** generator, embedded files, atomic installer, setup/upgrade refresh.
11. **Docs:** generated command reference and stale-artifact CI.
12. **Polish:** evidence-backed semantic suggestions, contextual hints, optional skill eval.

If a slice becomes too large, split by route group, but do not separate a route schema from its
compatibility tests or leave two active parsers for that route.

## Completion criteria

The migration is complete when:

- `main.ts` no longer owns a global option registry or command `switch`;
- every command and hidden diagnostic is represented in the Stricli route tree;
- every visible route has complete metadata and generated help/reference coverage;
- all information-producing commands have a stable structured form unless a documented reason
  excludes them;
- `lore help --json` is stable and versioned;
- Bash, Zsh, and Fish completion install and refresh successfully;
- a generated Lore CLI skill installs atomically into detected agent roots and refreshes after
  upgrades;
- docs, completions, and skill files pass route-tree parity checks;
- `lore run` and agent shorthand preserve raw argv across the full compatibility matrix;
- machine output contains no prompts, hints, banners, progress, ANSI, or update notices;
- npm and standalone binaries pass smoke tests;
- focused tests, full tests, lint, typecheck, format check, and build all pass;
- adversarial correctness and relevant security reviews return merge-ready verdicts.

## Deferred work

- A generated TypeScript SDK over the command tree.
- Network-backed completion.
- Creating agent roots for tools the user has not installed.
- Broad command renaming or a new noun/verb taxonomy without usage evidence.
- Telemetry-driven suggestions until Lore has a privacy-safe source of aggregate mistakes.
- Removing old aliases before a documented deprecation window.

## Key source evidence

- Current global parser and pass-through contract: `packages/gateway/src/cli/main.ts:30-177`.
- Current dispatch/default/shorthand: `packages/gateway/src/cli/main.ts:400-620`.
- Handwritten root help: `packages/gateway/src/cli/help.ts:6-205`.
- Gateway package and binary aliases: `packages/gateway/package.json:17-50`.
- Sentry canonical route tree and hidden routes: `~/Code/getsentry/cli/packages/cli/src/app.ts:99-184`.
- Sentry application/error integration: `~/Code/getsentry/cli/packages/cli/src/app.ts:276-407`.
- Sentry command wrapper: `~/Code/getsentry/cli/packages/cli/src/lib/command.ts:490-840`.
- Sentry structured output: `~/Code/getsentry/cli/packages/cli/src/lib/formatters/output.ts:93-327`.
- Sentry structured help: `~/Code/getsentry/cli/packages/cli/src/lib/help.ts:196-351`.
- Sentry completion: `~/Code/getsentry/cli/packages/cli/src/lib/completions.ts:54-687`.
- Sentry skill generator: `~/Code/getsentry/cli/packages/cli/script/generate-skill.ts:739-920`.
- Sentry atomic skill installer: `~/Code/getsentry/cli/packages/cli/src/lib/agent-skills.ts:52-196`.
- Sentry setup/upgrade refresh: `~/Code/getsentry/cli/packages/cli/src/commands/cli/setup.ts:288-441` and
  `~/Code/getsentry/cli/packages/cli/src/commands/cli/upgrade.ts:484-600`.
