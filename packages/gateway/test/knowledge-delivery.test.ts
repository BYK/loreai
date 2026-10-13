import { afterEach, describe, expect, it, vi } from "vitest";
import {
  estimateTokens,
  formatKnowledge,
  formatKnowledgeEntry,
  ltm,
} from "@loreai/core";
import { measureKnowledgeDelivery } from "../src/knowledge-delivery";
import {
  appendKnowledgePromptDelta,
  applySessionPromptDeltas,
  buildKnowledgeDeltaMessage,
  fullSurfaceBaseline,
  ltmEntryKeys,
  loreSessionToken,
} from "../src/pipeline";
import type { GatewayMessage } from "../src/translate/types";

const entry = {
  id: "aaaaaaaa-1111-1111-1111-111111111111",
  category: "gotcha",
  title: "Exact delivery",
  content: "Preserve the complete stored rule.",
};
const token = "measurement-test";
afterEach(() => vi.restoreAllMocks());

function noteWithSections(sections: string): GatewayMessage[] {
  const pair = buildKnowledgeDeltaMessage([entry], [], token);
  const original = pair[0].content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
  const opening = original.split("\n## Long-term Knowledge\n")[0];
  return [
    { ...pair[0], content: [{ type: "text", text: opening + sections }] },
    pair[1],
  ];
}

