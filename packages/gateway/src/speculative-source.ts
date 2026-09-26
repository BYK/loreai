/** Short-lived, uncommitted source conversion for a timed-out foreground turn. */

import {
  currentTenantId,
  db,
  projectId,
  type LoreMessageWithParts,
} from "@loreai/core";
import { deterministicID, visibleContentForMessage } from "./temporal-adapter";
import type { GatewayMessage } from "./translate/types";

type Provenance = Pick<
  GatewayMessage,
  "content" | "provenanceContent" | "provenancePositions"
>;

export type SpeculativeSource = {
  projectPath: string;
  projectID: string;
  protocol: string;
  sourceCount: number;
  sourceDigest: string;
  /** Checkpoint state when this raw snapshot was produced. */
  fallbackReason: string;
  lastMessageID: string;
  offset: number;
  raw: LoreMessageWithParts[];
  resolvedTokens: number[];
  ids: Map<string, string>;
  provenance: Map<string, Provenance>;
  connection: ReturnType<typeof db>;
  expiresAt: number;
};

const MAX_SESSIONS = 4;
const MAX_BYTES = 32_000_000;
const MAX_TOTAL_BYTES = 48_000_000;
export const SPECULATIVE_SOURCE_MAX_MESSAGES = 65_536;
const TTL_MS = 5 * 60_000;
const speculative = new Map<
  string,
  SpeculativeSource & {
    sizeBytes: number;
    expiryTimer: ReturnType<typeof setTimeout>;
  }
>();
let retainedBytes = 0;

function drop(key: string): void {
  const entry = speculative.get(key);
  if (!entry) return;
  clearTimeout(entry.expiryTimer);
  retainedBytes -= entry.sizeBytes;
  speculative.delete(key);
}

function key(sessionID: string): string {
  return `${currentTenantId()}\x1f${sessionID}`;
}

/** Last ID/index is a cheap hint; SourceCheckpoint also verifies the full
 * prefix digest before any cached conversion can be used. */
export function findSpeculativeSource(input: {
  sessionID: string;
  projectPath: string;
  protocol: string;
  messages: GatewayMessage[];
}): SpeculativeSource | undefined {
  const entry = speculative.get(key(input.sessionID));
  if (!entry) return;
  if (entry.expiresAt <= Date.now() || entry.connection !== db()) {
    drop(key(input.sessionID));
    return;
  }
  if (
    entry.projectPath !== input.projectPath ||
    entry.protocol !== input.protocol ||
    entry.sourceCount > input.messages.length
  )
    return;
  if (entry.projectID !== projectId(input.projectPath)) {
    drop(key(input.sessionID));
    return;
  }
  const index = entry.sourceCount - 1;
  const last = input.messages[index];
  if (
    !last ||
    deterministicID(
      input.sessionID,
      last.role,
      index,
      visibleContentForMessage(last),
    ) !== entry.lastMessageID
  )
    return;
  return entry;
}

export function rememberSpeculativeSource(
  sessionID: string,
  entry: Omit<SpeculativeSource, "expiresAt" | "connection" | "projectID">,
): void {
  if (!entry.raw.length || entry.sourceCount > SPECULATIVE_SOURCE_MAX_MESSAGES)
    return;
  const projectID = projectId(entry.projectPath);
  if (!projectID) return;
  // A media-rich request can carry many megabytes in opaque blocks. Bound the
  // speculative copy independently of the durable source-window store.
  const sizeBytes = Buffer.byteLength(
    JSON.stringify([
      entry.raw,
      entry.resolvedTokens,
      [...entry.ids],
      [...entry.provenance],
    ]),
  );
  if (sizeBytes > MAX_BYTES) return;
  const own = key(sessionID);
  drop(own);
  while (
    speculative.size >= MAX_SESSIONS ||
    retainedBytes + sizeBytes > MAX_TOTAL_BYTES
  )
    drop(speculative.keys().next().value!);
  const stored = {
    ...entry,
    projectID,
    sizeBytes,
    raw: entry.raw,
    ids: new Map(entry.ids),
    provenance: new Map(structuredClone([...entry.provenance])),
    connection: db(),
    expiresAt: Date.now() + TTL_MS,
    expiryTimer: undefined as unknown as ReturnType<typeof setTimeout>,
  };
  stored.expiryTimer = setTimeout(() => {
    if (speculative.get(own) === stored) drop(own);
  }, TTL_MS);
  stored.expiryTimer.unref?.();
  speculative.set(own, stored);
  retainedBytes += sizeBytes;
}

export function clearSpeculativeSource(sessionID?: string): void {
  if (sessionID) drop(key(sessionID));
  else {
    for (const sessionKey of speculative.keys()) drop(sessionKey);
    retainedBytes = 0;
  }
}
