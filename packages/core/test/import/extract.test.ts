import { describe, test, expect, vi } from "vitest";
import { ensureProject } from "../../src/db";
import * as ltm from "../../src/ltm";
import { extractKnowledge } from "../../src/import/extract";
import type { ConversationChunk } from "../../src/import/types";
import type { LLMClient } from "../../src/types";

const PROJECT_PATH = "/test/extract-project";

function makeChunk(
  overrides: Partial<ConversationChunk> = {},
): ConversationChunk {
  return {
    label: "Test chunk (1)",
    text: "[user] How do I fix the SQLITE_BUSY error?\n\n[assistant] Use WAL mode and set a busy_timeout.",
    estimatedTokens: 100,
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeMockLLM(response: string | null): LLMClient {
  return {
    prompt: vi.fn(() => Promise.resolve(response)),
  };
}

describe("extractKnowledge", () => {
  test("setup: create test project", () => {
    ensureProject(PROJECT_PATH);
  });

  test("creates knowledge entries from LLM response", async () => {
    const llm = makeMockLLM(
      JSON.stringify([
        {
          op: "create",
          category: "gotcha",
          title: "SQLite WAL mode",
          content: "Always use WAL mode for concurrent access.",
          scope: "project",
          crossProject: true,
        },
      ]),
    );

    const result = await extractKnowledge({
      llm,
      projectPath: PROJECT_PATH,
      chunks: [makeChunk()],
    });

    expect(result.created).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.chunksProcessed).toBe(1);
    expect(result.chunksFailed).toBe(0);
    expect(result.chunksAnswered).toBe(1);

    // Verify entry was actually created
    const entries = ltm.forProject(PROJECT_PATH, false);
    const found = entries.find((e) => e.title === "SQLite WAL mode");
    expect(found).toBeDefined();
    expect(found?.category).toBe("gotcha");
  });

  test("handles empty LLM response", async () => {
    const llm = makeMockLLM("[]");

    const result = await extractKnowledge({
      llm,
      projectPath: PROJECT_PATH,
      chunks: [makeChunk()],
    });

    expect(result.created).toBe(0);
    expect(result.chunksProcessed).toBe(1);
    expect(result.chunksFailed).toBe(0);
    // The model answered (with an empty list) — this counts as answered, so a
    // caller may safely mark the source imported (nothing worth keeping).
    expect(result.chunksAnswered).toBe(1);
  });

  test("handles null LLM response", async () => {
    const llm = makeMockLLM(null);

    const result = await extractKnowledge({
      llm,
      projectPath: PROJECT_PATH,
      chunks: [makeChunk()],
    });

    expect(result.created).toBe(0);
    expect(result.chunksProcessed).toBe(1);
    expect(result.chunksFailed).toBe(0);
    // A null response is the no-auth signal (prompt returns null without
    // throwing). chunksAnswered stays 0 so callers do NOT mark the source
    // imported — a later run with a credential retries.
    expect(result.chunksAnswered).toBe(0);
  });

  test("handles LLM errors gracefully", async () => {
    const llm: LLMClient = {
      prompt: vi.fn(() => Promise.reject(new Error("API error"))),
    };

    const result = await extractKnowledge({
      llm,
      projectPath: PROJECT_PATH,
      chunks: [makeChunk()],
    });

    expect(result.created).toBe(0);
    expect(result.chunksProcessed).toBe(0);
    expect(result.chunksFailed).toBe(1);
    expect(result.chunksAnswered).toBe(0);
  });

  test("processes multiple chunks sequentially", async () => {
    const callOrder: number[] = [];
    let callCount = 0;
    const llm: LLMClient = {
      prompt: vi.fn(async () => {
        callOrder.push(++callCount);
        return "[]";
      }),
    };

    const chunks = [
      makeChunk({ label: "Chunk 1", timestamp: 1000 }),
      makeChunk({ label: "Chunk 2", timestamp: 2000 }),
      makeChunk({ label: "Chunk 3", timestamp: 3000 }),
    ];

    const result = await extractKnowledge({
      llm,
      projectPath: PROJECT_PATH,
      chunks,
    });

    expect(result.chunksProcessed).toBe(3);
    // Should be called sequentially (in order)
    expect(callOrder).toEqual([1, 2, 3]);
  });

  test("reports progress via callback", async () => {
    const llm = makeMockLLM("[]");
    const progressUpdates: Array<{ current: number; total: number }> = [];

    await extractKnowledge({
      llm,
      projectPath: PROJECT_PATH,
      chunks: [makeChunk({ timestamp: 1 }), makeChunk({ timestamp: 2 })],
      onProgress: (p) =>
        progressUpdates.push({ current: p.current, total: p.total }),
    });

    expect(progressUpdates).toEqual([
      { current: 1, total: 2 },
      { current: 2, total: 2 },
    ]);
  });

  test("sorts chunks chronologically before processing", async () => {
    const processedLabels: string[] = [];
    const llm: LLMClient = {
      prompt: vi.fn(async (_sys: string, user: string) => {
        // Extract a label marker from the user prompt
        if (user.includes("CHUNK-A")) processedLabels.push("A");
        if (user.includes("CHUNK-B")) processedLabels.push("B");
        if (user.includes("CHUNK-C")) processedLabels.push("C");
        return "[]";
      }),
    };

    await extractKnowledge({
      llm,
      projectPath: PROJECT_PATH,
      chunks: [
        makeChunk({ text: "CHUNK-C", timestamp: 3000 }),
        makeChunk({ text: "CHUNK-A", timestamp: 1000 }),
        makeChunk({ text: "CHUNK-B", timestamp: 2000 }),
      ],
    });

    expect(processedLabels).toEqual(["A", "B", "C"]);
  });

  describe("auth-rejected abort (wasRecentChunkAuthRejected)", () => {
    test("null LLM response + probe returns false → loop continues (existing no-auth semantics)", async () => {
      // Distinct from the auth-abort path: a null response with no probe
      // signal leaves the loop intact — `llm.prompt` returned null but no
      // 401 was attributed. Callers see `chunksAnswered === 0` and the
      // familiar "no response from the model" message; this preserves the
      // pre-abort behavior when the gateway doesn't inject a probe.
      const llm = makeMockLLM(null);

      const result = await extractKnowledge({
        llm,
        projectPath: PROJECT_PATH,
        chunks: [makeChunk(), makeChunk(), makeChunk()],
      });

      expect(result.abortedByAuth).toBe(false);
      expect(result.chunksProcessed).toBe(3);
      expect(result.chunksFailed).toBe(0);
      expect(result.chunksAnswered).toBe(0);
    });

    test("null LLM response + probe reports auth-rejected on chunk 1 → abort, rest skipped (#1454 follow-up)", async () => {
      // The motivating bug: a 71-chunk import with a broken credential used to
      // burn 71 doomed LLM requests + 71 Sentry captures before exiting with a
      // generic "no response from the model" message. Aborting after chunk 1
      // turns that into one failed request + one actionable error.
      const llm = makeMockLLM(null);
      const probe = vi.fn(() => true);

      const result = await extractKnowledge({
        llm,
        projectPath: PROJECT_PATH,
        chunks: [
          makeChunk({ label: "Chunk 1", timestamp: 1000 }),
          makeChunk({ label: "Chunk 2", timestamp: 2000 }),
          makeChunk({ label: "Chunk 3", timestamp: 3000 }),
        ],
        wasRecentChunkAuthRejected: probe,
      });

      expect(result.abortedByAuth).toBe(true);
      expect(result.chunksProcessed).toBe(1); // exactly one chunk was attempted
      expect(result.chunksFailed).toBe(1); // counted as a failure for the summary
      expect(result.chunksAnswered).toBe(0);
      // Probe consulted once — after the one chunk that aborted.
      expect(probe).toHaveBeenCalledTimes(1);
      // The LLM was called exactly once: not for chunks 2 or 3.
      expect((llm.prompt as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
        1,
      );
    });

    test("probe fires only on null responses; valid responses never trip the abort", async () => {
      // A chunk that returns a valid answer is NOT a candidate for the abort —
      // even if worker-health's auth-rejected flag is sticky from an earlier
      // failure. The probe is a SHAPE check (recent failure attributed to
      // this run), consulted only when `llm.prompt` returned null.
      const probe = vi.fn(() => true); // always-true probe (pathological)
      const llm = makeMockLLM("[]"); // empty-but-valid answer

      const result = await extractKnowledge({
        llm,
        projectPath: PROJECT_PATH,
        chunks: [makeChunk(), makeChunk()],
        wasRecentChunkAuthRejected: probe,
      });

      expect(result.abortedByAuth).toBe(false);
      expect(result.chunksProcessed).toBe(2);
      expect(result.chunksAnswered).toBe(2);
      // Probe NEVER consulted on a non-null response.
      expect(probe).not.toHaveBeenCalled();
    });

    test("mixed: null on chunk 1 with probe=true aborts; later chunks never fire", async () => {
      // Defense-in-depth: even if chunk 1's null is an OOM/null-quirk (not
      // truly auth-rejected) the abort is "best-effort, single chunk burned"
      // — never the whole batch. Distinct from the previous behavior where
      // a single broken credential burned the full batch.
      const probe = vi.fn(() => true);

      const result = await extractKnowledge({
        llm: makeMockLLM(null),
        projectPath: PROJECT_PATH,
        chunks: Array.from({ length: 71 }, (_, i) =>
          makeChunk({ label: `Chunk ${i + 1}`, timestamp: i * 1000 }),
        ),
        wasRecentChunkAuthRejected: probe,
      });

      expect(result.abortedByAuth).toBe(true);
      // The whole point of the fix: 1 attempted, 70 NOT attempted.
      expect(result.chunksProcessed).toBe(1);
      expect((probe as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    });

    test("empty chunks array → fast-path returns zeros, abortedByAuth stays false", async () => {
      // The empty-input fast-path must not poison abortedByAuth — with no
      // chunks there was no LLM call to attribute failure to. The default
      // zero result is the contract callers see on a "no work" run.
      const llm = makeMockLLM("[]");
      const result = await extractKnowledge({
        llm,
        projectPath: PROJECT_PATH,
        chunks: [],
        wasRecentChunkAuthRejected: () => true,
      });

      expect(result.abortedByAuth).toBe(false);
      expect(result.chunksProcessed).toBe(0);
      expect(result.chunksAnswered).toBe(0);
    });

    test("aborted run still fires onProgress with the partial total so CLI spinner clears", async () => {
      // The CLI writes a single \r-progress line on every chunk; without
      // clearing that line on the abort path, the user sees a stale "Chunk
      // 1/71 — 0 created, 0 updated" frozen in their terminal. The abort
      // path MUST fire onProgress one last time before returning.
      const progressUpdates: Array<{ current: number; total: number }> = [];
      await extractKnowledge({
        llm: makeMockLLM(null),
        projectPath: PROJECT_PATH,
        chunks: [
          makeChunk({ timestamp: 1000 }),
          makeChunk({ timestamp: 2000 }),
        ],
        onProgress: (p) =>
          progressUpdates.push({ current: p.current, total: p.total }),
        wasRecentChunkAuthRejected: () => true,
      });

      // Exactly one progress event: chunk 1, total 2. No further event from
      // the chunk-2 path because the loop aborted before reaching it.
      expect(progressUpdates).toEqual([{ current: 1, total: 2 }]);
    });
  });
});
