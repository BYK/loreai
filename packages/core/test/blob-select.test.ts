import { describe, test, expect } from "vitest";
import {
  looksLikePasteJunk,
  segmentBody,
  reduceBlob,
} from "../src/blob-select";

// ─── Stage 1: looksLikePasteJunk ───────────────────────────────────────────
//
// 🔴 Invariant: a false POSITIVE (dropping real prose) is unacceptable; a false
// NEGATIVE (keeping junk) only costs a few embeds. Tests below assert 0 false
// positives across many scripts and correct drops on adversarial garbage.

describe("looksLikePasteJunk — keeps real prose (no false positives)", () => {
  const prose: [string, string][] = [
    [
      "english",
      "a failure on claude code. it has happened a couple of times to me. brand new conversation and it says compaction failed?",
    ],
    [
      "turkish-diacritics",
      "Bir de yazı AI ile yazılmış duruyor bazı kısımlar. Başlangıç kısmı uzun. Onlar iyileştirilebilir çünkü asıl argüman güçlü.",
    ],
    [
      "turkish-romanized",
      "Bir de yazi AI ile yazilmis duruyor bazi kisimlar. Baslangic kismi uzun. Onlar iyilestirilebilir.",
    ],
    [
      "cjk",
      "这是一个关于内存管理的讨论。我们需要一个更智能的方法来处理大型输入。也许我们可以使用嵌入来获得更好的信号。这个想法很有趣。",
    ],
    [
      "japanese",
      "これはメモリ管理に関する議論です。単純に切り詰めるのではなく、大きな入力を処理するより賢い方法が必要です。埋め込みを使うといいかもしれません。",
    ],
    [
      "korean",
      "이것은 메모리 관리에 대한 논의입니다. 단순히 잘라내는 대신 큰 입력을 처리하는 더 스마트한 방법이 필요합니다.",
    ],
    [
      "cyrillic",
      "Это обсуждение управления памятью. Нам нужен более разумный способ обработки больших входных данных вместо простого усечения.",
    ],
    [
      "arabic",
      "هذه مناقشة حول إدارة الذاكرة. نحتاج إلى طريقة أكثر ذكاءً لمعالجة المدخلات الكبيرة بدلاً من الاقتطاع البسيط.",
    ],
    [
      "code-ts",
      "export function messagesToText(messages, cap) { return messages.map(m => `[${m.role}] ${m.content}`).join('\\n\\n'); }",
    ],
    [
      "json-config",
      '{ "userBlobMaxChars": 12000, "userBlobKeepChars": 6000, "maxSegments": 48, "enabled": true }',
    ],
  ];
  for (const [name, text] of prose) {
    test(`keeps ${name}`, () => {
      expect(looksLikePasteJunk(text)).toBe(false);
    });
  }
});

describe("looksLikePasteJunk — drops paste junk (including adversarial)", () => {
  const randomBinary = (n: number) => {
    let s = "";
    for (let i = 0; i < n; i++)
      s += String.fromCharCode(Math.floor(Math.random() * 65536));
    return s;
  };
  const cjkNoise = (n: number) => {
    let s = "";
    for (let i = 0; i < n; i++)
      s += String.fromCharCode(0x4e00 + Math.floor(Math.random() * 20000));
    return s;
  };
  const mixed = (n: number) => {
    let s = "";
    for (let i = 0; i < n; i++)
      s +=
        Math.random() < 0.1
          ? String.fromCharCode(0x4e00 + Math.floor(Math.random() * 20000))
          : String.fromCharCode(33 + Math.floor(Math.random() * 94));
    return s;
  };

  const junk: [string, string][] = [
    [
      "base64-png",
      "iVBORw0KGgoAAAANSUhEUgAAB9AAAAO6CAYAAADHGMxWAAbOYklEQVR4Ae3AA6AkWZbG8f937o3IzKdyS2Oubdu2bWmMnpZKr54yMyLu",
    ],
    [
      "repeated-garbage",
      "VVV1111VVXXXXVVVddddVVV1111VVXXUXlqquuuuqqq6666qqrrrrqqquuuuqqq6666qqrrrrqqquuuuqqq66ictVVV1111VVXXXXVVV",
    ],
    [
      "minified",
      '{"a":1,"b":2,"c":[1,2,3,4,5,6,7,8,9],"k":"averylongvaluewithnospaces1234567890abcdefghijklmnopqrstuvwxyz0987"}',
    ],
    ["random-utf16-binary", randomBinary(400)],
    ["random-cjk-noise", cjkNoise(400)],
    ["10pct-cjk-90pct-junk", mixed(400)],
    [
      "base64-with-stray-cyrillic",
      "iVBORw0KGgoAAAANSUhEUgAAB9ЖAAAO6CAYAAADHGMxWAAbOYklEQДVR4Ae3AA6AkWZbG8f937o3IжKdyS2Oubdu2bWmMnpЯr54yMyLu",
    ],
  ];
  for (const [name, text] of junk) {
    test(`drops ${name}`, () => {
      expect(looksLikePasteJunk(text)).toBe(true);
    });
  }
});

