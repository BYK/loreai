/**
 * Regression tests for issue #741.
 *
 * The per-turn "Context health" note used to be appended to system[2] when the
 * gradient compressed context (layer ≥1). Its wording varied by layer, which
 * busted the conversation cache on every layer oscillation because system[2]
 * has no cache_control of its own. The note has been removed; its one unique
 * signal (verify omitted specifics via recall) now lives statically in the
 * recall tool description, which never busts the cache.
 */
import { describe, test, expect } from "vitest";
import { RECALL_GATEWAY_TOOL } from "../src/recall";

describe("context-health note removed from system[2] (#741)", () => {
  test("recall tool description carries the folded lossy-detail nudge", () => {
    const d = RECALL_GATEWAY_TOOL.description;
    expect(d).toContain("rejected alternatives");
    expect(d).toContain("use recall to verify");
  });

  test("no per-layer adjective wording leaked into the recall description", () => {
    const d = RECALL_GATEWAY_TOOL.description;
    expect(d).not.toContain("aggressively compressed");
    expect(d).not.toContain("emergency compressed");
    // The bracketed system-block marker must never appear in a tool description.
    expect(d).not.toContain("[Context health:");
  });
});
