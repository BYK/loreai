---
title: Hermes with Lore
description: Launch an existing Hermes Agent through Lore and verify the recorded session.
---

Have Hermes Agent installed and authenticated first. Install Lore using the
[shared setup guide](/docs/install/?agent=hermes), then run this in your project:

```bash
lore run hermes
```

Lore launches Hermes with the gateway's OpenAI-compatible URL and the custom
inference-provider setting for that invocation. Send a message and verify it in
**Sessions** using [the first-session checklist](/docs/first-session/?agent=hermes#verify).

## Persistent setup

If you launch Hermes independently, `lore setup hermes` writes routing settings
into Hermes's `.env` file and saves prior values for undo. A named provider in
Hermes's configuration can override those environment values. Read
[the setup reference](/docs/setup/#per-harness-notes) before choosing this path.
The gateway must be running when the client sends requests.

## Next steps

- [Verify a recorded session](/docs/first-session/?agent=hermes#verify).
- [Use Lore day to day](/docs/using-lore/).

[Use your recorded memory](/docs/using-lore/), [import earlier conversations](/docs/import/),
or [troubleshoot a missing session](/docs/troubleshooting/#missing-session).
