import { afterEach, expect, test, vi } from "vitest";
import { db, ensureProject } from "../src/db";
import { storeEmbedding } from "../src/db/vec-store";
import * as embedding from "../src/embedding";
import * as ltm from "../src/ltm";
import { consolidate } from "../src/curator";
import { extractKnowledge } from "../src/import/extract";
import { rebuildEntitiesFromHistory } from "../src/entity-rebuild";
import { detectPatternEchoes } from "../src/pattern-echo";
import { detectContradictions } from "../src/contradiction";

let sequence = 0;
function scope() {
  const sessionID = `recovery-${sequence++}`;
  const projectPath = `/test/recovery/${sessionID}`;
  return { projectPath, sessionID, pid: ensureProject(projectPath) };
}
function history(pid: string, sessionID: string) {
  const id = crypto.randomUUID();
  db()
    .query(
      `INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, created_at) VALUES (?, ?, ?, '', '', 'Carol deployed the release.', '', 0, 20, ?)`,
    )
    .run(id, pid, sessionID, Date.now());
  return id;
}
afterEach(() => vi.restoreAllMocks());

for (const worker of ["import", "entity"] as const) {
  test.each(["[]", "{}", "not JSON", null])(
    `${worker} only recovers accepted output: %s`,
    async (text) => {
      const { projectPath, sessionID, pid } = scope();
      history(pid, sessionID);
      const llm = {
        prompt: vi.fn(async () => text),
        recordWorkerSuccess: vi.fn(),
      };
      if (worker === "import")
        await extractKnowledge({
          llm,
          projectPath,
          sessionID,
          chunks: [
            {
              label: "history",
              text: "Carol deployed the release.",
              estimatedTokens: 20,
              timestamp: 1,
            },
          ],
        });
      else await rebuildEntitiesFromHistory({ llm, projectPath, sessionID });
      expect(llm.prompt).toHaveBeenCalledOnce();
      expect(llm.recordWorkerSuccess).toHaveBeenCalledTimes(
        text === "[]" ? 1 : 0,
      );
      if (text === "[]")
        expect(llm.recordWorkerSuccess).toHaveBeenCalledWith(
          sessionID,
          worker === "import" ? "lore-import" : "lore-entity-rebuild",
        );
    },
  );
}

test("entity rebuild rejects late output before reporting recovery", async () => {
  const { projectPath, sessionID, pid } = scope();
  history(pid, sessionID);
  const controller = new AbortController();
  const llm = {
    prompt: vi.fn(async () => {
      controller.abort();
      return "[]";
    }),
    recordWorkerSuccess: vi.fn(),
  };
  const result = await rebuildEntitiesFromHistory({
    llm,
    projectPath,
    sessionID,
    signal: controller.signal,
  });
  expect(llm.prompt).toHaveBeenCalledOnce();
  expect(result.cancelled).toBe(true);
  expect(llm.recordWorkerSuccess).not.toHaveBeenCalled();
});

test.each(["[]", "not JSON"])(
  "consolidation only recovers accepted output: %s",
  async (text) => {
    const { projectPath, sessionID } = scope();
    for (const title of ["Deploy release", "Review migration"])
      ltm.create({
        projectPath,
        category: "gotcha",
        title,
        content: title,
        scope: "project",
      });
    const llm = { prompt: vi.fn(async () => text) };
    const workerHealth = { recordSuccess: vi.fn(), recordFailure: vi.fn() };
    await consolidate({
      llm,
      projectPath,
      sessionID,
      focusCategory: "gotcha",
      workerHealth,
    });
    expect(llm.prompt).toHaveBeenCalledOnce();
    expect(workerHealth.recordSuccess).toHaveBeenCalledTimes(
      text === "[]" ? 1 : 0,
    );
    if (text !== "[]")
      expect(workerHealth.recordFailure).toHaveBeenCalledWith("parse-error");
  },
);

test.each(["null", "```json\nnull\n```", "not JSON"])(
  "pattern echo accepts a valid null no-op: %s",
  async (text) => {
    const { projectPath, sessionID, pid } = scope();
    const vec = new Float32Array([1, 0, 0]);
    vi.spyOn(embedding, "embed").mockResolvedValue([vec]);
    const current = history(pid, sessionID);
    const others = ["earlier-a", "earlier-b"].map((session) => {
      const id = history(pid, session);
      storeEmbedding(db(), "distillations", id, vec);
      return { id, session_id: session, similarity: 1 };
    });
    vi.spyOn(embedding, "vectorSearchAllDistillations").mockResolvedValue(
      others,
    );
    const llm = {
      prompt: vi.fn(async () => text),
      recordWorkerSuccess: vi.fn(),
    };
    await detectPatternEchoes({
      llm,
      projectPath,
      sessionID,
      distillId: current,
      observations: "Carol deployed the release.",
    });
    expect(llm.prompt).toHaveBeenCalledOnce();
    expect(llm.recordWorkerSuccess).toHaveBeenCalledTimes(
      text === "not JSON" ? 0 : 1,
    );
    if (text !== "not JSON")
      expect(llm.recordWorkerSuccess).toHaveBeenCalledWith(
        sessionID,
        "lore-pattern-echo",
      );
  },
);

test.each(['{"contradict":false,"reason":"compatible"}', "not JSON"])(
  "contradiction recovers only after a verdict: %s",
  async (text) => {
    const { projectPath, sessionID } = scope();
    const vec = new Float32Array([1, 0, 0]);
    vi.spyOn(embedding, "embed").mockResolvedValue([vec]);
    for (const title of ["Use tabs", "Use spaces"]) {
      const id = ltm.create({
        projectPath,
        category: "preference",
        title,
        content: title,
        scope: "project",
      });
      await embedding.settleDocumentEmbeds();
      storeEmbedding(db(), "knowledge", id, vec);
    }
    const llm = {
      prompt: vi.fn(async () => text),
      recordWorkerSuccess: vi.fn(),
    };
    await detectContradictions({ llm, projectPath, sessionID });
    expect(llm.prompt).toHaveBeenCalledOnce();
    expect(llm.recordWorkerSuccess).toHaveBeenCalledTimes(
      text === "not JSON" ? 0 : 1,
    );
    if (text !== "not JSON")
      expect(llm.recordWorkerSuccess).toHaveBeenCalledWith(
        sessionID,
        "lore-contradiction",
      );
  },
);
