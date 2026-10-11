import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { db, withTransaction } from "@loreai/core";

export type SpikeVariant = "yjs" | "automerge" | "nocrdt";

export interface SpikeClaims {
  variant: SpikeVariant;
  documentId: string;
  participant: string;
  expiresAt: number;
}

const ACCESS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS comparison_spike_secrets (
    variant TEXT PRIMARY KEY,
    secret TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS comparison_spike_shares (
    variant TEXT NOT NULL,
    document_id TEXT NOT NULL,
    participant TEXT NOT NULL,
    owner INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (variant, document_id, participant)
  );
  CREATE INDEX IF NOT EXISTS idx_comparison_spike_shares_document
    ON comparison_spike_shares (variant, document_id);
  CREATE TABLE IF NOT EXISTS comparison_spike_attribution (
    variant TEXT NOT NULL,
    document_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    participant TEXT NOT NULL,
    client_author TEXT,
    PRIMARY KEY (variant, document_id, sequence)
  );
`;

const revokeHandlers = new Map<
  SpikeVariant,
  Set<(documentId: string, participant: string) => void>
>();

export function initializeSpikeAccess(): void {
  db().exec(ACCESS_SCHEMA);
}

function secretFor(variant: SpikeVariant): Buffer {
  initializeSpikeAccess();
  const connection = db();
  connection
    .query(
      "INSERT OR IGNORE INTO comparison_spike_secrets (variant, secret) VALUES (?, ?)",
    )
    .run(variant, randomBytes(32).toString("base64url"));
  const row = connection
    .query("SELECT secret FROM comparison_spike_secrets WHERE variant = ?")
    .get(variant) as { secret: string } | undefined;
  if (!row) throw new Error("Spike token secret is unavailable");
  return Buffer.from(row.secret, "base64url");
}

function sign(variant: SpikeVariant, payload: string): string {
  return createHmac("sha256", secretFor(variant))
    .update(payload)
    .digest("base64url");
}

export function issueSpikeDocument(
  variant: SpikeVariant,
  participant: string,
): { documentId: string; token: string } {
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(participant)) {
    throw new Error("Invalid participant");
  }
  const documentId = randomUUID();
  initializeSpikeAccess();
  withTransaction(() => {
    db()
      .query(
        "INSERT INTO comparison_spike_shares (variant, document_id, participant, owner) VALUES (?, ?, ?, 1)",
      )
      .run(variant, documentId, participant);
  });
  return {
    documentId,
    token: issueSpikeToken(variant, documentId, participant),
  };
}

export function registerSpikeDocument(
  variant: SpikeVariant,
  documentId: string,
  participant: string,
): void {
  if (!documentId || documentId.length > 200) {
    throw new Error("Invalid document ID");
  }
  initializeSpikeAccess();
  if (
    db()
      .query(
        "SELECT 1 AS present FROM comparison_spike_shares WHERE variant = ? AND document_id = ? LIMIT 1",
      )
      .get(variant, documentId)
  ) {
    throw new Error("Document already registered");
  }
  db()
    .query(
      "INSERT INTO comparison_spike_shares (variant, document_id, participant, owner) VALUES (?, ?, ?, 1)",
    )
    .run(variant, documentId, participant);
}

export function issueSpikeToken(
  variant: SpikeVariant,
  documentId: string,
  participant: string,
): string {
  initializeSpikeAccess();
  if (!hasSpikeShare(variant, documentId, participant)) {
    throw new Error("Document access denied");
  }
  const payload = Buffer.from(
    JSON.stringify({
      variant,
      documentId,
      participant,
      expiresAt: Date.now() + 2 * 60 * 60 * 1000,
    } satisfies SpikeClaims),
  ).toString("base64url");
  return `${payload}.${sign(variant, payload)}`;
}

export function verifySpikeToken(
  token: string,
  variant: SpikeVariant,
  documentId?: string,
  requireShare = true,
): SpikeClaims | undefined {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return undefined;
  let expected: string;
  try {
    expected = sign(variant, payload);
  } catch {
    return undefined;
  }
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (
    actualBytes.length !== expectedBytes.length ||
    !timingSafeEqual(actualBytes, expectedBytes)
  ) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    if (
      !value ||
      typeof value !== "object" ||
      !("variant" in value) ||
      !("documentId" in value) ||
      !("participant" in value) ||
      !("expiresAt" in value)
    ) {
      return undefined;
    }
    const claims = value as SpikeClaims;
    if (
      claims.variant !== variant ||
      (documentId !== undefined && claims.documentId !== documentId) ||
      typeof claims.participant !== "string" ||
      !Number.isSafeInteger(claims.expiresAt) ||
      claims.expiresAt <= Date.now() ||
      (requireShare &&
        !hasSpikeShare(variant, claims.documentId, claims.participant))
    ) {
      return undefined;
    }
    return claims;
  } catch {
    return undefined;
  }
}

export function hasSpikeShare(
  variant: SpikeVariant,
  documentId: string,
  participant: string,
): boolean {
  const row = db()
    .query(
      "SELECT 1 AS shared FROM comparison_spike_shares WHERE variant = ? AND document_id = ? AND participant = ?",
    )
    .get(variant, documentId, participant);
  return row !== null && row !== undefined;
}

export function isSpikeOwner(
  variant: SpikeVariant,
  documentId: string,
  participant: string,
): boolean {
  const row = db()
    .query(
      "SELECT 1 AS owner FROM comparison_spike_shares WHERE variant = ? AND document_id = ? AND participant = ? AND owner = 1",
    )
    .get(variant, documentId, participant);
  return row !== null && row !== undefined;
}

export function grantSpikeShare(
  variant: SpikeVariant,
  documentId: string,
  participant: string,
): void {
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(participant)) {
    throw new Error("Invalid participant");
  }
  db()
    .query(
      "INSERT OR IGNORE INTO comparison_spike_shares (variant, document_id, participant, owner) VALUES (?, ?, ?, 0)",
    )
    .run(variant, documentId, participant);
}

export function revokeSpikeShare(
  variant: SpikeVariant,
  documentId: string,
  participant: string,
): void {
  db()
    .query(
      "DELETE FROM comparison_spike_shares WHERE variant = ? AND document_id = ? AND participant = ? AND owner = 0",
    )
    .run(variant, documentId, participant);
  for (const handler of revokeHandlers.get(variant) ?? []) {
    handler(documentId, participant);
  }
}

export function registerSpikeRevocationHandler(
  variant: SpikeVariant,
  handler: (documentId: string, participant: string) => void,
): () => void {
  const handlers = revokeHandlers.get(variant) ?? new Set();
  handlers.add(handler);
  revokeHandlers.set(variant, handlers);
  return () => {
    handlers.delete(handler);
    if (handlers.size === 0) revokeHandlers.delete(variant);
  };
}

export function bearerToken(request: Request): string | undefined {
  return /^Bearer\s+(.+)$/i.exec(
    request.headers.get("authorization") ?? "",
  )?.[1];
}

export function nextSpikeSequence(
  variant: SpikeVariant,
  documentId: string,
): number {
  const row = db()
    .query(
      "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM comparison_spike_attribution WHERE variant = ? AND document_id = ?",
    )
    .get(variant, documentId) as { sequence: number } | undefined;
  return (row?.sequence ?? 0) + 1;
}

export function recordSpikeAttribution(
  variant: SpikeVariant,
  documentId: string,
  sequence: number,
  participant: string,
  clientAuthor: string | null,
): void {
  db()
    .query(
      "INSERT INTO comparison_spike_attribution (variant, document_id, sequence, participant, client_author) VALUES (?, ?, ?, ?, ?)",
    )
    .run(variant, documentId, sequence, participant, clientAuthor);
}
