// Property-based tests for the recall marker/store layer (recall.ts).
//
// This layer is where recall results round-trip through model-visible TEXT
// (📚 markers + `<!-- lore-recall: -->` anchors) and a persisted JSON blob —
// exactly where hostile strings (quotes, `…`, newlines, `-->`, emoji, astral
// chars) can break replay silently. fast-check hammers those seams; failures
// shrink to a minimal counterexample.
//
// Pure functions only — no DB, no LLM — so the battery runs in a few seconds.
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  MAX_RECALL_BATCH_IDS,
  MAX_RECALL_ID_CHARS,
  type RecallScope,
} from "@loreai/core";
import {
  addRecallStoreEntry,
  buildAnchoredRecallMarker,
  buildRecallAnchor,
  buildRecallMarker,
  deserializeRecallStore,
  isRecallMarker,
  MAX_RECALL_STORE_BYTES,
  MAX_RECALL_STORE_ENTRIES,
  parseRecallAnchor,
  parseRecallMarker,
  recallAnchorContext,
  recallStoreKey,
  serializeRecallStore,
} from "../src/recall";
import type {
  GatewayMessage,
  RecallStore,
  StoredRecall,
} from "../src/translate/types";

// Generators mixing mundane strings with fragments that look like marker
// syntax — the point is to try to smuggle/forfeit round-trips.
const HOSTILE = [
  '"',
  "…",
  "\n",
  "<!-- lore-recall:",
  "-->",
  "📚 Searching ",
  ' for "',
  "id:",
  "anchor:",
  "\u0000",
];
const hostileString = (): fc.Arbitrary<string> =>
  fc.oneof(
    fc.string({ unit: "grapheme" }),
    fc.string(),
    fc
      .tuple(
        fc.string({ unit: "grapheme" }),
        fc.constantFrom(...HOSTILE),
        fc.string({ unit: "grapheme" }),
      )
      .map(([a, h, b]) => a + h + b),
  );

const scopeArb: fc.Arbitrary<RecallScope> = fc.constantFrom(
  "all",
  "session",
  "project",
  "knowledge",
);

// \u2028/\u2029 are JS line terminators: MARKER_REGEX uses `.` which
// cannot match them, so a query carrying them cannot round-trip — same
// class as \n/\r. Counterexample found by shrinking: query "\u2028\"".
const LINE_TERMINATORS = /[\n\r\u2028\u2029]/;
const markerQuery = (): fc.Arbitrary<string> =>
  hostileString().filter((q) => q.length > 0 && !LINE_TERMINATORS.test(q));

// Structural equality: deserialized values are fresh objects, so compare
// the canonical serialized form (entry order included).
const mapEquals = (a: RecallStore, b: RecallStore): boolean =>
  serializeRecallStore(a) === serializeRecallStore(b);

const storedRecallArb = (idLenMax: number): fc.Arbitrary<StoredRecall> => {
  const idArb = hostileString().filter(
    (s) => s.length > 0 && s.length <= MAX_RECALL_ID_CHARS,
  );
  const scopeOpt = fc.option(scopeArb, { nil: undefined });
  const detail = fc.option(
    fc.record({
      detailOffset: fc.integer({ min: 0, max: 1_000_000 }),
      detailLimit: fc.integer({ min: 1, max: 16_000 }),
    }),
    { nil: undefined },
  );
  const lookup = fc.oneof(
    fc.record({ kind: fc.constant("none" as const) }),
    fc.record({ kind: fc.constant("id" as const), id: idArb }),
    fc.record({
      kind: fc.constant("ids" as const),
      ids: fc.array(idArb, { minLength: 1, maxLength: MAX_RECALL_BATCH_IDS }),
    }),
  );
  return fc
    .record({
      toolUseId: fc.string({ unit: "grapheme" }).filter((s) => s.length > 0),
      position: fc.integer({ min: 0, max: 10_000 }),
      query: hostileString().filter((s) => Buffer.byteLength(s) <= idLenMax),
      scope: scopeOpt,
      lookup,
      detail,
      result: fc
        .string({ unit: "grapheme" })
        .filter((s) => Buffer.byteLength(s) <= 200),
      anchorId: fc.option(fc.uuid({ version: 4 }), { nil: undefined }),
      anchorContextId: fc.option(
        fc.string({
          unit: fc.constantFrom(
            "0",
            "1",
            "2",
            "3",
            "4",
            "5",
            "6",
            "7",
            "8",
            "9",
            "a",
            "b",
            "c",
            "d",
            "e",
            "f",
          ),
          minLength: 64,
          maxLength: 64,
        }),
        { nil: undefined },
      ),
      companionToolUses: fc.option(
        fc.array(
          fc.record({
            id: fc.string({ unit: "grapheme", minLength: 1 }),
            name: fc.string({ unit: "grapheme" }),
            input: fc.json(),
            side: fc.constantFrom("before" as const, "after" as const),
          }),
          { maxLength: 3 },
        ),
        { nil: undefined },
      ),
    })
    .map((r) => {
      const input: StoredRecall["input"] = { query: r.query };
      if (r.scope !== undefined) input.scope = r.scope;
      if (r.lookup.kind === "id") input.id = r.lookup.id;
      if (r.lookup.kind === "ids") input.ids = r.lookup.ids;
      // detailOffset/detailLimit are only valid alongside a single id.
      if (r.lookup.kind === "id" && r.detail) {
        input.detailOffset = r.detail.detailOffset;
        input.detailLimit = r.detail.detailLimit;
      }
      const rec: StoredRecall = {
        toolUseId: r.toolUseId,
        input,
        position: r.position,
        result: r.result,
      };
      if (r.anchorId !== undefined) rec.anchorId = r.anchorId;
      if (r.anchorContextId !== undefined)
        rec.anchorContextId = r.anchorContextId;
      if (r.companionToolUses !== undefined)
        rec.companionToolUses = r.companionToolUses;
      return rec;
    });
};

