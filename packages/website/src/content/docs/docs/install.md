---
title: Install Lore
description: Choose your coding agent, install Lore, connect a session, and verify that it is recorded.
sidebar:
  order: 1
---

Choose a client, connect Lore, and verify a recorded session. You’ll need an
existing supported coding agent and its provider authentication.

:::note[Telemetry]
Production telemetry is on by default; set `SENTRY_ENABLED=0` before starting Lore
to opt out. [Data and provider details](#operational-telemetry).
:::

## 1. Choose your agent

Use the guide for the client you already have. Each guide covers its routing and
configuration requirements:

- [Claude Code](/docs/guides/with-claude-code/) — launch the terminal client through Lore.
- [Codex](/docs/guides/with-codex/) — terminal launch and persistent Desktop setup.
- [OpenCode](/docs/guides/with-opencode/) — gateway and plugin integration.
- [Pi](/docs/guides/with-pi/) — gateway and extension integration.
- **Hermes** — supported by the launcher; use `lore run` from the project directory.

For a remote gateway or another provider, start with
[setup](/docs/setup/) and [custom upstreams](/docs/guides/custom-upstreams/).

## 2. Install and check the executable

Run the hosted installer in your terminal:

```bash
curl -fsSL https://withlore.ai/install | bash
```

This downloads the standalone executable and may update your shell’s `PATH`.
Review [what the installer writes](#what-the-installer-writes) if you want to
inspect those changes first. Check that the command is available:

```bash
lore --version
```

If your shell cannot find `lore`, open a new terminal after installation and
check the installer’s output for the installation directory.

## 3. Connect from your project

Agent requests and Lore’s background model work use your configured providers
and may incur charges. For a terminal agent, change to your project directory and run:

```bash
lore run
```

Lore starts the gateway and launches a detected supported agent with routing
configured for that invocation. Follow any authentication or client-selection
prompts. This path does not require persistent `lore setup` configuration.

### Codex Desktop or an independently launched client

For Codex Desktop, configure routing once, start a local gateway, and relaunch
the app:

```bash
lore setup codex
lore start --bg --local
```

Persistent setup changes client configuration and saves a backup.
[Read setup and undo instructions](/docs/setup/). Other clients have their own
manual setup steps in the guides above.

## 4. Verify the connection

1. Send a normal message from the connected agent.
2. Open the **Dashboard URL printed by Lore** to inspect the local memory browser.
3. Look for the project and its recorded session. This verifies actual activity;
   a saved client configuration alone does not prove requests passed through Lore.

If the gateway or session is missing, run diagnostics:

```bash
lore doctor
```

Read the findings rather than assuming every check must be green. You can also
inspect stored sessions with `lore data list sessions`.

:::note[Knowledge comes later]
A `.lore.md` file may not appear after one message. Distillation and curation run
in the background and depend on conversation volume and configuration. First
verify the recorded session, then inspect the knowledge Lore extracts.
:::

## Next steps

- [Import existing conversations](/docs/import/) to bring earlier work into memory.
- [Review and share project knowledge](/docs/team-memory/) through `.lore.md` and Git.
- [Understand the architecture](/docs/architecture/) and [configuration](/docs/configuration/).

## Reference

The [installer and uninstall reference](/docs/installation-reference/) retains
full path, telemetry, runtime, lifecycle, and cleanup information.

### Operational telemetry

Production builds send privacy-filtered operational telemetry by default;
prompts and response bodies are excluded from automatic collection. Set
`SENTRY_ENABLED=0` before starting Lore to opt out. [Read the full fields and
privacy boundaries](/docs/installation-reference/#operational-telemetry).

### What the installer writes

The hosted installer downloads the executable, records its install generation,
and may update your shell profile. [See every installed/runtime path](/docs/installation-reference/#what-the-installer-writes).

### Uninstall

Use `lore uninstall --dry-run` to inspect the cleanup plan before uninstalling.
[Read preservation, purge, package-manager, and platform details](/docs/installation-reference/#uninstall).

### Other installation options

You can run the gateway through npm:

```bash
npx @loreai/gateway
```

The npm packages require Node.js 22.16+ in the 22.x line, or Node.js 24+;
Node.js 23 is excluded. With no subcommand, this uses the same default agent-launch flow as `lore run`.
Use your client’s guide for persistent or independently launched setups.

### Slimmer installs (remote embeddings)

[Read about optional local-runtime dependencies and remote embeddings](/docs/installation-reference/#slimmer-installs-remote-embeddings).

### Existing Conversations

Use `lore import` to select supported local conversation sources.
[Read the import guide](/docs/import/) or the [installation reference](/docs/installation-reference/#existing-conversations).
