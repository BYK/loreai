import { createHash } from "node:crypto";

const RECORD_BYTES = 40; // SHA-256 key (32) + exact safe-integer count (float64).
const CHECKSUM_BYTES = 32;
const signature = (version: string) => Buffer.from(`${version}:binary-v1\0`);
const checksum = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest();

/** Local disposable cache format; no runtime- or architecture-specific serializer. */
export function encodeTokenCounts(
  version: string,
  entries: ReadonlyArray<readonly [string, number]>,
  maxEntries: number,
): Buffer | undefined {
  if (entries.length > maxEntries) return;
  const magic = signature(version);
  const dataStart = magic.length + 4;
  const result = Buffer.alloc(
    dataStart + entries.length * RECORD_BYTES + CHECKSUM_BYTES,
  );
  magic.copy(result);
  result.writeUInt32LE(entries.length, magic.length);
  for (const [i, [key, value]] of entries.entries()) {
    if (
      !/^[a-f0-9]{64}$/.test(key) ||
      !Number.isSafeInteger(value) ||
      value < 0
    )
      return;
    const offset = dataStart + i * RECORD_BYTES;
    result.write(key, offset, 32, "hex");
    result.writeDoubleLE(value, offset + 32);
  }
  const end = result.length - CHECKSUM_BYTES;
  checksum(result.subarray(0, end)).copy(result, end);
  return result;
}

/** A corrupt/unknown cache is always a miss, never an ingestion frontier. */
export function decodeTokenCounts(
  payload: unknown,
  version: string,
  maxEntries: number,
  maxBytes: number,
): Map<string, number> | undefined {
  try {
    if (typeof payload === "string") {
      // Read existing JSON caches without changing their tokenizer-policy key.
      if (Buffer.byteLength(payload) > maxBytes) return;
      const decoded: unknown = JSON.parse(payload);
      if (
        !Array.isArray(decoded) ||
        decoded.length !== 3 ||
        decoded[0] !== version ||
        !Array.isArray(decoded[1]) ||
        decoded[1].length > maxEntries
      )
        return;
      const data: unknown[] = decoded[1];
      if (decoded[2] !== checksum(JSON.stringify(data)).toString("hex")) return;
      const entries = new Map<string, number>();
      for (const e of data) {
        if (
          !Array.isArray(e) ||
          e.length !== 2 ||
          typeof e[0] !== "string" ||
          !/^[a-f0-9]{64}$/.test(e[0]) ||
          !Number.isSafeInteger(e[1]) ||
          e[1] < 0
        )
          return;
        entries.set(e[0], e[1]);
      }
      return entries;
    }
    if (!(payload instanceof Uint8Array) || payload.byteLength > maxBytes)
      return;
    const bytes = Buffer.from(
      payload.buffer,
      payload.byteOffset,
      payload.byteLength,
    );
    const magic = signature(version);
    const dataStart = magic.length + 4;
    if (
      bytes.length < dataStart + CHECKSUM_BYTES ||
      !bytes.subarray(0, magic.length).equals(magic)
    )
      return;
    const count = bytes.readUInt32LE(magic.length);
    if (
      count > maxEntries ||
      bytes.length !== dataStart + count * RECORD_BYTES + CHECKSUM_BYTES
    )
      return;
    const end = bytes.length - CHECKSUM_BYTES;
    // Hash the header, count, and exact serialized records, without a JSON round trip.
    if (!checksum(bytes.subarray(0, end)).equals(bytes.subarray(end))) return;
    const entries = new Map<string, number>();
    for (let i = 0; i < count; i++) {
      const offset = dataStart + i * RECORD_BYTES;
      const value = bytes.readDoubleLE(offset + 32);
      if (!Number.isSafeInteger(value) || value < 0) return;
      entries.set(bytes.toString("hex", offset, offset + 32), value);
    }
    return entries;
  } catch {
    return;
  }
}