// Keys matching the two real families: `anchor:<v4 uuid>` (requires
// anchorId === uuid and a 64-hex anchorContextId to survive validation) or
// legacy `${scope}:${query}` / `id:${id}` keys.
const storeEntryArb = (): fc.Arbitrary<[string, StoredRecall]> =>
  fc
    .tuple(
      fc.constantFrom("anchor" as const, "scope" as const, "id" as const),
      fc.uuid({ version: 4 }),
      scopeArb,
      storedRecallArb(400),
    )
    .chain(([kind, uuid, scope, rec]) => {
      if (kind === "anchor") {
        const anchored: StoredRecall = {
          ...rec,
          anchorId: uuid,
          anchorContextId: rec.anchorContextId ?? "0".repeat(64),
        };
        return fc.constant([`anchor:${uuid}`, anchored] as [
          string,
          StoredRecall,
        ]);
      }
      const plain: StoredRecall = { ...rec, anchorId: undefined };
      delete plain.anchorId;
      const key =
        kind === "id" && rec.input.id
          ? `id:${rec.input.id}`
          : `${scope}:${rec.input.query}`;
      return fc.constant([key, plain] as [string, StoredRecall]);
    });

const recallStoreArb = (): fc.Arbitrary<RecallStore> =>
  fc
    .array(storeEntryArb(), { minLength: 0, maxLength: 20 })
    .map((entries) => new Map(entries));

const contentBlockArb = (): fc.Arbitrary<GatewayMessage["content"][number]> =>
  fc.oneof(
    fc.record({
      type: fc.constant("text" as const),
      text: hostileString(),
    }),
    fc.record({
      type: fc.constant("thinking" as const),
      thinking: hostileString(),
    }),
    fc.record({
      type: fc.constant("tool_use" as const),
      id: fc.string({ unit: "grapheme" }),
      name: fc.string({ unit: "grapheme" }),
      input: fc.json(),
    }),
  );

const messageArb = (): fc.Arbitrary<GatewayMessage> =>
  fc.record({
    role: fc.constantFrom("user" as const, "assistant" as const),
    content: fc.array(contentBlockArb(), { maxLength: 4 }),
    provenanceContent: fc.option(
      fc.array(contentBlockArb(), { maxLength: 4 }),
      { nil: undefined },
    ),
  });

const NUM_RUNS = { numRuns: 300 };

