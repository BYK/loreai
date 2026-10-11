/**
 * Inherited-prefix sources for threads (#1809). A thread inherits its
 * parent's exact as-sent prefix so the child reuses the parent's prompt
 * cache. The latest body (`cacheAnalytics.lastRequestBody`) is tried first;
 * older anchors come from the session's prefix snapshots, which are pushed
 * whenever a turn rewrites the prefix and kept in memory backed by core's
 * durable FIFO so a restart doesn't lose them.
 */
import { ensureProject, prefixSnapshots, type threadLinks } from "@loreai/core";
import { compressBody, decompressBody } from "./cache-analytics";
import type { GatewayProtocol, SessionState } from "./translate/types";

const memory = new Map<string, prefixSnapshots.PrefixSnapshot[]>();

export function conversationTtlMs(
  state: Pick<SessionState, "resolvedConversationTTL">,
): number {
  return state.resolvedConversationTTL === "1h" ? 3_600_000 : 300_000;
}

/** Push the body sent before a prefix rewrite; its cache entry lapses one
 *  conversation TTL after it was sent. */
export function capturePrefixSnapshot(
  state: SessionState,
  previous: {
    body: Uint8Array;
    model: string;
    wire: GatewayProtocol;
    sentAt: number;
  },
  now = Date.now(),
): void {
  prefixSnapshots.pushPrefixSnapshot(
    {
      sessionID: state.sessionID,
      projectID: ensureProject(state.projectPath),
      model: previous.model,
      account: state.credentialFingerprint ?? "",
      wire: previous.wire,
      body: previous.body,
      bodyBytes: Buffer.byteLength(decompressBody(previous.body)),
      sentAt: previous.sentAt,
      expiresAt: previous.sentAt + conversationTtlMs(state),
    },
    now,
  );
  memory.set(
    state.sessionID,
    prefixSnapshots.listPrefixSnapshots(state.sessionID, now),
  );
}

/** Unexpired snapshots of a session, newest first. */
export function sessionPrefixSnapshots(
  sessionID: string,
  now = Date.now(),
): prefixSnapshots.PrefixSnapshot[] {
  const cached = memory.get(sessionID);
  if (cached && cached.every((s) => s.expiresAt > now)) return cached;
  const loaded = prefixSnapshots.listPrefixSnapshots(sessionID, now);
  memory.set(sessionID, loaded);
  return loaded;
}

/** Drop the in-memory copy (session eviction); the durable FIFO stays. */
export function forgetPrefixSnapshots(sessionID?: string): void {
  if (sessionID === undefined) memory.clear();
  else memory.delete(sessionID);
}

/** Cuts a decompressed as-sent body at the anchored message, or returns
 *  null when the anchor isn't in that body. */
export type PrefixCut = (body: string) => string | null;

/**
 * Pick the prefix a thread inherits: the live body if it contains the
 * anchor, else the newest unexpired snapshot that does, else a cold start.
 * A body is only replayed for the same model and account as the child.
 */
export function resolveParentPrefix(
  state: SessionState,
  child: { model: string; account: string },
  cut: PrefixCut,
  now = Date.now(),
): threadLinks.ThreadPrefixInput {
  const analytics = state.cacheAnalytics;
  const live =
    analytics.lastRequestBody && analytics.lastRequestMeta
      ? [
          {
            mode: "live" as const,
            body: analytics.lastRequestBody,
            model: analytics.lastRequestMeta.model,
            account: state.credentialFingerprint ?? "",
            wire: analytics.lastRequestMeta.wire,
          },
        ]
      : [];
  const candidates = [
    ...live,
    ...sessionPrefixSnapshots(state.sessionID, now).map((s) => ({
      mode: "snapshot" as const,
      body: s.body,
      model: s.model,
      account: s.account,
      wire: s.wire,
    })),
  ];
  if (candidates.length === 0)
    return { mode: "cold", reason: "no_cached_body" };
  for (const candidate of candidates) {
    const prefix = cut(decompressBody(candidate.body));
    if (prefix === null) continue;
    if (candidate.model !== child.model) {
      return { mode: "cold", reason: "model_mismatch" };
    }
    if (candidate.account !== child.account) {
      return { mode: "cold", reason: "account_mismatch" };
    }
    return {
      mode: candidate.mode,
      model: candidate.model,
      account: candidate.account,
      wire: candidate.wire,
      body: compressBody(prefix),
      bodyBytes: Buffer.byteLength(prefix),
    };
  }
  return { mode: "cold", reason: "anchor_not_cached" };
}
