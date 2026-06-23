import { describe, test, expect } from "vitest";
import {
  buildKnowledgeDeltaMessage,
  buildKnowledgeCatalogText,
} from "../src/pipeline";
import type { GatewayMessage } from "../src/translate/types";

// Extract the single text part of a delta message.
function text(msg: GatewayMessage | null): string {
  if (!msg) return "";
  const part = msg.content[0] as { type: string; text: string };
  return part.text;
}

const id = (prefix: string) => `${prefix}-1111-7111-8111-111111111111`;
const changed = (p: string, title: string, category = "pattern") => ({
  id: id(p),
  category,
  title,
  content: `content for ${title}`,
});
const toc = (p: string, title: string, category = "pattern") => ({
  id: id(p),
  category,
  title,
});

const HEADING = "## Other relevant knowledge (recall by id for detail)";

describe("buildKnowledgeDeltaMessage — overflow ToC (#917)", () => {
  test("renders an overflow section listing titles, short ids, and categories", () => {
    const msg = buildKnowledgeDeltaMessage(
      [changed("019aaaaa", "Changed entry")],
      [],
      [
        toc("019bbbbb", "Overflow one"),
        toc("019ccccc", "Overflow two", "gotcha"),
      ],
    );
    const t = text(msg);
    expect(t).toContain(HEADING);
    expect(t).toContain("[019bbbbb] Overflow one (pattern)");
    expect(t).toContain("[019ccccc] Overflow two (gotcha)");
  });

  test("overflow alone (no changes/removals) does NOT create a delta — rides existing cadence", () => {
    // Cache-stability invariant: a delta is only created on material change.
    // Overflow must never trigger one on its own, or it would add cache churn.
    const msg = buildKnowledgeDeltaMessage([], [], [toc("019bbbbb", "Lonely")]);
    expect(msg).toBeNull();
  });

  test("overflow is id-sorted (byte-stable across per-turn relevance re-ranking)", () => {
    const msg = buildKnowledgeDeltaMessage(
      [changed("019aaaaa", "Changed")],
      [],
      // Deliberately out of id order.
      [
        toc("019ccccc", "Gamma"),
        toc("019aaaab", "Alpha"),
        toc("019bbbbb", "Beta"),
      ],
    );
    const t = text(msg);
    const a = t.indexOf("Alpha");
    const b = t.indexOf("Beta");
    const g = t.indexOf("Gamma");
    expect(a).toBeGreaterThan(-1);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(g);
  });

  test("caps the list and reports the remainder", () => {
    const overflow = Array.from({ length: 15 }, (_, i) =>
      toc(`019d${String(i).padStart(4, "0")}`, `Entry ${i}`),
    );
    const msg = buildKnowledgeDeltaMessage(
      [changed("019aaaaa", "Changed")],
      [],
      overflow,
    );
    const t = text(msg);
    // 12 shown, 3 more reported.
    expect(t).toMatch(/3 more/);
    expect(t).toContain("recall");
  });

  test("excludes ids already shown as changed or listed as superseded (no dup/contradiction)", () => {
    const msg = buildKnowledgeDeltaMessage(
      [changed("019aaaaa", "Changed entry")],
      [id("019eeeee")],
      [
        toc("019aaaaa", "Should be excluded (changed)"),
        toc("019eeeee", "Should be excluded (removed)"),
        toc("019fffff", "Should appear"),
      ],
    );
    const t = text(msg);
    expect(t).toContain("Should appear");
    expect(t).not.toContain("Should be excluded (changed)");
    expect(t).not.toContain("Should be excluded (removed)");
  });

  test("no overflow arg → no overflow section (back-compat)", () => {
    const msg = buildKnowledgeDeltaMessage(
      [changed("019aaaaa", "Changed entry")],
      [],
    );
    expect(text(msg)).not.toContain(HEADING);
  });
});

describe("buildKnowledgeCatalogText — frozen system[1] catalog (#917 A)", () => {
  test("renders a recall-by-id catalog of titles + short ids + categories", () => {
    const out = buildKnowledgeCatalogText(
      [
        toc("019aaaaa", "Auth flow", "architecture"),
        toc("019bbbbb", "DB gotcha", "gotcha"),
      ],
      15,
    );
    expect(out).toContain("## Project knowledge (recall by id for detail)");
    expect(out).toContain("* [019aaaaa] Auth flow (architecture)");
    expect(out).toContain("* [019bbbbb] DB gotcha (gotcha)");
  });

  test("empty input → empty string (keeps system[1] absent — no array-grow cache bust)", () => {
    expect(buildKnowledgeCatalogText([], 15)).toBe("");
  });

  test("caps the catalog and reports the remainder", () => {
    const entries = Array.from({ length: 20 }, (_, i) =>
      toc(`019c${String(i).padStart(4, "0")}`, `Entry ${i}`),
    );
    const out = buildKnowledgeCatalogText(entries, 15);
    expect(out).toMatch(/5 more/);
    expect(out).toContain("recall");
    // Only 15 lines + the "more" line.
    expect(out.split("\n").filter((l) => l.startsWith("* ")).length).toBe(16);
  });

  test("preserves caller order (forProject confidence-desc) — byte-stable freeze", () => {
    const out = buildKnowledgeCatalogText(
      [toc("019ffff0", "First"), toc("019aaaa0", "Second")],
      15,
    );
    // First listed first even though its id sorts later — order is the caller's.
    expect(out.indexOf("First")).toBeLessThan(out.indexOf("Second"));
  });
});
