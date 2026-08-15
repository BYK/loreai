---
title: Install Lore
description: Install Lore locally and launch your coding agent through the memory gateway.
sidebar:
  order: 1
---

Install Lore with the hosted install script:

```bash
curl -fsSL https://withlore.ai/install | bash
```

Then launch Lore with your detected coding agent:

```bash
lore run
```

Lore auto-detects Claude Code, OpenCode, Pi, Codex, and Hermes Agent when you run `lore run`. For harness-specific setup, see the Guides section.

## Operational telemetry

Production builds send privacy-filtered operational telemetry to Sentry by default. It can include a random persistent installation ID, credential and project-path hashes, conversation/session IDs, model and upstream origin, gateway port, token usage, estimated cost, performance traces, and fixed-category errors. Lore disables automatic collection of prompts, model responses, request or response bodies, headers, cookies, URL query values, file paths, project names, application logs, and stack-frame variables; a final transport scrubber removes those fields before transmission.

To opt out, set `SENTRY_ENABLED=0` before starting Lore:

```bash
export SENTRY_ENABLED=0
lore run
```

Development builds do not send telemetry unless explicitly enabled with `SENTRY_ENABLED=1`. Test processes always disable it.

## What the installer writes

The hosted install script downloads one standalone executable to `${LORE_INSTALL_DIR:-$HOME/.local/bin}/lore` (`lore.exe` on Windows). If that directory is not already on `PATH`, the script appends this marked block to the active shell profile (`~/.zshrc`, `~/.bashrc`, `~/.bash_profile`, `~/.profile`, or `~/.config/fish/config.fish`):

```sh
# Added by lore installer
export PATH='/home/you/.local/bin':"$PATH"
```

The installer records a generation-bound executable receipt in `~/.lore/install-path` so uninstall can distinguish the exact hosted standalone binary from package-managed copies. It writes the selected release channel (`stable` or `nightly`) to `${LORE_CONFIG_DIR:-$HOME/.lore}/channel`. Running Lore may subsequently create:

- `${XDG_DATA_HOME:-$HOME/.local/share}/lore/` for `lore.db`, logs, gateway PID/port files, and account/sync state
- `${LORE_CONFIG_DIR:-$HOME/.lore}/` for the release channel and update metadata (`channel`, `latest-version`, `version-check.json`, and `patch-cache/`); the standalone binary's extracted embedding model is always under `~/.lore/embeddings-vendored/`
- `~/.cache/lore/` for extracted worker files
- `.lore.md`, `.lore.json`, and a managed section in `AGENTS.md` or `CLAUDE.md` inside projects where those features are used

Lifecycle serialization and hosted-install provenance use the fixed per-user `~/.lore/` directory even when `LORE_CONFIG_DIR` is customized. `~/.lore/lifecycle.lock/` exists only while a normal setup/start/stop/upgrade/install/uninstall transition owns the lock; stale token-named lock claims may be retained after crash recovery. A successful verified hosted self-removal intentionally leaves `~/.lore/uninstalled.json` as a persistent, owner-only tombstone. It prevents an already-running old hosted binary from starting Lore again. A fresh hosted install, or a fresh invocation of the declared `@loreai/gateway` package CLI after package installation, verifies its own install generation before atomically clearing that tombstone. Unverified and Windows invocations that preserve the running executable do not create this tombstone.

`lore setup <app>` is separate from installation. It changes that app's config and saves a backup; see [Undoing setup](/docs/setup/#undoing-setup). `lore setup status` is read-only and recognizes both `~/.config/opencode/opencode.json` and OpenCode's supported `opencode.jsonc` form.

## Uninstall

To restore app configs, remove the hosted standalone executable recorded by the installer, remove the exact marked `PATH` block written by the installer, and clear disposable Lore caches while keeping your memory database:

```bash
lore uninstall
```