test("looksLikePasteJunk keeps short segments (too short to judge)", () => {
  // Below the 40-char judge floor → always kept (safe direction).
  expect(looksLikePasteJunk("VVVXXXddd111")).toBe(false);
});

// ─── segmentBody ───────────────────────────────────────────────────────────

describe("segmentBody", () => {
  test("splits paragraphs on blank lines, carrying offsets", () => {
    const body = "first para\n\nsecond para\n\nthird para";
    const segs = segmentBody(body);
    expect(segs.map((s) => s.text)).toEqual([
      "first para",
      "second para",
      "third para",
    ]);
    // Offsets must point back into the original body verbatim.
    for (const s of segs) expect(body.slice(s.start, s.end)).toBe(s.text);
  });

  test("windows a single giant line (one-line megablob)", () => {
    const giant = "x".repeat(5000);
    const segs = segmentBody(giant, 800);
    // 5000 / 800 = 7 windows (last partial), none exceeding the window size.
    expect(segs.length).toBe(Math.ceil(5000 / 800));
    for (const s of segs) expect(s.text.length).toBeLessThanOrEqual(800);
    // Windows are contiguous and cover the whole body.
    expect(segs.map((s) => s.text).join("")).toBe(giant);
  });

  test("splits an oversized paragraph on line boundaries (keeps lines intact)", () => {
    // A 2000-char paragraph made of short lines must split BETWEEN lines, never
    // mid-line, so a directive on its own line is never cut.
    const lines = Array.from(
      { length: 60 },
      (_, i) => `line ${i} with a good number of real words in it here now`,
    );
    const body = lines.join("\n");
    expect(body.length).toBeGreaterThan(1600); // triggers oversized path
    const segs = segmentBody(body, 800);
    // Every produced segment is a whole line (or run of lines), never a partial.
    for (const s of segs) {
      expect(body.slice(s.start, s.end)).toBe(s.text);
    }
    // Each original line appears verbatim in some segment.
    for (const line of lines) {
      expect(segs.some((s) => s.text.includes(line))).toBe(true);
    }
  });

  test("splits on the part terminator (tool envelopes), offsets accurate", () => {
    const body = `[tool:read] a.ts\n\x1f[tool:read] b.ts`;
    const segs = segmentBody(body);
    expect(segs.length).toBe(2);
    for (const s of segs) expect(body.slice(s.start, s.end)).toBe(s.text);
  });

  test("drops empty/whitespace-only paragraphs", () => {
    const segs = segmentBody("real content here\n\n   \n\nmore content");
    expect(segs.map((s) => s.text)).toEqual([
      "real content here",
      "more content",
    ]);
  });

  test("every segment's offsets slice back to its exact text (tricky paths)", () => {
    // Offset arithmetic is load-bearing for pin overlap detection. Lock it in
    // across the paths that use variable-width separators / windowing.
    const bodies = [
      "para one\n\n\npara two\n\n\n\npara three", // multi-blank-line runs
      "line a\r\nline b\r\n\r\nline c", // CRLF
      "   leading ws para\n\ntrailing ws para   ", // leading/trailing whitespace
      `first tool\n\x1fsecond tool\n\x1fthird tool`, // terminators
      `${"x".repeat(2000)}\n\x1f${"y".repeat(50)}`, // giant line + terminator
      `head para\n\n${"z".repeat(2100)}\n\ntail para`, // oversized middle paragraph
      "a\n\x1f\n\x1fb", // consecutive terminators (empty middle part)
    ];
    for (const body of bodies) {
      for (const seg of segmentBody(body)) {
        expect(body.slice(seg.start, seg.end)).toBe(seg.text);
      }
    }
  });
});

