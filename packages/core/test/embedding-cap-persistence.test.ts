import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../src/db";
import { _persistEmbedCap, _readPersistedEmbedCap } from "../src/embedding";

// Mirrors EMBED_CAP_KV_KEY in embedding.ts (private). Only used to seed corrupt
// rows for the guard tests below.
const KV_KEY = "lore:embedding_cap";

function writeRaw(value: string): void {
  db()
    .query(
      "INSERT INTO kv_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
    )
    .run(KV_KEY, value, value);
}

describe("embedding cap persistence", () => {
  beforeEach(() => {
    db().query("DELETE FROM kv_meta WHERE key = ?").run(KV_KEY);
  });

  it("returns null when no cap is persisted", () => {
    expect(_readPersistedEmbedCap()).toBeNull();
  });

  it("round-trips a persisted cap and records free memory", () => {
    _persistEmbedCap(1234);
    const stored = _readPersistedEmbedCap();
    expect(stored).not.toBeNull();
    expect(stored?.cap).toBe(1234);
    expect(stored?.freeMemBytes).toBeGreaterThan(0);
  });

  it("overwrites the previous cap (ON CONFLICT)", () => {
    _persistEmbedCap(1000);
    _persistEmbedCap(500);
    expect(_readPersistedEmbedCap()?.cap).toBe(500);
  });

  it("returns null on corrupt persisted JSON (never throws)", () => {
    writeRaw("not-json{");
    expect(_readPersistedEmbedCap()).toBeNull();
  });

  it("returns null when persisted JSON is missing required fields", () => {
    writeRaw(JSON.stringify({ cap: 1000 }));
    expect(_readPersistedEmbedCap()).toBeNull();
  });
});
