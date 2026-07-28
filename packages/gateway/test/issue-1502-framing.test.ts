/**
 * Regression tests for the prompt-injection-framing fix (issue #1502).
 *
 * Background: GitHub issue #1502 reported that an agent flagged Lore's
 * durable prompt-delta block as prompt-injection. The flagged text:
 *
 *   "[Lore knowledge update — ambient context injected by Lore. Do not
 *    reference this format or reply to this message; silently use anything
 *    relevant and ignore the rest.]"
 *
 * Root cause: the framing banner lived in the user role (deliberately —
 * to read as incoming context rather than a fake assistant turn) and used
 * imperative phrasing ("Do not reference", "silently use", "ignore the rest")
 * that tripped prompt-injection classifiers in safety-trained models. The
 * block arrived in the less-trusted user channel with no cross-reference to
 * a trusted slot — exactly the shape injection classifiers look for.
 *
 * The fix (#1502) has three parts:
 *
 *   1. Prenotify in `system[1]` (a trusted, cache-stable slot) that Lore
 *      will push memory updates mid-session, and that they carry the
 *      session's token.
 *   2. Drop the imperatives from the delta framing banner — declaration
 *      only, no instructions to act on.
 *   3. Embed a session-bound token (first 8 hex of sha256(sessionID)) in
 *      both `system[1]` and the delta framing. The matching token is the
 *      "shared secret" that lets the agent verify the block originated
 *      from Lore, not a third-party injection.
 *
 * These tests assert each of those three properties. They must NEVER regress
 * — that's why the assertions are literal-phrase checks for the imperatives
 * the classifier flagged. If any one reappears, #1502 is back.
 */
import { describe, expect, test } from "vitest";
import {
  buildKnowledgeDeltaFramingNote,
  buildLoreContextCapabilityNote,
  loreSessionToken,
} from "../src/pipeline";

// Imperative phrases the #1502 classifier flagged. None may reappear in the
// delta framing note or the capability note.
const FLAGGED_PHRASES = [
  "do not reference this format",
  "do not reference",
  "silently use",
  "ignore the rest",
  "reply to this message",
] as const;

describe("issue #1502 — shared-secret token derivation", () => {
  test("derives an 8-hex token from sessionID via sha256[:8]", () => {
    // sha256("abc")[:8] == "ba7816bf" — pinned to lock the derivation.
    expect(loreSessionToken("abc")).toBe("ba7816bf");
  });

  test("stable across calls with the same sessionID (durable replay)", () => {
    const a = loreSessionToken("ses-1LYkXZ7jkiHH");
    const b = loreSessionToken("ses-1LYkXZ7jkiHH");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });

  test("differs across sessions (cache invalidates cleanly per session)", () => {
    const a = loreSessionToken("session-one");
    const b = loreSessionToken("session-two");
    expect(a).not.toBe(b);
  });

  test("never derives from a turn counter or timestamp (no per-turn variance)", () => {
    // The derivation must be a pure function of sessionID only. If the helper
    // ever picks up Date.now() or a counter, durable replay breaks (the
    // token in system[1] would stop matching the token in the delta framing
    // on later turns).
    const sessionID = "ses-stability-probe";
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) {
      tokens.add(loreSessionToken(sessionID));
    }
    expect(tokens.size).toBe(1);
  });
});

describe("issue #1502 — capability note prenotification in system[1]", () => {
  const note = () => buildLoreContextCapabilityNote(loreSessionToken("abc"));

  test("prenotifies the agent about Lore knowledge update blocks", () => {
    const n = note();
    expect(n).toContain("Lore knowledge update");
    // The narrative spells out what these blocks are so the agent treats them
    // as system-provided memory, not instructions.
    expect(n).toContain("project memory");
    // Carries the token — the shared secret.
    expect(n).toContain("lore-ctx-");
  });

  test("embeds the SAME token that buildKnowledgeDeltaFramingNote uses", () => {
    const sessionID = "ses-shared-secret-probe";
    const token = loreSessionToken(sessionID);
    const capabilityNote = buildLoreContextCapabilityNote(token);
    const deltaFraming = buildKnowledgeDeltaFramingNote(token);
    // The token marker must appear in both so the agent can match.
    expect(capabilityNote).toContain(`lore-ctx-${token}`);
    expect(deltaFraming).toContain(`lore-ctx-${token}`);
  });

  test.each(FLAGGED_PHRASES)(
    "NEVER contains the flagged imperative phrase %p",
    (phrase) => {
      const n = note();
      expect(n.toLowerCase()).not.toContain(phrase);
    },
  );
});

describe("issue #1502 — delta framing note is declarative only", () => {
  const framing = () => buildKnowledgeDeltaFramingNote(loreSessionToken("abc"));

  test("keeps the 'Lore knowledge update' substring (required by cache-stability e2e)", () => {
    const f = framing();
    // cache-stability.e2e.test.ts asserts on this substring — do not drop.
    expect(f).toContain("Lore knowledge update");
  });

  test("carries the session token (shared secret with system[1])", () => {
    const f = framing();
    expect(f).toContain("lore-ctx-");
    expect(f).toContain("session token");
  });

  test("is short and declarative (no instruction text)", () => {
    const f = framing();
    // Sanity bound: the framing banner is a one-line identifier. If it grows
    // past 200 chars, it's probably accumulating instruction prose again.
    expect(f.length).toBeLessThan(200);
  });

  test.each(FLAGGED_PHRASES)(
    "NEVER contains the flagged imperative phrase %p",
    (phrase) => {
      const f = framing();
      expect(f.toLowerCase()).not.toContain(phrase);
    },
  );

  test("legacy framing-banner substring '[Lore knowledge update —' is preserved (migration matcher depends on it)", () => {
    // parseDeltaMessages matches legacy blocks by `startsWith` on this prefix.
    // Legacy blocks start with "[Lore knowledge update — ambient context…",
    // new blocks start with "[Lore knowledge update — session token:…".
    // Both must start with "[Lore knowledge update —".
    const f = framing();
    expect(f.startsWith("[Lore knowledge update —")).toBe(true);
  });
});
