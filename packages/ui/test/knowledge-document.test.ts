import { describe, expect, it } from "vitest";

import { authorOf } from "~/components/lore/KnowledgeDocument";
import type { KnowledgeEntry } from "~/lib/schemas";

const entry = (created_by: KnowledgeEntry["created_by"]): KnowledgeEntry => ({
  id: "k",
  logical_id: "k",
  project_id: "p",
  category: "decision",
  title: "t",
  content: "c",
  confidence: 1,
  cross_project: 0,
  created_at: 1,
  updated_at: 1,
  created_by,
});

describe("authorOf", () => {
  it("attributes entries without an author to the Curator agent", () => {
    for (const missing of [undefined, null, ""]) {
      expect(authorOf(entry(missing))).toEqual({
        name: "Curator",
        initials: "CU",
        kind: "agent",
      });
    }
  });

  it("treats a whitespace-only author like a missing one, label and avatar alike", () => {
    expect(authorOf(entry("  \t"))).toEqual({
      name: "Curator",
      initials: "CU",
      kind: "agent",
    });
  });

  it("keeps a trimmed person name with a person avatar", () => {
    expect(authorOf(entry(" Ada Lovelace "))).toEqual({
      name: "Ada Lovelace",
      initials: "AL",
      kind: "person",
    });
  });
});
