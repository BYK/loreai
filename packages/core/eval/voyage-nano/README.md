# Voyage 4 nano embedding pilot (#1899)

This is a **small, synthetic retrieval diagnostic**, seeded from the existing
`DEC-1` and `MSR-1` anchored eval scenarios. The documents are edited excerpts,
not the actual Lore database, actual Lore end-to-end recall, a four-session load
test, or evidence that the local model should change. No production memories or
API keys are used. The eval always prints FTS-only, vector-only and a simple
RRF proxy separately. `score.py` uses one FTS5 table and two RRF lists; Lore's
real recall path has source-specific indexes, query expansion, policy, graph
signals, budgets and workload pressure that require separate tests.

## Run

The [Voyage Nano retrieval pilot workflow](../../../../.github/workflows/voyage-nano-eval.yml)
runs on pushes to its evaluation branch and can be triggered manually once it
is on the default branch. It downloads public weights on a GitHub-hosted CPU
runner and uploads the synthetic vectors, dependency versions and scored report. The
runner's timings are useful for comparing models in that runner only; they
cannot establish whether Nano resolves #1898 on the four-core homelab.
The workflow also probes a **third-party** ONNX INT8 conversion, pins its
revision and checks its vectors against the official Nano BF16 result. The
reported memory includes each full process, not just model weights. A smaller
model file alone does not establish compatible vectors or acceptable CPU load.

From the repository root on a machine that can download model weights:

```bash
pnpm install --frozen-lockfile
python -m venv /tmp/lore-voyage-eval
/tmp/lore-voyage-eval/bin/pip install 'torch>=2.4' 'sentence-transformers>=5,<6' 'transformers>=4.51,<5'
node packages/core/eval/voyage-nano/embed-nomic.mjs \
  packages/core/eval/voyage-nano/cases.json /tmp/nomic-768.json
LORE_EVAL_THREADS=2 /tmp/lore-voyage-eval/bin/python \
  packages/core/eval/voyage-nano/embed-nano.py \
  packages/core/eval/voyage-nano/cases.json /tmp/nano-512.json --dimensions 512
LORE_EVAL_THREADS=2 /tmp/lore-voyage-eval/bin/python \
  packages/core/eval/voyage-nano/embed-nano.py \
  packages/core/eval/voyage-nano/cases.json /tmp/nano-1024.json --dimensions 1024
python packages/core/eval/voyage-nano/score.py \
  packages/core/eval/voyage-nano/cases.json \
  /tmp/nomic-768.json /tmp/nano-512.json /tmp/nano-1024.json \
  > /tmp/voyage-nano-report.json
```

`embed-nomic.mjs` reproduces the current Nomic worker's q8, mean pooling,
full-dimension layer normalization, prefixes and L2 normalization. It runs in
a standalone process, outside Lore's worker and memory-cap admission path.
`embed-nano.py` uses Voyage's published SentenceTransformers implementation:
`encode_query` and `encode_document` supply **different prompts**; output is
truncated and normalized by the model's published pipeline. The model revision
is pinned. If the local SentenceTransformers implementation changes, record its
package versions and model revision before comparing. This pilot uses the
official BF16 weight path, so comparisons to Nomic INT8 include a precision
difference. Test an independently verified quantized nano artifact later.

If you have matching JSON outputs from a trusted hosted `voyage-4`, `-lite`
or `-large` embedding client in the same format, supply them together with
the nano 1024 result and add `--mix-voyage` to `score.py`. The scorer validates
dimensions and a strict general Voyage 4 family allowlist before comparing
cross-model query/document vectors. Keep hosted test documents opt-in.

Set `LORE_EVAL_ORT_THREADS=2` and run both on an idle four-core host; capture
total wall and CPU time, RSS and p50/p95 latency. Run repetitions on each
machine and report variation. For the #1898 gate, run Lore's **actual gateway**
at four concurrent heavy sessions, keep the same sessions and retrieval budget
across models, and record foreground 503s, queue deadlines, event-loop delay,
read latency and total CPU. The standalone script cannot reproduce that
contention or measure indexing/backfill throughput.

The FTS-only control on the ten seeded questions currently yields recall@1
`0.50`, recall@5 `0.90`, MRR@10 `0.6243` and stale@5 `0.70`. These numbers
describe **only the synthetic fixture** and must not be extrapolated to Lore.
The `stale@5` field means a superseded document appears in the retrieved top
five; it does not mean Lore would put a stale answer in its final response.

## Shared space and switching

Voyage states that `voyage-4-nano`, `voyage-4-lite`, `voyage-4` and
`voyage-4-large` share one embedding space **at a matched dimension**.
For an API comparison, explicitly request `output_dimension: 1024` with
`input_type: document` / `query`, then compare both directions against nano
1024. Voyage's current API model list does **not** offer nano as an API model;
the intended toggle would be local nano ↔ hosted `voyage-4[-lite/-large]`.
Do not include `voyage-code-4` in this compatible set without an independent
provider guarantee. No API calls are made by this pilot.

Lore currently fingerprints vectors by provider/model/dimension and rebuilds
them when the fingerprint changes. Preserve that safeguard. A future shared
space toggle needs an explicit audited compatibility group and provenance per
vector; Nomic vectors can never be searched as Voyage vectors. Hosted use must
be an explicit privacy choice, with an offline path and re-embedding/migration
policy tested before any production config is added.

## Remaining acceptance work

1. Grow this fixture with labelled, permissioned real Lore memory and hard
   negatives across knowledge, temporal, distillation and entity sources.
2. Run the existing Lore end-task harness with identical source data and
   anchored facts. Report quality and confidence bounds at equal budgets.
3. Profile package size, cold start, quantization, indexing throughput and
   four-session pressure on the four-core host.
4. If quality and pressure gates pass, prototype an opt-in local nano provider
   with correct pooling/prompting plus explicit hosted switching. No default
   changes or vector-space mixing are included here.

Primary references: [Voyage model card](https://huggingface.co/voyageai/voyage-4-nano),
[Voyage embeddings docs](https://docs.voyageai.com/docs/embeddings).
