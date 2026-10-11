/**
 * Prefix snapshots and inherited-prefix resolution for threads (#1809),
 * driven through the real recordCacheTurnUsage seam and core's durable FIFO.
 */
import { afterEach, describe, expect, test } from "vitest";
import { evictSession } from "@loreai/core";
import { recordCacheTurnUsage } from "../src/pipeline";
import { compressBody, decompressBody } from "../src/cache-analytics";
import {
  forgetPrefixSnapshots,
  resolveParentPrefix,
  sessionPrefixSnapshots,
  type PrefixCut,
} from "../src/prefix-snapshots";
import type { SessionState } from "../src/translate/types";

const MODEL = "claude-test";
const PROJECT = "/tmp/test-prefix-snapshots";
const CHILD = { model: MODEL, account: "cred-a" };
const USAGE = Object.freeze({
  inputTokens: 3,
  outputTokens: 50,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 100_000,
});

function body(system: string, texts: string[]): string {
  return JSON.stringify({
    model: MODEL,
    system,
    messages: texts.map((t, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: t }],
    })),
  });
}

const sessions: string[] = [];
let seq = 0;

function session(prev: string, sentAt = Date.now()): SessionState {
  const sessionID = `prefix-snapshots-${seq++}-${Date.now()}`;
  sessions.push(sessionID);
  return {
    sessionID,
    projectPath: PROJECT,
    messageCount: 3,
    lastTurnWasIdle: false,
    resolvedConversationTTL: "5m",
    credentialFingerprint: "cred-a",
    cacheAnalytics: {
      lastRequestBody: compressBody(prev),
      lastRequestMeta: { model: MODEL, wire: "anthropic", sentAt },
      lastRequestBodyLength: prev.length,
      lastCacheRead: 90_000,
      lastCacheCreation: 0,
      turnCount: 1,
      bustCount: 0,
    },
  } as unknown as SessionState;
}

/** Cut right after the given marker text. */
function cutAt(marker: string): PrefixCut {
  return (b) => {
    const i = b.indexOf(marker);
    return i < 0 ? null : b.slice(0, i + marker.length);
  };
}

afterEach(() => {
  for (const sid of sessions) evictSession(sid);
  sessions.length = 0;
  forgetPrefixSnapshots();
});

const LAYER0 = body("You are a coding agent.", [
  "ANCHOR-1 old turn",
  "r0",
  "u2",
]);
const LAYER1 = body("You are a coding agent.", [
  "[distilled] old turn summary",
  "r0",
  "u2",
  "r2",
  "u3",
]);

describe("prefix snapshots", () => {
  test("a layer change pushes exactly one snapshot of the previous body", () => {
    const state = session(LAYER0);
    recordCacheTurnUsage(
      state,
      USAGE,
      MODEL,
      PROJECT,
      LAYER1,
      undefined,
      undefined,
      "anthropic",
    );
    const snaps = sessionPrefixSnapshots(state.sessionID);
    expect(snaps).toHaveLength(1);
    expect(decompressBody(snaps[0].body)).toBe(LAYER0);
    expect(snaps[0]).toMatchObject({ model: MODEL, account: "cred-a" });
    expect(snaps[0].expiresAt - snaps[0].sentAt).toBe(300_000);
    expect(state.cacheAnalytics.lastRequestMeta).toMatchObject({
      model: MODEL,
      wire: "anthropic",
    });
  });

  test("a no-divergence turn pushes nothing", () => {
    const prev = body("You are a coding agent.", ["a", "b", "c"]);
    const state = session(prev);
    recordCacheTurnUsage(
      state,
      USAGE,
      MODEL,
      PROJECT,
      body("You are a coding agent.", ["a", "b", "c", "d", "e"]),
      undefined,
      undefined,
      "anthropic",
    );
    expect(sessionPrefixSnapshots(state.sessionID)).toEqual([]);
  });

  test("an anchor before the rewrite resolves from the snapshot, byte-exact", () => {
    const state = session(LAYER0);
    recordCacheTurnUsage(
      state,
      USAGE,
      MODEL,
      PROJECT,
      LAYER1,
      undefined,
      undefined,
      "anthropic",
    );
    const prefix = resolveParentPrefix(state, CHILD, cutAt("ANCHOR-1"));
    expect(prefix.mode).toBe("snapshot");
    if (prefix.mode === "cold") throw new Error("expected an inherited prefix");
    const expected = LAYER0.slice(0, LAYER0.indexOf("ANCHOR-1") + 8);
    expect(decompressBody(prefix.body)).toBe(expected);
    expect(prefix.bodyBytes).toBe(Buffer.byteLength(expected));
    const live = resolveParentPrefix(state, CHILD, cutAt("[distilled]"));
    expect(live.mode).toBe("live");
  });

  test("an expired snapshot resolves cold", () => {
    const sentAt = Date.now() - 400_000;
    const state = session(LAYER0, sentAt);
    recordCacheTurnUsage(
      state,
      USAGE,
      MODEL,
      PROJECT,
      LAYER1,
      undefined,
      undefined,
      "anthropic",
    );
    expect(sessionPrefixSnapshots(state.sessionID)).toEqual([]);
    expect(resolveParentPrefix(state, CHILD, cutAt("ANCHOR-1"))).toEqual({
      mode: "cold",
      reason: "anchor_not_cached",
    });
  });

  test("a restart keeps unexpired snapshots", () => {
    const state = session(LAYER0);
    recordCacheTurnUsage(
      state,
      USAGE,
      MODEL,
      PROJECT,
      LAYER1,
      undefined,
      undefined,
      "anthropic",
    );
    forgetPrefixSnapshots();
    state.cacheAnalytics.lastRequestBody = null;
    state.cacheAnalytics.lastRequestMeta = null;
    const prefix = resolveParentPrefix(state, CHILD, cutAt("ANCHOR-1"));
    expect(prefix.mode).toBe("snapshot");
  });

  test("falls back cold on model or account mismatch and with no bodies", () => {
    const state = session(LAYER0);
    expect(
      resolveParentPrefix(
        state,
        { ...CHILD, model: "other" },
        cutAt("ANCHOR-1"),
      ),
    ).toEqual({ mode: "cold", reason: "model_mismatch" });
    expect(
      resolveParentPrefix(state, { ...CHILD, account: "b" }, cutAt("ANCHOR-1")),
    ).toEqual({ mode: "cold", reason: "account_mismatch" });
    state.cacheAnalytics.lastRequestBody = null;
    expect(resolveParentPrefix(state, CHILD, cutAt("ANCHOR-1"))).toEqual({
      mode: "cold",
      reason: "no_cached_body",
    });
  });
});
