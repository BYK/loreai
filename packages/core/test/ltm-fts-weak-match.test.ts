import { expect, test, vi } from "vitest";
import * as embedding from "../src/embedding";
import * as ltm from "../src/ltm";

test("FTS retains its weakest matching project entry for injection or recall", async () => {
  const projectPath = "/test/ltm/weak-fts-match";
  const contextHint =
    "After an idle resume, a coding agent loses a previously injected knowledge entry despite an unchanged cache prefix.";
  const needed = ltm.create({
    projectPath,
    scope: "project",
    category: "gotcha",
    title: "Stable knowledge pin",
    content:
      "Keep the pinned knowledge prefix byte-identical during a session; deliver changing context via durable tail deltas.",
  });
  ltm.create({
    projectPath,
    scope: "project",
    category: "gotcha",
    title: "Regenerate all prompts",
    content:
      "Rewrite the system prefix on every resume to ensure the latest knowledge is included.",
  });
  const foreign = ltm.create({
    projectPath: "/test/ltm/other-project",
    scope: "project",
    category: "gotcha",
    title: "Unchanged cache prefix on idle resume",
    content: contextHint,
  });

  const available = vi.spyOn(embedding, "isAvailable").mockReturnValue(false);
  try {
    const overflow: ltm.KnowledgeEntry[] = [];
    const selected = await ltm.forSession(projectPath, undefined, 70, {
      contextHint,
      overflowSink: overflow,
      deferEffects: true,
    });
    expect([...selected, ...overflow].map((entry) => entry.id)).toContain(
      needed,
    );
    expect([...selected, ...overflow].map((entry) => entry.id)).not.toContain(
      foreign,
    );
  } finally {
    available.mockRestore();
  }
});
