import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { detectSegments } from "../src/distillation";
import type { TemporalMessage } from "../src/temporal";

/**
 * Property battery for `detectSegments`. A wrong split here silently loses or
 * duplicates conversation history before it reaches the distiller, so the
 * partition invariants are checked over adversarial shapes: bursty timestamps,
 * a single oversized message, many tiny messages, and budgets far below and
 * above the total.
 */

const T = 1_700_000_000_000;

const messagesArb = fc
  .array(
    fc.record({
      tokens: fc.oneof(
        { arbitrary: fc.integer({ min: 1, max: 200 }), weight: 6 },
        { arbitrary: fc.integer({ min: 1_000, max: 40_000 }), weight: 1 },
      ),
      // Gaps: mostly chatty (1s–2min) with occasional multi-hour idle periods,
      // plus zero gaps (identical timestamps) to exercise the median-gap math.
      gap: fc.oneof(
        { arbitrary: fc.constant(0), weight: 1 },
        { arbitrary: fc.integer({ min: 1_000, max: 120_000 }), weight: 6 },
        {
          arbitrary: fc.integer({ min: 3_600_000, max: 36_000_000 }),
          weight: 1,
        },
      ),
    }),
    { minLength: 1, maxLength: 60 },
  )
  .map((rows) => {
    let at = T;
    return rows.map((r, i): TemporalMessage => {
      at += r.gap;
      return {
        id: `m-${i}`,
        project_id: "proj",
        session_id: "sess",
        role: i % 2 === 0 ? "user" : "assistant",
        content: "x".repeat(r.tokens * 3),
        tokens: r.tokens,
        distilled: 0,
        created_at: at,
        metadata: "{}",
      };
    });
  });

const maxTokensArb = fc.oneof(
  fc.integer({ min: 1, max: 100 }),
  fc.integer({ min: 100, max: 5_000 }),
  fc.integer({ min: 16_384, max: 100_000 }),
);

const sum = (seg: TemporalMessage[]) => seg.reduce((s, m) => s + m.tokens, 0);

describe("detectSegments (property)", () => {
  test("segments form an ordered partition of the input — nothing lost, duplicated, or reordered", () => {
    fc.assert(
      fc.property(messagesArb, maxTokensArb, (messages, maxTokens) => {
        const segments = detectSegments(messages, maxTokens);

        expect(segments.length).toBeGreaterThan(0);
        for (const seg of segments) expect(seg.length).toBeGreaterThan(0);

        // Same message objects, same order, exactly once each.
        const flat = segments.flat();
        expect(flat).toHaveLength(messages.length);
        flat.forEach((m, i) => expect(m).toBe(messages[i]));

        expect(segments.length).toBeLessThanOrEqual(messages.length);
      }),
      { numRuns: 500 },
    );
  });

  test("fits-in-budget input is never split; over-budget input is split unless indivisible", () => {
    fc.assert(
      fc.property(messagesArb, maxTokensArb, (messages, maxTokens) => {
        const segments = detectSegments(messages, maxTokens);
        const total = sum(messages);

        if (total <= maxTokens) {
          expect(segments).toHaveLength(1);
          expect(segments[0]).toBe(messages);
          return;
        }

        // Every over-budget segment must be one that could not be split
        // further: either a lone oversized message, or a segment whose
        // over-budget tail is a sub-MIN_SEGMENT_TOKENS remainder that was
        // merged back rather than emitted as a useless tiny segment. In
        // either case the head of the segment must itself have been within
        // budget before absorbing that tail.
        for (const seg of segments) {
          if (sum(seg) <= maxTokens) continue;
          if (seg.length === 1) continue;
          // Find the smallest prefix that is already over budget; the rest is
          // the merged tail. If the prefix is >1 message and the tail is not
          // tiny, the splitter had a legal split it failed to take.
          let cum = 0;
          let firstOver = seg.length;
          for (let i = 0; i < seg.length; i++) {
            cum += seg[i].tokens;
            if (cum > maxTokens) {
              firstOver = i;
              break;
            }
          }
          const head = seg.slice(0, Math.max(1, firstOver));
          const tail = seg.slice(head.length);
          const headOversized = head.length === 1 && head[0].tokens > maxTokens;
          expect(headOversized || sum(tail) < 64).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });

  test("is a pure function of its input", () => {
    fc.assert(
      fc.property(messagesArb, maxTokensArb, (messages, maxTokens) => {
        const a = detectSegments(messages, maxTokens);
        const b = detectSegments(messages, maxTokens);
        expect(a.map((s) => s.map((m) => m.id))).toEqual(
          b.map((s) => s.map((m) => m.id)),
        );
      }),
      { numRuns: 200 },
    );
  });
});
