---
title: Troubleshoot Lore
description: Find help for a missing session, unavailable gateway, absent knowledge, authentication errors, or unexpected usage.
---

Start with the symptom you can observe. Run `lore doctor` from the affected project
and read the relevant finding; optional checks do not all need to be green.

## Missing session

**Symptom:** the agent answers, but no recorded session or message appears in Lore.

1. Confirm you used [the connection path for your agent](/docs/install/), not an
   independently launched client that bypasses Lore.
2. Open the Dashboard URL printed by the running gateway. Check the project picker
   and clear any session-list search filter.
3. Send a fresh message, then open the recorded session. You can cross-check local
   stored sessions with `lore data list sessions`.
4. For Codex Desktop, fully quit and reopen the app after setup. For Pi, check the
   extension is installed and loaded. Use the client guide for routing overrides.

If configuration exists but new messages never appear, the connection is not yet
verified. [First-session checklist](/docs/first-session/#verify).

## Lore command not found

Open a new terminal after installation. Check the installer's printed destination
and whether that directory is in your `PATH`. Run `lore --version` again.
[Installed paths and alternative runtimes](/docs/installation-reference/#what-the-installer-writes).

## Gateway unavailable

Check that Lore is running and use its printed Dashboard URL rather than assuming
a fixed port. If you launch a client separately, the gateway must remain available.
Run `lore doctor` and inspect the gateway/process findings before restarting.

## Knowledge has not appeared

A recorded session can exist before distillation or curation produces knowledge.
One short message is not a reliable extraction test. Check **Sessions** first,
then the project's **Knowledge** view and relevant processing details. Review
worker/provider errors and configuration before repeatedly importing or restarting.
[What Lore stores](/docs/memory/) explains these separate stages.

## Authentication or provider error

Make sure the agent is authenticated with its provider. Provider credentials and
remote-gateway access credentials have different purposes; changing a base URL does
not create either credential. Follow the relevant integration or
[custom upstream guide](/docs/guides/custom-upstreams/). Do not paste tokens into an issue.

## Wrong project or missing earlier history

Select the expected project in the local browser and check which directory launched
the agent. Worktrees and monorepos can have multiple paths. Before importing older
history, run `lore import --dry-run` and inspect its selected sources.
[Worktrees and imports](/docs/import/#worktrees--monorepos).

## Unexpected usage

Open **Providers & costs** to inspect recorded spending estimates and background
work. Imports, distillation, and curation can make model calls. **Model usage**
counts session-days and is a different measure. [Understand the costs](/docs/data-and-costs/).

## Ask for help

[Open a GitHub issue](https://github.com/BYK/loreai/issues/new/choose) with the Lore
version, OS, agent, connection method, expected result, and the relevant diagnostic
finding. Remove credentials, private project paths, and conversation text from any
logs or screenshots you choose to share.
