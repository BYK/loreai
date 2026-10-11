import { describe, expect, it } from "vitest";
import { close } from "../src/db";
import {
  listPrefixSnapshots,
  PREFIX_SNAPSHOT_LIMIT,
  pushPrefixSnapshot,
} from "../src/prefix-snapshots";

let seq = 0;

function snapshot(sessionID: string, sentAt: number, ttl = 300_000) {
  return {
    sessionID,
    projectID: "p",
    model: "claude-sonnet-4-5",
    account: "cred-a",
    wire: "anthropic",
    body: new Uint8Array([40, 181, 47, 253, sentAt % 256, 0]),
    bodyBytes: 1000 + (sentAt % 1000),
    sentAt,
    expiresAt: sentAt + ttl,
  };
}

describe("prefix snapshots", () => {
  it("keeps unexpired snapshots newest first, byte-exact, across a restart", () => {
    const sid = `s-${seq++}`;
    pushPrefixSnapshot(snapshot(sid, 1_000), 1_000);
    pushPrefixSnapshot(snapshot(sid, 2_000, 3_600_000), 2_000);
    close();
    const list = listPrefixSnapshots(sid, 3_000);
    expect(list.map((s) => s.sentAt)).toEqual([2_000, 1_000]);
    expect(Buffer.from(list[1].body)).toEqual(
      Buffer.from(snapshot(sid, 1_000).body),
    );
    expect(list[0]).toMatchObject({ expiresAt: 3_602_000, bodyBytes: 1_000 });
  });

  it("prunes expired entries on read and on push", () => {
    const sid = `s-${seq++}`;
    pushPrefixSnapshot(snapshot(sid, 1_000), 1_000);
    pushPrefixSnapshot(snapshot(sid, 200_000), 200_000);
    expect(listPrefixSnapshots(sid, 301_000).map((s) => s.sentAt)).toEqual([
      200_000,
    ]);
    pushPrefixSnapshot(snapshot(sid, 600_000), 600_000);
    expect(listPrefixSnapshots(sid, 600_000).map((s) => s.sentAt)).toEqual([
      600_000,
    ]);
    pushPrefixSnapshot(snapshot(sid, 1_000), 700_000);
    expect(listPrefixSnapshots(sid, 700_000)).toHaveLength(1);
  });

  it("drops the oldest beyond the per-session limit and isolates sessions", () => {
    const sid = `s-${seq++}`;
    for (let i = 0; i < PREFIX_SNAPSHOT_LIMIT + 2; i++) {
      pushPrefixSnapshot(snapshot(sid, 1_000 + i), 1_000 + i);
    }
    const list = listPrefixSnapshots(sid, 2_000);
    expect(list).toHaveLength(PREFIX_SNAPSHOT_LIMIT);
    expect(list.at(-1)?.sentAt).toBe(1_002);
    expect(listPrefixSnapshots(`s-${seq++}`, 2_000)).toEqual([]);
  });
});
