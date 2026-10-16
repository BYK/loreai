import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { filterTaskKnowledge } from "../src/knowledge-task-filter";

const entry = (category: string, title: string, content: string) => ({
  category,
  title,
  content,
});

describe("checkpoint-time task admission", () => {
  it("keeps explicit title and two-word body anchors without broad category exemptions", () => {
    const title = entry(
      "architecture",
      "Ledger topology",
      "A compact description.",
    );
    const body = entry(
      "gotcha",
      "Atomic commit",
      "Flush ledger batches before settling.",
    );
    const weak = entry(
      "architecture",
      "Cache layout",
      "Ledger data uses this cache.",
    );
    const decision = entry(
      "decision",
      "Ledger batches",
      "Ledger batches use a transaction.",
    );
    const pattern = entry(
      "pattern",
      "Ledger batches",
      "Ledger batches use a transaction.",
    );
    expect(
      filterTaskKnowledge(
        [title, body, weak, decision, pattern],
        "Repair ledger batches.",
      ),
    ).toEqual([title, body]);
  });

  it.each([14, 15, 34, 35])(
    "keeps only the prototype's medium-size gotcha fallback at %i distinct words",
    (size) => {
      const gotcha = entry(
        "gotcha",
        "Implicit convention",
        Array.from({ length: size }, (_, i) => `token${i}`).join(" "),
      );
      expect(filterTaskKnowledge([gotcha], "Repair ledger batching.")).toEqual(
        size >= 15 && size < 35 ? [gotcha] : [],
      );
    },
  );

  it("counts distinctive words rather than repetitions", () => {
    const repeated = entry(
      "gotcha",
      "Implicit convention",
      "ownership ".repeat(20),
    );
    expect(filterTaskKnowledge([repeated], "Repair ledger batching.")).toEqual(
      [],
    );
  });

  it("preserves preferences, recalled context, and source-file knowledge", () => {
    const values = ["preference", "recalled", "lat.md"].map((category) =>
      entry(category, "Unrelated title", "Unrelated content."),
    );
    expect(filterTaskKnowledge(values, "Repair ledger batching.")).toEqual(
      values,
    );
  });

  it.each(["", "please fix the code", "defteri yeniden düzenle"])(
    "preserves the no-task or unsupported-language fallback for %j",
    (task) => {
      const values = [
        entry("decision", "Unrelated title", "Unrelated content."),
      ];
      expect(filterTaskKnowledge(values, task)).toEqual(values);
    },
  );

  it("keeps a complete pool on per-entry, aggregate, or candidate work exhaustion", () => {
    const long = entry("decision", "Unrelated title", "x".repeat(4_097));
    const manyBytes = Array.from({ length: 20 }, () =>
      entry("decision", "Unrelated title", "x".repeat(4_000)),
    );
    const manyEntries = Array.from({ length: 129 }, () =>
      entry("decision", "Unrelated title", "Unrelated content."),
    );
    for (const values of [[long], manyBytes, manyEntries]) {
      expect(filterTaskKnowledge(values, "Repair ledger batching.")).toEqual(
        values,
      );
    }
  });

  it("includes the end of a bounded long task and never promotes an assistant cue over a missing task", () => {
    const fact = entry(
      "architecture",
      "Ledger topology",
      "Compact description.",
    );
    expect(
      filterTaskKnowledge(
        [fact],
        `${"noise ".repeat(1_000)} Repair ledger batching.`,
      ),
    ).toEqual([fact]);
    expect(filterTaskKnowledge([fact], "", "unrelated cue")).toEqual([fact]);
  });

  it("rejects an unexpected category", () => {
    expect(() =>
      filterTaskKnowledge(
        [entry("unexpected", "Title", "Content")],
        "Repair ledger batching.",
      ),
    ).toThrow("Invalid knowledge category");
  });

  it("always returns an ordered subset without changing its input", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            category: fc.constantFrom(
              "gotcha",
              "architecture",
              "decision",
              "pattern",
              "preference",
            ),
            title: fc.string(),
            content: fc.string(),
          }),
          { maxLength: 50 },
        ),
        (values) => {
          const original = structuredClone(values);
          const selected = filterTaskKnowledge(
            values,
            "Repair ledger batching.",
          );
          expect(values).toEqual(original);
          expect(values.filter((value) => selected.includes(value))).toEqual(
            selected,
          );
        },
      ),
    );
  });
});