// ─── Stage 2 + integration: reduceBlob ─────────────────────────────────────
//
// Deterministic stubbed embedder: assigns each text a 2-D vector so we control
// exactly which segment scores highest against the query. No ONNX worker needed.

/** Build a stub embed that maps specific substrings to specific unit vectors. */
function stubEmbed(match: string) {
  // query and any segment containing `match` → [1,0]; everything else → [0,1].
  return async (texts: string[]): Promise<Float32Array[]> =>
    texts.map((t) =>
      t.includes(match) ? new Float32Array([1, 0]) : new Float32Array([0, 1]),
    );
}
const dot = (a: Float32Array, b: Float32Array) => a[0] * b[0] + a[1] * b[1];

describe("reduceBlob", () => {
  test("keeps the query-relevant segment, elides low-relevance bulk", async () => {
    const body = [
      "SIGNAL: the compaction failed error is here",
      ...Array.from(
        { length: 20 },
        (_, i) => `irrelevant filler paragraph ${i}`,
      ),
    ].join("\n\n");

    const result = await reduceBlob(body, {
      embed: stubEmbed("SIGNAL"),
      cosine: dot,
      query: "SIGNAL relevance query",
      keepChars: 60,
      maxSegments: 48,
    });

    expect(result.output).toContain("SIGNAL: the compaction failed error");
    expect(result.output).toMatch(/\[… \d+ chars elided \(low-relevance\) …\]/);
    expect(result.kept).toBe(1);
  });

  test("Stage-1 drops paste-junk before embedding (junk never embedded)", async () => {
    const junk = Array.from(
      { length: 30 },
      () =>
        "VVV1111VVXXXXVVVddddVVV1111VVXXUXlqquuuuqqq6666qqrrrrqqquuuuqqq6666qqrrrr",
    ).join("\n\n");
    const body = `SIGNAL real prose about the actual bug we are hunting down today\n\n${junk}`;

    let embedCalls = 0;
    const countingEmbed = async (texts: string[]) => {
      embedCalls += texts.length;
      return texts.map((t) =>
        t.includes("SIGNAL")
          ? new Float32Array([1, 0])
          : new Float32Array([0, 1]),
      );
    };

    const result = await reduceBlob(body, {
      embed: countingEmbed,
      cosine: dot,
      query: "SIGNAL",
      keepChars: 200,
      maxSegments: 48,
    });

    expect(result.junkDropped).toBe(30);
    // Only the 1 prose segment (+ the query) is embedded, not the 30 junk ones.
    expect(result.embedded).toBe(1);
    // embedCalls = 1 (query) + 1 (prose segment) = 2.
    expect(embedCalls).toBe(2);
    expect(result.output).toContain("SIGNAL real prose");
  });

  test("all-junk body: nothing embedded, whole body elided", async () => {
    const junk = Array.from(
      { length: 10 },
      () =>
        "iVBORw0KGgoAAAANSUhEUgAAB9AAAAO6CAYAAADHGMxWAAbOYklEQVR4Ae3AA6AkWZbG8f937o3IzKdyS2Oubdu2bWm",
    ).join("\n\n");
    let embedCalls = 0;
    const result = await reduceBlob(junk, {
      embed: async (texts) => {
        embedCalls += texts.length;
        return texts.map(() => new Float32Array([0, 1]));
      },
      cosine: dot,
      query: "anything",
      keepChars: 200,
      maxSegments: 48,
    });
    expect(embedCalls).toBe(0);
    expect(result.embedded).toBe(0);
    expect(result.kept).toBe(0);
    expect(result.output).toMatch(/^\[… \d+ chars elided/);
  });

  test("caps embedded segments at maxSegments", async () => {
    const body = Array.from(
      { length: 100 },
      (_, i) => `prose paragraph number ${i} with real words in it`,
    ).join("\n\n");
    const result = await reduceBlob(body, {
      embed: async (texts) => texts.map(() => new Float32Array([0, 1])),
      cosine: dot,
      query: "query",
      keepChars: 100000,
      maxSegments: 10,
    });
    expect(result.embedded).toBe(10);
  });

  test("propagates embed rejection (caller handles fail-open)", async () => {
    const body = Array.from(
      { length: 20 },
      (_, i) => `prose paragraph number ${i} with real words`,
    ).join("\n\n");
    await expect(
      reduceBlob(body, {
        embed: async () => {
          throw new Error("provider gone");
        },
        cosine: dot,
        query: "query",
        keepChars: 200,
        maxSegments: 48,
      }),
    ).rejects.toThrow("provider gone");
  });

  test("force-keeps a pinned directive even when it scores lowest", async () => {
    // The directive scores [0,1] (irrelevant to the query) but must survive.
    const directive = "never truncate user signal in distillation";
    const body = [
      `SIGNAL relevant to the query goes here`,
      ...Array.from({ length: 20 }, (_, i) => `filler paragraph ${i}`),
      `IMPORTANT: ${directive} — please remember this`,
    ].join("\n\n");

    const result = await reduceBlob(body, {
      // Only the "SIGNAL" segment scores high; the directive scores low.
      embed: stubEmbed("SIGNAL"),
      cosine: dot,
      query: "SIGNAL relevance query",
      keepChars: 40, // tight budget: without pinning the directive would be elided
      pinnedLines: [directive],
      maxSegments: 48,
    });

    expect(result.output).toContain(directive);
  });

  test("pinned directive survives Stage-1 junk drop", async () => {
    // A directive can be embedded in a segment that Stage-1 classifies as junk
    // (very low trigram variety). Pinning must override the Stage-1 drop.
    const directive = "always use tabs not spaces";
    // Long low-variety tail → trigram ratio well below the junk floor (0.15).
    const junkyWithPin = `${directive} ${"ab".repeat(400)}`;
    // Sanity: confirm this segment IS junk without the pin.
    expect(looksLikePasteJunk(junkyWithPin)).toBe(true);

    const body = [
      junkyWithPin,
      ...Array.from({ length: 5 }, (_, i) => `normal prose paragraph ${i}`),
    ].join("\n\n");

    const result = await reduceBlob(body, {
      embed: async (texts) => texts.map(() => new Float32Array([0, 1])),
      cosine: dot,
      query: "query",
      keepChars: 2000,
      pinnedLines: [directive],
      maxSegments: 48,
    });

    expect(result.output).toContain(directive);
    // Without the pin this segment would have been counted as junk-dropped.
    expect(result.junkDropped).toBe(0);
  });

  test("pinned directive survives a hard window-boundary split (#1343 B1)", async () => {
    // A single unbroken line (no blank lines, no \n) longer than 2×segmentChars
    // is hard-windowed at char boundaries. A directive that straddles a boundary
    // is split across two segments — offset-based pin matching must force-keep
    // BOTH overlapping windows so the directive is never elided.
    const SEG = 800;
    const filler = "log noise ".repeat(74); // ~740 chars, no newlines
    const directive =
      "always redact tokens from these logs before sharing them with anyone";
    // Place the directive so it straddles the 800 boundary, then a long tail.
    const body = filler + directive + " tail " + "x".repeat(3000);
    // Precondition: the directive is genuinely split (present in no single window).
    const rawWindows: string[] = [];
    for (let i = 0; i < body.length; i += SEG)
      rawWindows.push(body.slice(i, i + SEG));
    expect(rawWindows.some((w) => w.includes(directive))).toBe(false);

    const result = await reduceBlob(body, {
      // Everything scores low — only the pin should keep the directive.
      embed: async (texts) => texts.map(() => new Float32Array([0, 1])),
      cosine: dot,
      query: "unrelated query",
      keepChars: 100, // tight: non-pinned tail cannot fill it
      pinnedLines: [directive],
      maxSegments: 48,
    });

    // The full directive survives byte-exact: contiguous hard-window pieces of
    // the same line rejoin with no separator, so a mid-word split is seamless.
    // Strip only the elision markers (which sit between non-contiguous runs).
    const kept = result.output.replace(/\[… \d+ chars elided[^\]]*…\]/gu, "");
    expect(kept).toContain(directive);
  });

  test("caps embedded segments despite duplicate segment text (#1343 S2)", async () => {
    // 100 IDENTICAL prose paragraphs. A Set<string> would collapse them and
    // re-admit all copies; index-based capping must hold the maxSegments limit.
    const body = Array.from(
      { length: 100 },
      () => "the exact same repeated prose paragraph with words",
    ).join("\n\n");
    const result = await reduceBlob(body, {
      embed: async (texts) => texts.map(() => new Float32Array([0, 1])),
      cosine: dot,
      query: "query",
      keepChars: 100000,
      maxSegments: 10,
    });
    expect(result.embedded).toBeLessThanOrEqual(10);
  });

  test("sampleBudget 0 (pins fill the cap) keeps no extra non-pinned (#1343 S3)", async () => {
    const directive = "always keep this exact directive";
    const body = [
      directive,
      ...Array.from({ length: 50 }, (_, i) => `filler paragraph number ${i}`),
    ].join("\n\n");
    const result = await reduceBlob(body, {
      embed: async (texts) => texts.map(() => new Float32Array([0, 1])),
      cosine: dot,
      query: "query",
      keepChars: 100000,
      pinnedLines: [directive],
      maxSegments: 1, // one pin exactly fills the cap → zero non-pinned sampled
    });
    // Only the pinned segment is embedded/kept; non-pinned are not all re-admitted.
    expect(result.embedded).toBe(1);
    expect(result.output).toContain(directive);
  });

  test("keeps a \\n between two adjacent kept paragraphs (no fusion)", async () => {
    // Two distinct paragraphs both score high and are both kept with NO elision
    // run between them. They were separated by a blank line in the body (offsets
    // non-adjacent), so reassembly must restore a "\n" — never fuse them into one
    // run (which would only be correct for contiguous hard-window pieces).
    const body = "SIGNAL alpha paragraph\n\nSIGNAL beta paragraph";
    const result = await reduceBlob(body, {
      embed: stubEmbed("SIGNAL"), // both paragraphs score [1,0]
      cosine: dot,
      query: "SIGNAL",
      keepChars: 10000, // both fit → both kept, no elision between them
      maxSegments: 48,
    });
    expect(result.kept).toBe(2);
    expect(result.output).toBe("SIGNAL alpha paragraph\nSIGNAL beta paragraph");
    expect(result.output).not.toContain("elided");
  });

  test("pinned matching tolerates a display-truncated snippet (trailing …)", async () => {
    const fullLine =
      "the user explicitly said we must always keep the exact migration name intact";
    const body = [
      "some relevant signal here for the query",
      ...Array.from({ length: 15 }, (_, i) => `filler ${i}`),
      fullLine,
    ].join("\n\n");
    // Caller passes a 40-char-capped snippet with a trailing ellipsis.
    const truncatedPin = `${fullLine.slice(0, 40)}…`;

    const result = await reduceBlob(body, {
      embed: stubEmbed("signal"),
      cosine: dot,
      query: "signal query",
      keepChars: 40,
      pinnedLines: [truncatedPin],
      maxSegments: 48,
    });

    expect(result.output).toContain(fullLine);
  });

  test("headChars: leading prose prefix is kept even at zero relevance", async () => {
    // The user's own words (instruction + a casual aside stating facts) lead the
    // message; a large low-relevance blob follows. The aside scores 0 against the
    // coding query, so ONLY head preservation can keep it. #1343 follow-up.
    const aside =
      "Starting the orderkit project. (Aside, nothing to act on: our orders " +
      "ride the WHOLESALE channel out of the EMEA region, ship from WH-07, and " +
      "we keep status values like SUBMITTED uppercase.) Just the stock_level fn.";
    const blob = Array.from(
      { length: 60 },
      (_, i) => `irrelevant reference spec paragraph number ${i} with filler`,
    ).join("\n\n");
    const body = `${aside}\n\n${blob}`;

    const result = await reduceBlob(body, {
      // Nothing matches "SIGNAL" → every segment (incl. the aside) scores 0.
      embed: stubEmbed("SIGNAL"),
      cosine: dot,
      query: "SIGNAL unrelated coding objective",
      keepChars: 40, // tiny: relevance budget cannot rescue the aside
      maxSegments: 48,
      headChars: 400,
    });

    for (const fact of ["WHOLESALE", "EMEA", "WH-07", "SUBMITTED"]) {
      expect(result.output).toContain(fact);
    }
  });

  test("headChars=0 disables head preservation (aside is elided at zero relevance)", async () => {
    // Mutation guard: with head preservation off, the same zero-relevance aside
    // is dropped — proving the test above is non-vacuous.
    const aside =
      "Starting the orderkit project. (Aside: WHOLESALE channel, EMEA region, " +
      "WH-07 warehouse, SUBMITTED uppercase status.) Just the stock_level fn.";
    const blob = Array.from(
      { length: 60 },
      (_, i) => `irrelevant reference spec paragraph number ${i} with filler`,
    ).join("\n\n");
    const body = `${aside}\n\n${blob}`;

    const result = await reduceBlob(body, {
      embed: stubEmbed("SIGNAL"),
      cosine: dot,
      query: "SIGNAL unrelated coding objective",
      keepChars: 40,
      maxSegments: 48,
      headChars: 0,
    });

    expect(result.output).not.toContain("WHOLESALE");
  });

  test("headChars: head segments are clamped to maxSegments/2 (cost bound holds)", async () => {
    // A large headChars must NOT let the head force-embed the whole body — that
    // would reintroduce the #1343 unbounded-embed cost. The head is clamped to
    // maxSegments/2 so at least half the embed budget stays for body sampling.
    // Build a body that is ALL prose (no paste-junk boundary) so nothing stops
    // the head walk except the clamp.
    const paras = Array.from(
      { length: 40 },
      (_, i) =>
        `genuine prose paragraph number ${i} with enough words to be a real segment here`,
    );
    const body = paras.join("\n\n");

    const result = await reduceBlob(body, {
      embed: stubEmbed("SIGNAL"),
      cosine: dot,
      query: "SIGNAL unrelated",
      keepChars: 200,
      maxSegments: 10, // clamp head to floor(10/2) = 5
      headChars: 1_000_000, // absurdly large: only the segment clamp can bound it
    });

    // embedded is capped at maxSegments; head cannot exceed maxSegments/2, so the
    // total embed count never blows past the configured cap.
    expect(result.embedded).toBeLessThanOrEqual(10);
  });

  test("headChars: head walk stops at the first paste-junk segment", async () => {
    // The head prefix ends where the pasted blob begins. A junk segment after the
    // prose head must terminate the head walk (blob started), so junk is never
    // force-kept as "head".
    const prose = "Real instruction prose at the very top of the message here.";
    const junk = "aGVsbG8=".repeat(400); // base64-like paste junk, one big segment
    const body = `${prose}\n\n${junk}`;

    const result = await reduceBlob(body, {
      embed: stubEmbed("SIGNAL"),
      cosine: dot,
      query: "SIGNAL unrelated",
      keepChars: 40,
      maxSegments: 48,
      headChars: 1_000_000, // huge — only the junk boundary stops the head walk
    });

    // The prose head is kept; the junk is NOT force-kept as head (it's elided).
    expect(result.output).toContain("Real instruction prose");
    expect(result.output).not.toContain(junk);
  });
});