describe("recall marker property battery", () => {
  test("search markers round-trip through model-visible text", () => {
    fc.assert(
      fc.property(markerQuery(), scopeArb, (q, scope) => {
        const marker = buildRecallMarker(q, scope);
        const parsed = parseRecallMarker(marker);
        expect(parsed).toEqual({ query: q, scope });
        if (parsed === null) return;
        expect(recallStoreKey(parsed.query, parsed.scope, parsed.id)).toBe(
          recallStoreKey(q, scope),
        );
        expect(isRecallMarker(marker)).toBe(true);
      }),
      NUM_RUNS,
    );
  });

  test("unknown scope labels parse back as 'all'", () => {
    fc.assert(
      fc.property(
        markerQuery(),
        hostileString().filter(
          (s) => !["all", "session", "project", "knowledge"].includes(s),
        ),
        (q, scope) => {
          const parsed = parseRecallMarker(buildRecallMarker(q, scope));
          expect(parsed).toEqual({ query: q, scope: "all" });
        },
      ),
      NUM_RUNS,
    );
  });

  test("id markers round-trip and oversized ids are rejected", () => {
    fc.assert(
      fc.property(
        hostileString().filter(
          (s) =>
            s.length > 0 &&
            s.length <= MAX_RECALL_ID_CHARS &&
            !LINE_TERMINATORS.test(s),
        ),
        (id) => {
          const parsed = parseRecallMarker(buildRecallMarker("", "all", id));
          expect(parsed).toEqual({ query: "", scope: "all", id });
        },
      ),
      NUM_RUNS,
    );
    fc.assert(
      fc.property(
        fc.string({
          unit: "grapheme",
          minLength: MAX_RECALL_ID_CHARS + 1,
          maxLength: MAX_RECALL_ID_CHARS + 64,
        }),
        (id) => {
          const marker = buildRecallMarker("", "all", id);
          expect(marker).not.toContain(id);
          expect(marker).toContain("an invalid source");
        },
      ),
      NUM_RUNS,
    );
  });

  test("ids arrays render a batch marker that does not parse as an id", () => {
    fc.assert(
      fc.property(
        fc.array(
          hostileString().filter(
            (s) => s.length > 0 && s.length <= MAX_RECALL_ID_CHARS,
          ),
          { minLength: 1, maxLength: MAX_RECALL_BATCH_IDS },
        ),
        (ids) => {
          const marker = buildRecallMarker("", "all", undefined, ids);
          expect(marker).toContain(`Fetching details for ${ids.length} source`);
          for (const id of ids) {
            if (id.length > 3) expect(marker).not.toContain(id);
          }
          expect(parseRecallMarker(marker)).toBeNull();
        },
      ),
      NUM_RUNS,
    );
  });

  test("v4 uuid anchors round-trip; non-v4 strings cannot be smuggled", () => {
    fc.assert(
      fc.property(
        fc.uuid({ version: 4 }),
        markerQuery(),
        scopeArb,
        (u, q, scope) => {
          expect(parseRecallAnchor(buildRecallAnchor(u))).toBe(u);
          expect(
            isRecallMarker(
              buildAnchoredRecallMarker(q, scope, undefined, undefined, u),
            ),
          ).toBe(true);
        },
      ),
      NUM_RUNS,
    );
    fc.assert(
      fc.property(
        fc
          .string()
          .filter(
            (s) =>
              !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                s,
              ),
          ),
        (s) => {
          expect(parseRecallAnchor(buildRecallAnchor(s))).toBeNull();
          expect(parseRecallAnchor(s)).toBeNull();
        },
      ),
      NUM_RUNS,
    );
  });

  test("non-marker text never parses", () => {
    fc.assert(
      fc.property(
        fc
          .string()
          .filter(
            (s) => !s.startsWith("📚 ") && !s.includes("<!-- lore-recall:"),
          ),
        (s) => {
          expect(parseRecallMarker(s)).toBeNull();
          expect(isRecallMarker(s)).toBe(false);
        },
      ),
      NUM_RUNS,
    );
  });

  test("store serialize/deserialize is a round-trip fixed point", () => {
    fc.assert(
      fc.property(recallStoreArb(), (store) => {
        const restored = deserializeRecallStore(serializeRecallStore(store));
        expect(mapEquals(restored, store)).toBe(true);
        // Idempotence: deserializing a second time is a fixed point.
        const once = serializeRecallStore(restored);
        expect(mapEquals(deserializeRecallStore(once), restored)).toBe(true);
      }),
      NUM_RUNS,
    );
  });

  test("deserializeRecallStore is total and self-healing", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string({ unit: "grapheme" }), fc.string(), fc.json()),
        (s) => {
          // A throw would fail the property outright.
          const store = deserializeRecallStore(s);
          expect(store).toBeInstanceOf(Map);
          // Every surviving value must re-validate cleanly into a fresh store.
          const rebuilt: RecallStore = new Map();
          for (const [k, v] of store.entries()) {
            expect(() => addRecallStoreEntry(rebuilt, k, v)).not.toThrow();
          }
          expect(
            mapEquals(
              deserializeRecallStore(serializeRecallStore(store)),
              store,
            ),
          ).toBe(true);
        },
      ),
      NUM_RUNS,
    );
  });

  test("store capacity invariants hold after every add", () => {
    const bigResultArb = fc
      .tuple(storeEntryArb(), fc.integer({ min: 0, max: 20_000 }))
      .map(
        ([[k, v], n]) =>
          [k, { ...v, result: "x".repeat(n) }] as [string, StoredRecall],
      );
    fc.assert(
      fc.property(
        fc.array(bigResultArb, { minLength: 1, maxLength: 200 }),
        (entries) => {
          const store: RecallStore = new Map();
          for (const [k, v] of entries) {
            const beforeSize = store.size;
            const beforeSerialized = serializeRecallStore(store);
            try {
              addRecallStoreEntry(store, k, v);
            } catch {
              // A rejected add must not mutate the store.
              expect(store.size).toBe(beforeSize);
              expect(serializeRecallStore(store)).toBe(beforeSerialized);
            }
            expect(store.size).toBeLessThanOrEqual(MAX_RECALL_STORE_ENTRIES);
            expect(
              Buffer.byteLength(serializeRecallStore(store)),
            ).toBeLessThanOrEqual(MAX_RECALL_STORE_BYTES);
          }
        },
      ),
      NUM_RUNS,
    );
  });

  test("recallAnchorContext fingerprint invariants", () => {
    const msgsArb = fc.array(messageArb(), { minLength: 1, maxLength: 6 });
    const nonEmptyBlocks = fc.array(contentBlockArb(), {
      minLength: 1,
      maxLength: 4,
    });
    const hash = (
      m: GatewayMessage[],
      i?: number,
      p?: GatewayMessage["content"],
    ) => recallAnchorContext(m, i, p);

    fc.assert(
      fc.property(msgsArb, (msgs) => {
        // (a) deterministic
        expect(hash(msgs)).toBe(hash(msgs));
      }),
      NUM_RUNS,
    );

    fc.assert(
      fc.property(
        msgsArb,
        fc.constantFrom("user" as const, "assistant" as const),
        fc.array(contentBlockArb(), { maxLength: 3 }),
        fc.array(contentBlockArb(), { maxLength: 3 }),
        (msgs, role, a, b) => {
          // (b) adjacent same-role messages merge before hashing
          const merged = [
            ...msgs,
            { role, content: [...a, ...b] } as GatewayMessage,
          ];
          const adjacent = [
            ...msgs,
            { role, content: a } as GatewayMessage,
            { role, content: b } as GatewayMessage,
          ];
          expect(hash(adjacent)).toBe(hash(merged));
        },
      ),
      NUM_RUNS,
    );

    fc.assert(
      fc.property(
        msgsArb,
        fc.constantFrom("user" as const, "assistant" as const),
        fc.nat(),
        (msgs, role, pos) => {
          // (c) empty-content messages are ignored entirely
          const withEmpty = [...msgs];
          withEmpty.splice(pos % (msgs.length + 1), 0, {
            role,
            content: [],
          });
          expect(hash(withEmpty)).toBe(hash(msgs));
        },
      ),
      NUM_RUNS,
    );

    fc.assert(
      fc.property(msgsArb, nonEmptyBlocks, (msgs, prefix) => {
        // (d) assistantPrefix equals appending that assistant message
        expect(hash(msgs, msgs.length, prefix)).toBe(
          hash([...msgs, { role: "assistant", content: prefix }]),
        );
      }),
      NUM_RUNS,
    );

    fc.assert(
      fc.property(
        msgsArb,
        nonEmptyBlocks,
        fc.array(contentBlockArb(), { maxLength: 4 }),
        fc.array(contentBlockArb(), { maxLength: 4 }),
        (msgs, prov, c1, c2) => {
          // (e) provenanceContent, not content, is what gets hashed
          const m1 = [
            ...msgs,
            { role: "user" as const, content: c1, provenanceContent: prov },
          ];
          const m2 = [
            ...msgs,
            { role: "user" as const, content: c2, provenanceContent: prov },
          ];
          expect(hash(m1)).toBe(hash(m2));
        },
      ),
      NUM_RUNS,
    );

    fc.assert(
      fc.property(
        msgsArb,
        fc.record({
          type: fc.constant("text" as const),
          text: hostileString().filter((s) => s.length > 0),
        }),
        (rawMsgs, extra) => {
          // (f) appending a non-empty block to the last message changes the
          // hash. Strip provenanceContent first — when present it replaces
          // content in the fingerprint, which is covered by property (e).
          const msgs = rawMsgs.map((m) => {
            const { provenanceContent: _, ...rest } = m;
            return rest;
          });
          const appended = msgs.map((m, i) =>
            i === msgs.length - 1
              ? { ...m, content: [...m.content, extra] }
              : m,
          );
          expect(hash(appended)).not.toBe(hash(msgs));
        },
      ),
      NUM_RUNS,
    );
  });
});
