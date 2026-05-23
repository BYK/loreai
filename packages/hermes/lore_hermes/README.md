# lore-hermes

Lore memory integration for [Hermes Agent](https://github.com/NousResearch/hermes-agent).

Gives Hermes three-tier cross-session memory with distillation, hybrid
recall, and gradient context management via the [Lore](https://withlore.ai)
gateway.

## Install

```bash
pip install lore-hermes
```

## Usage

### Recommended: `lore run hermes`

```bash
lore run hermes
```

This starts the Lore gateway and launches Hermes with LLM calls routed
through it. The plugin auto-detects the gateway and disables Hermes's
built-in compressor so the gateway handles all context management.

### Standalone

```bash
lore start        # start the gateway in the background
hermes            # plugin discovers the gateway automatically
```

Or just run `hermes` directly -- the plugin will attempt to start the
gateway if `lore` is on PATH.

## What you get

- **Cross-session memory**: every conversation stored with full-text and
  vector search
- **Distillation**: conversations compressed into timestamped observations
  that preserve operational details
- **Knowledge curation**: LLM-driven extraction of long-term knowledge
  (decisions, patterns, gotchas, preferences, architecture)
- **Gradient context management**: 4-layer progressive compression instead
  of lossy summarization
- **Hybrid recall**: BM25 + vector + LLM query expansion + Reciprocal Rank
  Fusion
- **Cache warming**: predictive prompt cache pre-warming during idle periods
- **Cost tracking**: per-session cost recording with counterfactual savings

## CLI commands

```bash
hermes lore status           # gateway connection + project stats
hermes lore recall <query>   # search cross-session memory
hermes lore recall <query> --scope knowledge --limit 5
```

## Requirements

- [Hermes Agent](https://github.com/NousResearch/hermes-agent) installed
- [Lore](https://withlore.ai) installed (`curl -fsSL https://withlore.ai/install | bash`)
- Python >= 3.11

## License

FSL-1.1-Apache-2.0