Inspect the resolved cleanup and preservation plan first with `lore uninstall --dry-run`. Setup restoration and shell-profile cleanup are summarized because their exact files are discovered and validated during execution. Preview mode does not run the live gateway, setup-backup, or filesystem preflight checks; the real command runs all of them before its first mutation. Uninstall refuses to continue while a gateway appears to be running; run `lore stop`, verify it stopped, and retry.

The command prints the preserved data directory. To also permanently delete the database, logs, stored Folk Lore session, and gateway state in the default data directory, use:

```bash
lore uninstall --purge
```

`--purge` prints the resolved cleanup plan, then asks for confirmation. Review the paths before answering. Use `lore uninstall --purge --yes` in a non-interactive shell only after previewing the same environment with `lore uninstall --purge --dry-run` immediately beforehand; the preview is not a filesystem snapshot.

For safety, uninstall does not recursively delete custom `XDG_DATA_HOME` / `LORE_CONFIG_DIR` locations or an external/relative `LORE_DB_PATH`; it prints those paths as preserved for manual review. Purgeable default directories are generation-bound: uninstall quarantines and verifies the exact directory checked during preflight, and refuses or preserves a replacement raced into the same pathname. A package-managed or otherwise unverified standalone executable is also preserved and must be removed through its installer or package manager. On Windows, the running standalone executable cannot delete itself. A fully verified hosted-install receipt still allows uninstall to transactionally remove only the exact installer-owned marked `PATH` block; unrelated profile content is preserved. The command retains the executable and receipt and prints their exact paths so you can delete both after uninstall exits. Preserved databases are never opened or modified during uninstall.

Uninstall never searches for or removes project-owned `.lore.md`, `.lore.json`, `AGENTS.md`, or `CLAUDE.md` files. Review and remove those per project if you no longer want the exported knowledge or managed instruction section.

If Lore was installed through npm rather than the hosted standalone installer, `lore uninstall` still restores setup and handles Lore data/cache cleanup, then prints the package-manager command to remove the CLI itself. It does not create a tombstone for a package-managed uninstall. If a valid tombstone remains from an earlier hosted uninstall, a fresh installed `@loreai/gateway` package invocation verifies its declared package entry before clearing it; stale hosted binaries remain blocked:

```bash
npm uninstall -g @loreai/gateway
```

If `lore setup opencode` installed the optional global OpenCode plugin, remove the package after setup has been undone:

```bash
npm uninstall -g @loreai/opencode
```

Pi extensions added manually to `~/.pi/settings.json` are not owned by the installer; remove `npm:@loreai/pi@latest` from the `packages` array and run `pi install`.

If you'd rather configure Codex manually (for the Codex Desktop app, or to run `codex` without going through `lore run`), run [`lore setup codex`](/docs/setup/) once — it writes `~/.codex/config.toml` with the gateway URL and the no-auto-compact override. See the [Setup command](/docs/setup/) page for the full reference.

You can also run the gateway directly with npm:

```bash
npx @loreai/gateway
```

## Slimmer installs (remote embeddings)

Lore's on-device (local) embeddings run through `@huggingface/transformers` and the ONNX runtime — about 480 MB of ML runtime that's pulled in when you `npm install` a Lore package (`@loreai/core`, `@loreai/opencode`, `@loreai/pi`). It's an **optional dependency**, so if you use a remote embedding provider — or don't need vector recall — you can skip it:

```bash
npm install @loreai/opencode --omit=optional
```

With the stack absent, recall degrades gracefully to FTS-only keyword search. To keep semantic recall without the local runtime, set a remote provider in `.lore.json` (`search.embeddings.provider` = `voyage` or `openai`, with the matching API key). The hosted install script and the standalone binary are unaffected — they ship their own runtime and never read `node_modules`.

## Existing Conversations

Lore can import previous coding conversations so a new project memory does not start from a blank slate:

```bash
lore import
```

Imported history feeds the same distillation and knowledge pipeline as live sessions. `lore import` detects Claude Code, Codex, OpenCode, Pi, Aider, Cline, and Continue, lets you pick which agents to import, and finds conversations across all of a repo's git worktrees.

→ See the full [Import conversations](/docs/import/) guide.
