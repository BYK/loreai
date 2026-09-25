/** Short-lived, uncommitted source conversion for a timed-out foreground turn. */

import { currentTenantId, db, type LoreMessageWithParts } from "@loreai/core";
import { deterministicID, visibleContentForMessage } from "./temporal-adapter";
import type { GatewayMessage } from "./translate/types";

type Provenance = Pick<
  GatewayMessage,
  "content" | "provenanceContent" | "provenancePositions"
>;

export type SpeculativeSource = {
  projectPath: string;
  protocol: string;
  sourceCount: number;
  sourceDigest: string;
  /** Checkpoint state when this raw snapshot was produced. */
  fallbackReason: string;
  lastMessageID: string;
  offset: number;
  raw: LoreMessageWithParts[];
  ids: Map<string, string>;
  provenance: Map<string, Provenance>;
  connection: ReturnType<typeof db>;
  expiresAt: number;
};

const MAX_SESSIONS = 4;
const MAX_BYTES = 8_000_000;
export const SPECULATIVE_SOURCE_MAX_MESSAGES = 16_384;
const TTL_MS = 5 * 60_000;
const speculative = new Map<string, SpeculativeSource>();

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
    speculative.delete(key(input.sessionID));
    return;
  }
  if (
    entry.projectPath !== input.projectPath ||
    entry.protocol !== input.protocol ||
    entry.sourceCount > input.messages.length
  )
    return;
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
  entry: Omit<SpeculativeSource, "expiresAt" | "connection">,
): void {
  if (!entry.raw.length || entry.sourceCount > SPECULATIVE_SOURCE_MAX_MESSAGES)
    return;
  // A media-rich request can carry many megabytes in opaque blocks. Bound the
  // speculative copy independently of the durable source-window store.
  if (
    Buffer.byteLength(
      JSON.stringify([entry.raw, [...entry.ids], [...entry.provenance]]),
    ) > MAX_BYTES
  )
    return;
  const own = key(sessionID);
  speculative.delete(own);
  while (speculative.size >= MAX_SESSIONS)
    speculative.delete(speculative.keys().next().value!);
  speculative.set(own, {
    ...entry,
    raw: entry.raw,
    ids: new Map(entry.ids),
    provenance: new Map(structuredClone([...entry.provenance])),
    connection: db(),
    expiresAt: Date.now() + TTL_MS,
  });
}

export function clearSpeculativeSource(sessionID?: string): void {
  if (sessionID) speculative.delete(key(sessionID));
  else speculative.clear();
}
