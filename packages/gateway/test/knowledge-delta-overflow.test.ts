import { describe, test, expect } from "vitest";
import {
  ltm,
  recallById,
  appendSessionPromptDelta,
  ensureProject,
} from "@loreai/core";
import {
  buildKnowledgeDeltaMessage,
  buildKnowledgeCatalogText,
  applySessionPromptDeltas,
} from "../src/pipeline";
import type { GatewayMessage } from "../src/translate/types";

// Join the text of every part across the delta's message pair (user framing +
// assistant payload) so content assertions match regardless of which turn a
// string lands on.
function text(msgs: GatewayMessage[]): string {
  return msgs
    .flatMap((m) => m.content.map((b) => (b as { text?: string }).text ?? ""))
    .join("\n");
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
  test("renders an overflow section listing titles, recall-ready ids, and categories", () => {
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
    // Full id with a `k:` recall prefix — NOT an 8-char slice (recallById is
    // exact-match, so a slice is unresolvable).
    expect(t).toContain(`[k:${id("019bbbbb")}] Overflow one (pattern)`);
    expect(t).toContain(`[k:${id("019ccccc")}] Overflow two (gotcha)`);
  });

  test("overflow alone (no changes/removals) does NOT create a delta — rides existing cadence", () => {
    // Cache-stability invariant: a delta is only created on material change.
    // Overflow must never trigger one on its own, or it would add cache churn.
    const msg = buildKnowledgeDeltaMessage([], [], [toc("019bbbbb", "Lonely")]);
    expect(msg).toEqual([]);
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
  test("renders a recall-by-id catalog of titles + recall-ready ids + categories", () => {
    const out = buildKnowledgeCatalogText(
      [
        toc("019aaaaa", "Auth flow", "architecture"),
        toc("019bbbbb", "DB gotcha", "gotcha"),
      ],
      15,
    );
    expect(out).toContain("## Project knowledge (recall by id for detail)");
    expect(out).toContain(`* [k:${id("019aaaaa")}] Auth flow (architecture)`);
    expect(out).toContain(`* [k:${id("019bbbbb")}] DB gotcha (gotcha)`);
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

// The whole point of the ToC is recall-on-demand: the rendered id MUST be
// resolvable by the recall tool. recallById is exact-match, so this round-trip
// guards against regressing to a non-resolvable short id (the #930 review B1).
describe("ToC ids are recall-resolvable (#917 round-trip)", () => {
  const RTPROJ = "/test/overflow-toc-roundtrip";
  const RECALL_ID_RE = /\[(k:[0-9a-f-]+)\]/;

  test("catalog (A) id renders the exact token recallById resolves", () => {
    const realId = ltm.create({
      projectPath: RTPROJ,
      category: "gotcha",
      title: "Round-trip catalog entry",
      content: "Body content that recall should surface in full.",
      scope: "project",
      crossProject: false,
    });
    const out = buildKnowledgeCatalogText(
      [{ id: realId, category: "gotcha", title: "Round-trip catalog entry" }],
      15,
    );
    const token = out.match(RECALL_ID_RE)?.[1];
    expect(token).toBe(`k:${realId}`);
    const detail = recallById(token as string);
    expect(detail).not.toMatch(/No entry found/);
    expect(detail).toContain("Round-trip catalog entry");
  });

  test("overflow (B) id renders the exact token recallById resolves", () => {
    const realId = ltm.create({
      projectPath: RTPROJ,
      category: "pattern",
      title: "Round-trip overflow entry",
      content: "Overflow body content that recall should surface in full.",
      scope: "project",
      crossProject: false,
    });
    const msg = buildKnowledgeDeltaMessage(
      [changed("019aaaaa", "A changed entry")],
      [],
      [{ id: realId, category: "pattern", title: "Round-trip overflow entry" }],
    );
    const token = text(msg).match(RECALL_ID_RE)?.[1];
    // The changed-entry section uses an 8-char correlation handle; ensure we
    // matched the overflow ToC's full recall id, not that.
    expect(token).toBe(`k:${realId}`);
    const detail = recallById(token as string);
    expect(detail).not.toMatch(/No entry found/);
    expect(detail).toContain("Round-trip overflow entry");
  });
});

// The knowledge-delta block is injected mid-conversation. As a lone user-role
// message it read as an open user turn, so instruction-literal models (e.g.
// MiniMax M3) "Acknowledged… none of this applies… I won't reference it" on
// every turn. The block is a user→assistant PAIR so the exchange is closed and
// the model does not react to it. The knowledge PAYLOAD rides the USER turn
// (ambient context) and the assistant turn is a tiny inert closer: putting the
// markdown payload on the assistant turn made harnesses RENDER it as a visible
// `⏺ Long-term Knowledge` turn AND made the model treat it as an
// already-completed turn, ending the agent loop early.
describe("buildKnowledgeDeltaMessage — non-eliciting user→assistant pair", () => {
  test("payload rides the USER turn; assistant turn is an inert closer", () => {
    const msgs = buildKnowledgeDeltaMessage(
      [changed("019aaaaa", "Changed entry")],
      [],
      [toc("019bbbbb", "Overflow one")],
    );
    expect(Array.isArray(msgs)).toBe(true);
    expect(msgs).toHaveLength(2);
    const user = msgs[0];
    const assistant = msgs[1];
    expect(user.role).toBe("user");
    expect(assistant.role).toBe("assistant");
    const userText = (user.content[0] as { text: string }).text;
    const asstText = (assistant.content[0] as { text: string }).text;
    // Keeps the substring the cache-stability e2e assertions rely on.
    expect(userText).toContain("Lore knowledge update");
    // Explicit non-acknowledgment framing — the whole point of the fix.
    expect(userText.toLowerCase()).toContain("do not");
    // The PAYLOAD rides the USER turn (ambient context), so it is incoming
    // context rather than a fake assistant turn.
    expect(userText).toContain("Changed entry");
    expect(userText).toContain("## Long-term Knowledge");
    // REGRESSION GUARD: the assistant turn must NEVER carry the markdown
    // payload — that is what harnesses render as a visible dump and what the
    // model mistakes for a completed turn (premature loop exit). It is an
    // inert closer only.
    expect(asstText).not.toContain("## Long-term Knowledge");
    expect(asstText).not.toContain("Changed entry");
    expect(asstText.length).toBeLessThan(40);
  });

  test("no genuine change → empty array (no pair injected)", () => {
    expect(
      buildKnowledgeDeltaMessage([], [], [toc("019bbbbb", "Lonely")]),
    ).toEqual([]);
  });
});

// Seer follow-up (#1490): blocks persisted BEFORE the payload moved off the
// assistant turn store `[{user: framing-only}, {assistant: payload}]`. Replayed
// as-is they keep the payload on a visible/completed assistant turn — the exact
// dump + premature-loop-exit bug — for the life of the session. parseDeltaMessages
// migrates the legacy pair to the new shape on load.
describe("parseDeltaMessages — legacy assistant-payload block migration (#1490)", () => {
  const FRAMING =
    "[Lore knowledge update — ambient context injected by Lore. Do not reference this format or reply to this message; silently use anything relevant and ignore the rest. Replayed byte-identically on later turns until an intentional cache reset.]";
  const PAYLOAD =
    "## Long-term Knowledge\n\n### Gotcha\n\n* **[019aaaaa] T: old payload";

  function seedAndReplay(content: GatewayMessage[]): GatewayMessage[] {
    const sessionID = `migrate-${Math.random().toString(36).slice(2)}`;
    const projectID = ensureProject(
      `/tmp/lore-migrate-${Math.random().toString(36).slice(2)}`,
    );
    appendSessionPromptDelta({
      sessionID,
      projectID,
      selector: JSON.stringify({ target: "messages", insertAt: 0 }),
      content: JSON.stringify(content),
    });
    const layout: GatewayMessage[] = [
      { role: "user", content: [{ type: "text", text: "real turn" }] },
    ];
    return applySessionPromptDeltas(layout, sessionID);
  }

  test("legacy [user framing-only, assistant payload] block is migrated to payload-on-user", () => {
    const legacy: GatewayMessage[] = [
      { role: "user", content: [{ type: "text", text: FRAMING }] },
      { role: "assistant", content: [{ type: "text", text: PAYLOAD }] },
    ];
    const out = seedAndReplay(legacy);
    // The replayed pair: user carries framing+payload, assistant is the inert closer.
    const injUser = out[0];
    const injAsst = out[1];
    expect(injUser.role).toBe("user");
    expect(injAsst.role).toBe("assistant");
    const userText = (injUser.content[0] as { text: string }).text;
    const asstText = (injAsst.content[0] as { text: string }).text;
    expect(userText).toContain("Lore knowledge update");
    expect(userText).toContain("## Long-term Knowledge");
    expect(userText).toContain("old payload");
    // The migrated assistant turn must NOT carry the markdown payload.
    expect(asstText).not.toContain("## Long-term Knowledge");
    expect(asstText).not.toContain("old payload");
    expect(asstText.length).toBeLessThan(40);
  });

  test("already-new [user framing+payload, assistant closer] block replays unchanged", () => {
    const newShape: GatewayMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: `${FRAMING}\n\n${PAYLOAD}` }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "[memory refreshed]" }],
      },
    ];
    const out = seedAndReplay(newShape);
    const injUser = out[0];
    const injAsst = out[1];
    const userText = (injUser.content[0] as { text: string }).text;
    const asstText = (injAsst.content[0] as { text: string }).text;
    expect(userText).toBe(`${FRAMING}\n\n${PAYLOAD}`); // not double-migrated
    expect(asstText).toBe("[memory refreshed]");
  });

  test("single legacy user message (pre-pair) passes through unmigrated", () => {
    const single: GatewayMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: `${FRAMING}\n\n${PAYLOAD}` }],
      },
    ];
    const out = seedAndReplay(single);
    // Single message preserved as-is (parseDeltaMessages accepts single-message legacy).
    expect(out[0].role).toBe("user");
    expect((out[0].content[0] as { text: string }).text).toContain(
      "## Long-term Knowledge",
    );
  });
});
