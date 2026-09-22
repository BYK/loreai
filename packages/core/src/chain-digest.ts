import { createHash } from "node:crypto";

/** Versioned seed so changing the framing cannot silently reuse old payloads. */
export const CHAIN_DIGEST_SEED = createHash("sha256")
  .update("lore-chain-digest-v2")
  .digest("hex");

/** Extend a deterministic, order-sensitive digest with one JSON value. */
export function extendChainDigest(previous: string, value: unknown): string {
  const encoded = JSON.stringify(value) ?? "null";
  return createHash("sha256")
    .update(previous)
    .update(`${Buffer.byteLength(encoded, "utf8")}:`)
    .update(encoded)
    .digest("hex");
}

/** Digest a sequence, optionally starting from a previously verified prefix. */
export function digestChain(
  values: readonly unknown[],
  previous = CHAIN_DIGEST_SEED,
): string {
  let digest = previous;
  for (const value of values) digest = extendChainDigest(digest, value);
  return digest;
}
