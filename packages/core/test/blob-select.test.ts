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
  test("splits paragraphs on blank lines", () => {
    const segs = segmentBody("first para\n\nsecond para\n\nthird para");
    expect(segs).toEqual(["first para", "second para", "third para"]);
  });

  test("windows a single giant line (one-line megablob)", () => {
    const giant = "x".repeat(5000);
    const segs = segmentBody(giant, 800);
    // 5000 / 800 = 7 windows (last partial), none exceeding the window size.
    expect(segs.length).toBe(Math.ceil(5000 / 800));
    for (const s of segs) expect(s.length).toBeLessThanOrEqual(800);
  });

  test("splits on the part terminator (tool envelopes)", () => {
    const body = `[tool:read] a.ts\n\x1f[tool:read] b.ts`;
    const segs = segmentBody(body);
    expect(segs.length).toBe(2);
  });

  test("drops empty/whitespace-only paragraphs", () => {
    const segs = segmentBody("real content here\n\n   \n\nmore content");
    expect(segs).toEqual(["real content here", "more content"]);
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
});