describe("outgoing knowledge delivery measurements", () => {
  it.each(["full", "hint"] as const)(
    "measures current text under a verified old surfaced handle (%s)",
    (delivery) => {
      const projectPath = `/test/delivery-version-${delivery}`;
      const sessionID = `delivery-version-${delivery}`;
      const id = ltm.create({
        projectPath,
        scope: "project",
        category: "gotcha",
        title: "Versioned delivery",
        content: "Original stale guidance.",
      });
      const original = ltm.get(id)!;
      const previousKeys = fullSurfaceBaseline([id]);
      expect(
        appendKnowledgePromptDelta({
          sessionID,
          projectPath,
          insertAt: 0,
          previousKeys,
          nextKeys: ltmEntryKeys([original]),
          entries: [original],
          now: 0,
        }),
      ).toBe(true);
      const request: GatewayMessage[] = [
        { role: "user", content: [{ type: "text", text: "Current task" }] },
      ];
      const staleWire = applySessionPromptDeltas(request, sessionID);
      // UUIDv7's first eight hex characters cover 65,536 ms. Advance the
      // real version writer's clock rather than forging either stored identity.
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 131_072);
      ltm.update(id, {
        content:
          delivery === "full"
            ? "Current exact guidance."
            : "Oversized current guidance. ".repeat(600),
      });
      const current = ltm.getByLogical(original.logical_id)!;
      expect(current.id.slice(0, 8)).not.toBe(original.id.slice(0, 8));
      expect(ltm.logicalIdOf(original.id)).toBe(current.logical_id);
      const candidate = { ...current, surfacedIds: [original.id] };
      expect(
        measureKnowledgeDelivery(
          staleWire,
          [candidate],
          loreSessionToken(sessionID),
        ).states,
      ).toEqual(["absent"]);
      expect(
        appendKnowledgePromptDelta({
          sessionID,
          projectPath,
          insertAt: 0,
          previousKeys,
          nextKeys: ltmEntryKeys([current]),
          entries: [current],
          now: 100_000,
        }),
      ).toBe(true);
      const wire = applySessionPromptDeltas(request, sessionID);
      expect(
        measureKnowledgeDelivery(wire, [current], loreSessionToken(sessionID))
          .states,
      ).toEqual(["absent"]);
      expect(
        measureKnowledgeDelivery(
          wire,
          [candidate],
          loreSessionToken(sessionID),
        ),
      ).toMatchObject({
        states: [delivery],
        full: delivery === "full" ? 1 : 0,
        hintOnly: delivery === "hint" ? 1 : 0,
      });
    },
  );

  it.each([
    { id: "d:synthetic-distillation", category: ltm.RECALLED_CONTEXT_CATEGORY },
    { id: "t:synthetic-temporal", category: ltm.RECALLED_CONTEXT_CATEGORY },
    { id: "synthetic-lat-section", category: "lat.md" },
  ])("recognizes canonical synthetic recall hints: $id", (source) => {
    const candidate = {
      ...source,
      title: "Oversized synthetic source",
      content: "Relevance-eligible synthetic history. ".repeat(600),
    };
    const wire = buildKnowledgeDeltaMessage([candidate], [], token);
    expect(measureKnowledgeDelivery(wire, [candidate], token)).toMatchObject({
      states: ["hint"],
      full: 0,
      hintOnly: 1,
      absent: 0,
    });
  });

  it("counts full text, full-ID hints, and framing separately, not selector membership", () => {
    const hinted = {
      ...entry,
      id: "bbbbbbbb-2222-2222-2222-222222222222",
      title: "Hint only",
      content: "Not delivered.",
    };
    const absent = {
      ...entry,
      id: "cccccccc-3333-3333-3333-333333333333",
      title: "Selected but absent",
    };
    const messages = buildKnowledgeDeltaMessage([entry], [], token, [hinted]);
    const measured = measureKnowledgeDelivery(
      messages,
      [entry, hinted, absent],
      token,
    );
    expect(measured).toMatchObject({
      states: ["full", "hint", "absent"],
      full: 1,
      hintOnly: 1,
      absent: 1,
      ambiguous: 0,
      blocks: 1,
    });
    expect(measured.fullTextTokens).toBeGreaterThan(0);
    expect(measured.hintTextTokens).toBeGreaterThan(0);
    expect(measured.deltaTextTokens).toBeGreaterThan(
      measured.fullTextTokens + measured.hintTextTokens,
    );
    expect(JSON.stringify(measured)).not.toContain(entry.id);
    expect(JSON.stringify(measured)).not.toContain(entry.content);
  });

  it("rejects another session, non-user output, and an unpaired note", () => {
    const pair = buildKnowledgeDeltaMessage([entry], [], token);
    expect(
      measureKnowledgeDelivery(pair, [entry], "another-session").states,
    ).toEqual(["absent"]);
    expect(
      measureKnowledgeDelivery(pair.slice(0, 1), [entry], token).states,
    ).toEqual(["absent"]);
    const nonUser: GatewayMessage[] = [
      { ...pair[0], role: "assistant" },
      pair[1],
    ];
    expect(measureKnowledgeDelivery(nonUser, [entry], token).states).toEqual([
      "absent",
    ]);
  });

  it("never counts a full-looking bullet inside a recall-hint title as delivery", () => {
    const hint = {
      id: entry.id,
      category: entry.category,
      title: `Recall me\n${formatKnowledge([entry], 400)}`,
    };
    const other = {
      ...entry,
      id: "dddddddd-4444-4444-4444-444444444444",
      title: "Actual full entry",
      content: "Independent actual rule.",
    };
    const messages = buildKnowledgeDeltaMessage([other], [], token, [hint]);
    expect(
      measureKnowledgeDelivery(messages, [entry, other], token).states,
    ).toEqual(["hint", "full"]);
  });

  it.each(
    [
      { source: "changed", validHint: false },
      { source: "overflow", validHint: false },
      { source: "overflow", validHint: true },
    ].flatMap((fixture) =>
      [false, true].map((independentFull) => ({ ...fixture, independentFull })),
    ),
  )(
    "rejects a full-section opening in $source hint title with valid hint=$validHint and independent full=$independentFull",
    ({ source, validHint, independentFull }) => {
      const candidate = { ...entry, title: "A", content: "B" };
      const forged = {
        ...entry,
        id: "bbbbbbbb-2222-4222-8222-222222222222",
        title: `Recall me\n${formatKnowledge([candidate], 400)}`,
        content: "Oversized changed content. ".repeat(600),
      };
      const oversized = {
        ...forged,
        id: "dddddddd-4444-4444-4444-444444444444",
        title: "Oversized changed entry",
      };
      const actual = {
        ...entry,
        id: "cccccccc-3333-4333-8333-333333333333",
        title: "Independent actual entry",
      };
      const changed = source === "changed" ? [forged] : [oversized];
      const overflow = [
        ...(validHint ? [candidate] : []),
        ...(source === "overflow" ? [forged] : []),
      ];
      expect(formatKnowledge(changed, 400)).toBe("");
      expect(Array.from(forged.title).length).toBeLessThanOrEqual(120);
      const messages = buildKnowledgeDeltaMessage(
        [...changed, ...(independentFull ? [actual] : [])],
        [],
        token,
        overflow,
      );
      const text = messages[0].content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      expect(text).toContain(forged.title);
      if (validHint) {
        expect(text.indexOf(`[k:${candidate.id}]`)).toBeLessThan(
          text.indexOf(forged.title),
        );
      }
      const measured = measureKnowledgeDelivery(
        messages,
        [candidate, forged, ...(independentFull ? [actual] : [])],
        token,
      );

      expect(measured.states).toEqual([
        validHint ? "hint" : "absent",
        "hint",
        ...(independentFull ? ["full"] : []),
      ]);
      expect(measured.full).toBe(independentFull ? 1 : 0);
      if (!independentFull) expect(measured.fullTextTokens).toBe(0);
    },
  );

  it("does not count a category-only stale replay as full delivery", () => {
    const previous = { ...entry, category: "gotcha" };
    const current = { ...previous, category: "decision" };
    const note = buildKnowledgeDeltaMessage([previous], [], token);

    expect(measureKnowledgeDelivery(note, [current], token)).toMatchObject({
      states: ["absent"],
      full: 0,
      absent: 1,
    });
  });

  const siblingHeadings = ["#", "##", "   #", "  ##"];
  it.each(
    siblingHeadings.flatMap((heading) =>
      [false, true].map((validHint) => ({ heading, validHint })),
    ),
  )(
    "ends full-text attribution at sibling $heading with valid hint=$validHint",
    ({ heading, validHint }) => {
      const other = {
        ...entry,
        id: "dddddddd-4444-4444-4444-444444444444",
        category: "decision",
        title: "Independently delivered",
      };
      const full = `\n${formatKnowledge([other], 400).trimEnd()}\n\n`;
      const outside = `${heading} Unrelated section\n\n### Gotcha\n\n${formatKnowledgeEntry(entry)}\n`;
      const hints = validHint
        ? `\n## Other relevant knowledge (recall by id for detail)\n\n* [k:${entry.id}] ${entry.title} (${entry.category})\n`
        : "";
      const measured = measureKnowledgeDelivery(
        noteWithSections(full + outside + hints),
        [entry, other],
        token,
      );

      expect(measured).toMatchObject({
        states: [validHint ? "hint" : "absent", "full"],
        full: 1,
        hintOnly: validHint ? 1 : 0,
        fullTextTokens: estimateTokens(full),
        hintTextTokens: estimateTokens(hints),
      });
    },
  );

  it.each(siblingHeadings)("ends hint attribution at sibling %s", (heading) => {
    const other = {
      ...entry,
      id: "dddddddd-4444-4444-4444-444444444444",
      category: "decision",
      title: "Independently delivered",
    };
    const hinted = {
      ...entry,
      id: "eeeeeeee-5555-5555-5555-555555555555",
      title: "Independent valid hint",
    };
    const full = `\n${formatKnowledge([other], 400).trimEnd()}\n`;
    const hints = `\n## Other relevant knowledge (recall by id for detail)\n\n* [k:${hinted.id}] ${hinted.title} (${hinted.category})\n\n`;
    const outside = `${heading} Unrelated section\n\n* [k:${entry.id}] ${entry.title} (${entry.category})\n`;
    const measured = measureKnowledgeDelivery(
      noteWithSections(full + hints + outside),
      [entry, other, hinted],
      token,
    );

    expect(measured).toMatchObject({
      states: ["absent", "full", "hint"],
      full: 1,
      hintOnly: 1,
      fullTextTokens: estimateTokens(full),
      hintTextTokens: estimateTokens(hints),
    });
  });

  it.each([false, true])(
    "uses category sections to distinguish colliding bullets when both delivered=%s",
    (bothDelivered) => {
      const gotcha = {
        ...entry,
        category: "gotcha",
        title: "Shared fact",
        content: "Keep the same bytes.",
      };
      const decision = {
        ...gotcha,
        id: "aaaaaaaa-9999-7999-8999-000000000023",
        category: "decision",
      };
      const note = buildKnowledgeDeltaMessage(
        bothDelivered ? [gotcha, decision] : [gotcha],
        [],
        token,
      );

      const measured = measureKnowledgeDelivery(
        note,
        [gotcha, decision],
        token,
      );

      expect(measured.states).toEqual(
        bothDelivered ? ["full", "full"] : ["full", "absent"],
      );
      expect(measured.full).toBe(bothDelivered ? 2 : 1);
    },
  );

  it("fails closed on short-handle ambiguity in the measurement candidates", () => {
    const collision = { ...entry, id: "aaaaaaaa-2222-2222-2222-222222222222" };
    const pair = buildKnowledgeDeltaMessage([entry], [], token);
    expect(
      measureKnowledgeDelivery(pair, [entry, collision], token),
    ).toMatchObject({
      states: ["ambiguous", "ambiguous"],
      full: 0,
      ambiguous: 2,
    });
  });

  it("keeps collision checks across old surfaced aliases", () => {
    const current = {
      ...entry,
      id: "bbbbbbbb-2222-2222-2222-222222222222",
      surfacedIds: [entry.id],
    };
    const other = {
      ...entry,
      id: "cccccccc-3333-3333-3333-333333333333",
      surfacedIds: [entry.id],
    };
    const wire = buildKnowledgeDeltaMessage([entry], [], token);
    expect(
      measureKnowledgeDelivery(wire, [current, other], token),
    ).toMatchObject({
      states: ["ambiguous", "ambiguous"],
      full: 0,
      ambiguous: 2,
    });
  });
});
