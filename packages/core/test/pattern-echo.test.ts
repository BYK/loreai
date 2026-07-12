import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, ensureProject } from "../src/db";
import * as embedding from "../src/embedding";
import {
  _resetPatternEchoCooldownForTest,
  detectPatternEchoes,
  PATTERN_COOLDOWN_MS,
} from "../src/pattern-echo";
import type { LLMClient } from "../src/types";

// pattern-echo runs two jobs at the gen-0 distillation hook: (1) embed + store
// the segment (the embedDistillation() replacement — must always run so recall
// can find it), and (2) the EXPENSIVE pattern detection (project-wide vector
// search + clustering + an LLM call), which is rate-limited to once per session
// per cooldown. The bug these tests guard: the cooldown was armed only AFTER a
// successful ltm.create(), so the common "no pattern this time" outcome never
// armed it and the full search + cluster ran on every single distillation.

const PROJECT = "/test/pattern-echo";

function insertDistill(id: string, pid: string, session: string): void {
  db()
    .query(
      "INSERT INTO distillations (id, project_id, session_id, narrative, facts, source_ids, generation, token_count, created_at, embedding) VALUES (?, ?, ?, '', '', '', 0, 0, ?, NULL)",
    )
    .run(id, pid, session, Date.now());
}

function stubLLM(): LLMClient {
  return { prompt: vi.fn() };
}

describe("pattern-echo cooldown", () => {
  let embedSpy: ReturnType<typeof vi.spyOn>;
  let searchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Clear the module-global cooldown map so cases never leak into each other
    // (isolation no longer relies on each test using a unique session ID).
    _resetPatternEchoCooldownForTest();
    // A deterministic embedding so the embed + store step succeeds without ONNX.
    embedSpy = vi
      .spyOn(embedding, "embed")
      .mockResolvedValue([new Float32Array([1, 0, 0])]);
    // Return no candidates so the detection short-circuits before clustering /
    // the LLM — we only care here about WHETHER the search ran.
    searchSpy = vi
      .spyOn(embedding, "vectorSearchAllDistillations")
      .mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rate-limits the pattern search to once per session per cooldown, yet always stores the embedding", async () => {
    const pid = ensureProject(PROJECT);
    insertDistill("d1", pid, "s-cool");
    insertDistill("d2", pid, "s-cool");
    const base = {
      observations: "obs",
      projectPath: PROJECT,
      sessionID: "s-cool",
      llm: stubLLM(),
    };

    // First attempt: embeds + stores AND runs the (mocked) project-wide search.
    await detectPatternEchoes({ ...base, distillId: "d1" });
    expect(embedSpy).toHaveBeenCalledTimes(1);
    expect(searchSpy).toHaveBeenCalledTimes(1);

    // Second attempt within the cooldown: STILL embeds + stores the segment, but
    // the expensive search is skipped — the cooldown was armed unconditionally on
    // the first attempt even though it created nothing.
    await detectPatternEchoes({ ...base, distillId: "d2" });
    expect(embedSpy).toHaveBeenCalledTimes(2); // embedding always runs (job 1)
    expect(searchSpy).toHaveBeenCalledTimes(1); // search rate-limited (job 2)

    // The rate-limited segment still got its embedding — no recall gap. (Guards
    // against gating the embed behind the cooldown: pre-this-fix, a rate-limited
    // segment was returned before the embed and stored nothing.)
    const row = db()
      .query("SELECT embedding FROM distillations WHERE id = 'd2'")
      .get() as { embedding: Buffer | null };
    expect(row.embedding).not.toBeNull();
  });

  it("rate-limits per session, not globally", async () => {
    const pid = ensureProject(PROJECT);
    insertDistill("a1", pid, "s-A");
    insertDistill("b1", pid, "s-B");
    const common = {
      observations: "obs",
      projectPath: PROJECT,
      llm: stubLLM(),
    };

    await detectPatternEchoes({ ...common, sessionID: "s-A", distillId: "a1" });
    await detectPatternEchoes({ ...common, sessionID: "s-B", distillId: "b1" });

    // Distinct sessions each get their own attempt — the cooldown is keyed by
    // sessionID, so session B is not blocked by session A.
    expect(searchSpy).toHaveBeenCalledTimes(2);
  });

  it("allows a fresh attempt once the cooldown expires", async () => {
    vi.useFakeTimers();
    try {
      const pid = ensureProject(PROJECT);
      insertDistill("e1", pid, "s-exp");
      insertDistill("e2", pid, "s-exp");
      const base = {
        observations: "obs",
        projectPath: PROJECT,
        sessionID: "s-exp",
        llm: stubLLM(),
      };

      await detectPatternEchoes({ ...base, distillId: "e1" });
      expect(searchSpy).toHaveBeenCalledTimes(1);

      // Still within the cooldown → skipped.
      await detectPatternEchoes({ ...base, distillId: "e2" });
      expect(searchSpy).toHaveBeenCalledTimes(1);

      // Past the cooldown → a new attempt runs.
      vi.advanceTimersByTime(PATTERN_COOLDOWN_MS + 1);
      await detectPatternEchoes({ ...base, distillId: "e2" });
      expect(searchSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not arm the cooldown when the embed fails (a transient error doesn't suppress 10 min)", async () => {
    const pid = ensureProject(PROJECT);
    insertDistill("f1", pid, "s-fail");
    insertDistill("f2", pid, "s-fail");
    const base = {
      observations: "obs",
      projectPath: PROJECT,
      sessionID: "s-fail",
      llm: stubLLM(),
    };

    // First attempt: the embed throws (job 1) before the cooldown is armed, so
    // the failure is swallowed by detectPatternEchoes' .catch and the session is
    // NOT suppressed. (Guards the embed-before-arm ordering: arming first would
    // wrongly block the session for 10 min after one provider hiccup.)
    embedSpy.mockRejectedValueOnce(new Error("embed boom"));
    await detectPatternEchoes({ ...base, distillId: "f1" });
    expect(searchSpy).not.toHaveBeenCalled();

    // The embed recovers on the next segment → detection runs (not rate-limited).
    await detectPatternEchoes({ ...base, distillId: "f2" });
    expect(searchSpy).toHaveBeenCalledTimes(1);
  });
});
