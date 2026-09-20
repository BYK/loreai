/**
 * Busy-session fixture (UI-06c): the generator is deterministic and mixed,
 * the stream engine's events are honest (in order, sized as declared,
 * transitions in the declared sequence), and the client-side merge
 * primitives never lose, duplicate or reorder text — including after a
 * disconnect with a stale snapshot, once the snapshot is refetched.
 */
import { describe, expect, it } from "vitest";

import {
  BUSY_DEFAULT_BLOCKS,
  BUSY_DELTA_MAX_CHARS,
  BUSY_DELTA_MIN_CHARS,
  BUSY_STREAMS,
  BusyStreamEngine,
  type BusyEvent,
  applyEvents,
  busyMessageId,
  generateBusySession,
  mulberry32,
  mutateMessage,
  reconcile,
} from "~/fixture/busy-session";
import { buildBlocks, messageBlock } from "~/reader/blocks";
import { BUSY_MAX_BLOCKS, intParam, verifyAgainst } from "~/routes/BusyFixture";

function ids(list: ReadonlyArray<{ id: string }>): string[] {
  return list.map((m) => m.id);
}

function assertOrdered(
  list: ReadonlyArray<{ created_at: number; id: string }>,
) {
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1]!;
    const b = list[i]!;
    expect(
      a.created_at < b.created_at ||
        (a.created_at === b.created_at && a.id < b.id),
      `row ${i} (${b.id}) out of order after ${a.id}`,
    ).toBe(true);
  }
}

