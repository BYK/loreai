---
title: Data and costs
description: Understand local storage, configured providers, operational telemetry, and usage estimates.
---

Local storage and model processing are different boundaries. A local database does
not make requests to a configured remote model provider stay on your machine.

## Where information goes

| Destination | What it is used for |
| --- | --- |
| Local SQLite database | Stored conversations, distilled context, knowledge, and related search data |
| Project `.lore.md` | Reviewable project knowledge; can be shared when you commit it to Git |
| Configured model providers | Agent requests and background model work such as distillation and curation |
| Configured embedding provider | Recall embeddings; local by default, with hosted options and fallbacks depending on configuration |
| Operational telemetry | Privacy-filtered usage, performance, and error metadata in production builds; enabled by default |

Git-based sharing exports curated knowledge, not the complete conversation database.
Folk Lore's hosted team experience is early access; joining its list does not enable sync.

## Telemetry choice

To opt out, set this **before starting Lore**:

```bash
export SENTRY_ENABLED=0
```

Automatic telemetry excludes prompts and response bodies. Read the
[complete collected fields and exclusions](/docs/installation-reference/#operational-telemetry)
for the precise boundary; this opt-out does not change what your configured model providers receive.

## What can incur model charges?

Your normal agent requests use its configured provider. Background distillation,
curation, and conversation imports can make additional model calls. Models,
conversation size, configuration, and provider terms affect cost. Lower spending
is not guaranteed for every workload.

Preview an import before processing it:

```bash
lore import --dry-run
```

The dry run inspects sources without curator model calls. Review its output and
[the import guide](/docs/import/) before proceeding with a large history.

## Inspect usage

- **Providers & costs** shows available recorded spend estimates, background-work
  costs, and provider quota information when observed.
- **Model usage** counts distinct recorded sessions per model and UTC day. It does
  not measure billed dollars or establish model switches within a conversation.
- Provider bills and account consoles remain the source for actual charges.

Review [worker model configuration](/docs/configuration/#workermodel) and
[knowledge injection behavior](/docs/guides/tune-knowledge-injection/) when tuning.
The `.lore.json` `budget` setting allocates **context space**, not a dollar spending cap.

## Undo or remove Lore

[Setup undo](/docs/setup/#undoing-setup) restores applicable routing settings.
[Uninstall](/docs/installation-reference/#uninstall) explains what is removed and
what memory is preserved. Deleting an active knowledge entry is not the same as
purging conversation history or removing copies already committed to Git.
