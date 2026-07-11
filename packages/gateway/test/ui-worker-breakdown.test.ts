import { db, ensureProject, saveSessionCosts } from "@loreai/core";
import { describe, expect, it } from "vitest";
import { invalidateHistoricalCache } from "../src/cost-tracker";
import { handleUIRequest, renderWorkerBreakdownRows } from "../src/ui";

// Coverage for the costs-dashboard "Lore Overhead" per-bucket breakdown rows
// (worker-cost-breakdown feature, #1268). The rows attribute worker spend to
// distillation / curation / compaction / recall; buckets with zero cost are
// omitted, and warmup is intentionally excluded (surfaced separately).

describe("renderWorkerBreakdownRows", () => {
  it("renders one row per non-zero bucket with its cost and call count", () => {
    const html = renderWorkerBreakdownRows({
      distillation: { cost: 0.5, calls: 4 },
      curation: { cost: 0.2, calls: 2 },
      compaction: { cost: 0.05, calls: 1 },
      recall: { cost: 0.03, calls: 3 },
    });
    // All four labels present, in order.
    for (const label of ["distillation", "curation", "compaction", "recall"]) {
      expect(html).toContain(`— ${label}`);
    }
    // Exactly four <tr> rows.
    expect(html.match(/<tr>/g) ?? []).toHaveLength(4);
    // Formatted USD + call counts surfaced.
    expect(html).toContain("$0.50");
    expect(html).toContain("$0.20");
    expect(html).toContain("&times;4");
    expect(html).toContain("&times;3");
  });

  it("omits buckets whose cost is zero (the empty-row branch)", () => {
    const html = renderWorkerBreakdownRows({
      distillation: { cost: 0.5, calls: 4 },
      curation: { cost: 0, calls: 0 },
      compaction: { cost: 0, calls: 0 },
      recall: { cost: 0.03, calls: 3 },
    });
    expect(html).toContain("— distillation");
    expect(html).toContain("— recall");
    expect(html).not.toContain("— curation");
    expect(html).not.toContain("— compaction");
    expect(html.match(/<tr>/g) ?? []).toHaveLength(2);
  });

  it("renders nothing when every bucket is zero", () => {
    const html = renderWorkerBreakdownRows({
      distillation: { cost: 0, calls: 0 },
      curation: { cost: 0, calls: 0 },
      compaction: { cost: 0, calls: 0 },
      recall: { cost: 0, calls: 0 },
    });
    expect(html).toBe("");
  });
});

describe("/ui/costs renders the worker breakdown end-to-end", () => {
  it("includes per-bucket rows when a session has a persisted breakdown", async () => {
    // Deterministic aggregate: wipe the rollup source + memoized estimate.
    db().exec(
      "DELETE FROM temporal_messages; DELETE FROM distillations; DELETE FROM session_rollup;",
    );
    const pid = ensureProject("/test/ui-costs-breakdown", "ui-bd");
    const sid = "sess-ui-bd";
    const now = Date.now();
    // A message so the session shows up in the historical rollup iteration.
    db()
      .query(
        `INSERT INTO temporal_messages
           (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata)
         VALUES (?, ?, ?, 'assistant', 'c', 100, 0, ?, NULL)`,
      )
      .run("uim-bd-1", pid, sid, now);
    saveSessionCosts(sid, {
      conversationCost: 1.0,
      workerCost: 0.75,
      conversationTurns: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      warmupSavings: 0,
      warmupCost: 0,
      warmupHits: 0,
      ttlSavings: 0,
      ttlHits: 0,
      batchSavings: 0,
      avoidedCompactions: 0,
      avoidedCompactionCost: 0,
      workerBreakdown: {
        distillation: { cost: 0.5, calls: 4 },
        curation: { cost: 0.2, calls: 2 },
        compaction: { cost: 0.03, calls: 1 },
        recall: { cost: 0.02, calls: 3 },
        warmup: { cost: 0, calls: 0 },
      },
    });
    invalidateHistoricalCache();

    const url = new URL("http://localhost/ui/costs");
    const res = await handleUIRequest(new Request(url), url);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("Lore Overhead");
    expect(html).toContain("— distillation");
    expect(html).toContain("— curation");
  });
});