describe("busy fixture: generator", () => {
  it("is deterministic for a seed and differs across seeds", () => {
    const a = generateBusySession({ blocks: 300, seed: 7 });
    const b = generateBusySession({ blocks: 300, seed: 7 });
    const c = generateBusySession({ blocks: 300, seed: 8 });
    expect(a.messages).toEqual(b.messages);
    expect(a.distillations).toEqual(b.distillations);
    expect(a.messages.map((m) => m.content)).not.toEqual(
      c.messages.map((m) => m.content),
    );
  });

  it("produces the requested count with stable ids and strictly increasing timestamps", () => {
    const s = generateBusySession({ blocks: 1_000, seed: 3 });
    expect(s.messages).toHaveLength(1_000);
    expect(new Set(ids(s.messages)).size).toBe(1_000);
    expect(s.messages[0]!.id).toBe(busyMessageId(0));
    expect(s.messages[999]!.id).toBe("busy-000999");
    for (let i = 1; i < s.messages.length; i++) {
      expect(s.messages[i]!.created_at).toBeGreaterThan(
        s.messages[i - 1]!.created_at,
      );
    }
    expect(s.messages.every((m) => m.metadata !== null)).toBe(true);
  });

  it("mixes prose, code, tool output, a system prompt and Lore-injected blocks", () => {
    const s = generateBusySession({ blocks: 2_000, seed: 7 });
    expect(s.kinds.system).toBe(1);
    expect(s.kinds.lore).toBeGreaterThan(10);
    expect(s.kinds.text).toBeGreaterThan(800);
    expect(s.kinds.code).toBeGreaterThan(150);
    expect(s.kinds.tool).toBeGreaterThan(150);
    expect(
      s.kinds.system +
        s.kinds.lore +
        s.kinds.text +
        s.kinds.code +
        s.kinds.tool,
    ).toBe(2_000);
    const blocks = buildBlocks({
      messages: s.messages,
      distillations: s.distillations,
    });
    const origins = new Set(blocks.messages.map((b) => b.origin));
    expect(origins).toEqual(new Set(["system", "lore", "user", "agent"]));
    const toolParts = blocks.messages.filter((b) =>
      b.parts.some((p) => p.kind === "tool"),
    );
    const reasoning = blocks.messages.filter((b) =>
      b.parts.some((p) => p.kind === "reasoning"),
    );
    expect(toolParts.length).toBe(s.kinds.tool);
    expect(reasoning.length).toBeGreaterThan(20);
    expect(blocks.distillations).toHaveLength(3);
    expect(blocks.distillations.every((d) => d.kind === "distillation")).toBe(
      true,
    );
  });

  it("generates the default 10k blocks in a bounded time", () => {
    const started = performance.now();
    const s = generateBusySession();
    const ms = performance.now() - started;
    expect(s.messages).toHaveLength(BUSY_DEFAULT_BLOCKS);
    expect(s.chars).toBeGreaterThan(2_000_000);
    expect(ms).toBeLessThan(2_000);
  });

  it("mulberry32 is a stable PRNG in [0, 1)", () => {
    const r1 = mulberry32(42);
    const r2 = mulberry32(42);
    const seq1 = Array.from({ length: 5 }, r1);
    const seq2 = Array.from({ length: 5 }, r2);
    expect(seq1).toEqual(seq2);
    expect(seq1.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(new Set(seq1).size).toBe(5);
  });
});

describe("busy fixture: stream engine", () => {
  const base = generateBusySession({ blocks: 200, seed: 5 }).messages;

  it("opens one stream per lane and emits one text delta per lane per tick, sized as declared", () => {
    const engine = new BusyStreamEngine(base, 5);
    expect(engine.status()).toHaveLength(BUSY_STREAMS);
    expect(engine.appendedCount).toBe(BUSY_STREAMS);
    const events = engine.tick();
    expect(events).toHaveLength(BUSY_STREAMS);
    expect(events.every((e) => e.kind === "replace")).toBe(true);
    for (const e of events) {
      expect(e.payload).toBeGreaterThanOrEqual(BUSY_DELTA_MIN_CHARS);
      expect(e.payload).toBeLessThanOrEqual(BUSY_DELTA_MAX_CHARS);
      expect(e.message.content.length).toBe(e.payload);
    }
    for (let i = 0; i < 500; i++) engine.tick();
    expect(
      engine.payloadSizes.every(
        (n) => n >= BUSY_DELTA_MIN_CHARS && n <= BUSY_DELTA_MAX_CHARS,
      ),
    ).toBe(true);
    expect(engine.payloadSizes.length).toBeGreaterThan(1_000);
  });

  it("walks text → tool-running → tool-done → (approval →) complete → new turn", () => {
    const engine = new BusyStreamEngine(base, 5, 1);
    const phases: string[] = [];
    for (let i = 0; i < 400; i++) {
      engine.tick();
      const phase = engine.status()[0]!.phase;
      if (phases[phases.length - 1] !== phase) phases.push(phase);
    }
    const joined = phases.join(",");
    expect(joined).toContain("text,tool-running,tool-done,complete,text");
    expect(joined).toContain("tool-done,approval-pending,approved,text");
    // Approvals come in pending → approved pairs on the same message.
    const pendings = engine.approvals.filter((a) => a.phase === "pending");
    const approved = engine.approvals.filter((a) => a.phase === "approved");
    expect(pendings.length).toBeGreaterThan(0);
    expect(approved.map((a) => a.id)).toEqual(
      pendings.slice(0, approved.length).map((a) => a.id),
    );
    // Each completed turn appended a user message and a fresh assistant one.
    expect(engine.appendedCount).toBeGreaterThan(1 + 2 * 3);
  });

  it("tool status transitions replace the same block: running marker then output, never a second block", () => {
    const engine = new BusyStreamEngine(base, 5, 1);
    let client = reconcile(base, engine.snapshot());
    const streamId = engine.status()[0]!.messageId;
    let sawRunning = false;
    let sawDone = false;
    for (let i = 0; i < 60; i++) {
      client = applyEvents(client, engine.tick());
      const m = client.find((x) => x.id === streamId)!;
      if (m.content.endsWith("… running")) sawRunning = true;
      if (m.content.endsWith("[exit 0]")) {
        sawDone = true;
        break;
      }
    }
    expect(sawRunning).toBe(true);
    expect(sawDone).toBe(true);
    expect(client.filter((m) => m.id === streamId)).toHaveLength(1);
    const block = messageBlock(client.find((x) => x.id === streamId)!);
    expect(block.parts.map((p) => p.kind)).toEqual(["text", "tool"]);
  });

  it("a 1,000-event burst applies without lost, duplicated or reordered text", () => {
    const engine = new BusyStreamEngine(base, 5);
    let client = reconcile(base, engine.snapshot());
    const events = engine.burst(1_000);
    expect(events.length).toBeGreaterThanOrEqual(1_000);
    client = applyEvents(client, events);
    assertOrdered(client);
    expect(new Set(ids(client)).size).toBe(client.length);
    expect(verifyAgainst(client, base, engine.expected())).toEqual({
      ok: true,
      duplicates: 0,
      missing: 0,
      mismatched: 0,
      extra: 0,
      ordered: true,
    });
    // Same events applied twice (a replayed frame) change nothing.
    expect(applyEvents(client, events)).toEqual(client);
  });

  it("coalescing to the newest event per id gives the same result as applying every event", () => {
    const engine = new BusyStreamEngine(base, 5);
    const client = reconcile(base, engine.snapshot());
    const events = engine.burst(400);
    const newest = new Map<string, BusyEvent>();
    for (const e of events) newest.set(e.message.id, e);
    expect(applyEvents(client, [...newest.values()])).toEqual(
      applyEvents(client, events),
    );
  });

  it("stream text is appended in order: every delta is a prefix-preserving extension", () => {
    const engine = new BusyStreamEngine(base, 5, 1);
    let previous = "";
    for (let i = 0; i < 39; i++) {
      const [e] = engine.tick();
      expect(e!.message.content.startsWith(previous)).toBe(true);
      expect(e!.message.content.length - previous.length).toBe(e!.payload);
      previous = e!.message.content;
    }
  });

  describe("disconnect / reconnect", () => {
    function offline(eventsOffline: number) {
      const engine = new BusyStreamEngine(base, 11);
      let client = reconcile(base, engine.snapshot());
      client = applyEvents(client, engine.burst(120));
      const stale = engine.snapshot();
      // Offline: the server keeps moving, the client hears nothing.
      engine.burst(eventsOffline);
      return { engine, client, stale };
    }

    it("a fresh snapshot converges the client in one reconcile", () => {
      const { engine, client, stale } = offline(480);
      expect(verifyAgainst(client, base, engine.expected()).ok).toBe(false);
      const fresh = reconcile(client, engine.snapshot());
      expect(verifyAgainst(fresh, base, engine.expected()).ok).toBe(true);
      expect(new Set(ids(fresh)).size).toBe(fresh.length);
      assertOrdered(fresh);
      expect(stale.messages.length).toBeLessThan(
        engine.snapshot().messages.length,
      );
    });

    it("a stale snapshot leaves gaps live deltas cannot fill; refetching fills them in order", () => {
      const { engine, client, stale } = offline(480);
      let merged = reconcile(client, stale);
      // Live traffic resumes: touched messages converge, untouched ones stay missing.
      merged = applyEvents(merged, engine.burst(80));
      const report = verifyAgainst(merged, base, engine.expected());
      expect(report.duplicates).toBe(0);
      expect(report.ordered).toBe(true);
      expect(report.missing).toBeGreaterThan(0);
      // Refetch: the gaps are inserted at their timestamp, not appended.
      const refetched = reconcile(merged, engine.snapshot());
      expect(verifyAgainst(refetched, base, engine.expected())).toMatchObject({
        ok: true,
        missing: 0,
        duplicates: 0,
        ordered: true,
      });
      assertOrdered(refetched);
    });

    it("reconcile never duplicates an id even when the snapshot arrives twice", () => {
      const { engine, client } = offline(40);
      const once = reconcile(client, engine.snapshot());
      const twice = reconcile(once, engine.snapshot());
      expect(twice).toEqual(once);
      expect(new Set(ids(twice)).size).toBe(twice.length);
    });
  });

  it("mutateMessage changes exactly one block's content and verify reports it as changed", () => {
    const engine = new BusyStreamEngine(base, 5);
    const client = reconcile(base, engine.snapshot());
    const edited = mutateMessage(client, base[10]!.id);
    expect(edited.filter((m, i) => m !== client[i])).toHaveLength(1);
    expect(edited[10]!.content).toContain("Edited after the link was made.");
    expect(verifyAgainst(edited, base, engine.expected())).toMatchObject({
      ok: false,
      mismatched: 1,
      missing: 0,
      duplicates: 0,
    });
  });
});

describe("busy fixture: verifyAgainst", () => {
  const base = generateBusySession({ blocks: 20, seed: 1 }).messages;
  const expected = new Map<string, (typeof base)[number]>();

  it("passes on the untouched base", () => {
    expect(verifyAgainst(base, base, expected).ok).toBe(true);
  });
  it("flags duplicates, missing, extra and reordering separately", () => {
    const dup = [...base, base[3]!];
    expect(verifyAgainst(dup, base, expected)).toMatchObject({
      ok: false,
      duplicates: 1,
    });
    const missing = base.filter((_, i) => i !== 4);
    expect(verifyAgainst(missing, base, expected)).toMatchObject({
      ok: false,
      missing: 1,
    });
    const extra = [...base, { ...base[0]!, id: "stranger" }];
    expect(verifyAgainst(extra, base, expected)).toMatchObject({
      ok: false,
      extra: 1,
    });
    const swapped = [...base];
    [swapped[2], swapped[3]] = [swapped[3]!, swapped[2]!];
    expect(verifyAgainst(swapped, base, expected)).toMatchObject({
      ok: false,
      ordered: false,
      duplicates: 0,
      missing: 0,
    });
  });
});

describe("busy fixture: query parameters", () => {
  it("falls back on anything that is not a positive number and clamps the block count", () => {
    expect(intParam(undefined, 10)).toBe(10);
    expect(intParam("", 10)).toBe(10);
    expect(intParam("abc", 10)).toBe(10);
    expect(intParam("0", 10)).toBe(10);
    expect(intParam("-5", 10)).toBe(10);
    expect(intParam("NaN", 10)).toBe(10);
    expect(intParam("Infinity", 10)).toBe(10);
    expect(intParam("12.9", 10)).toBe(12);
    expect(intParam("1e9", 10, BUSY_MAX_BLOCKS)).toBe(BUSY_MAX_BLOCKS);
    expect(intParam("1e9", 10)).toBe(1_000_000_000);
  });
});
