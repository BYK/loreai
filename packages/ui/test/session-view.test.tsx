/**
 * `SessionView` in jsdom: deep-link resolution states, selection panel with
 * live copy + disabled discussion actions, older-history loading (incl. the
 * deep-link search through older pages), and keyboard focus/selection.
 *
 * jsdom has no layout, so the viewport (`offsetHeight`) and row rects are
 * stubbed to fixed sizes; that is enough to mount a window of rows and
 * exercise every state transition without measuring real pixels.
 */
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { FUTURE_ACTIONS } from "~/components/lore/FutureAction";
import {
  SEARCH_DEBOUNCE_MS,
  SessionView,
} from "~/components/reader/SessionView";
import type { SessionSearchPage, TemporalMessage } from "~/contracts";
import { anchorFor, blockAnchor, encodeAnchor } from "~/reader/anchors";
import { buildBlocks, messageBlock } from "~/reader/blocks";
import { buildRows } from "~/reader/rows";
import { queryMatcher, searchRows } from "~/reader/search";
import { NATIVE_TRANSCRIPT_LABEL } from "~/reader/coverage";
import { HIGHLIGHT_ATTR } from "~/reader/selection";
import { WHOLE_LOAD_PAGES } from "~/reader/whole-search";
import {
  READER_SPECIMEN,
  READER_SPECIMEN_DISTILLATION,
} from "~/reader/specimen";

const SPECIMEN = READER_SPECIMEN.messages;

/** Give the virtualiser a viewport (800px) and every row a height (120px). */
const LAYOUT_PROPS = [
  "offsetHeight",
  "clientHeight",
  "scrollHeight",
  "getBoundingClientRect",
  "scrollTo",
] as const;
const realLayout = LAYOUT_PROPS.map(
  (name): [(typeof LAYOUT_PROPS)[number], PropertyDescriptor | undefined] => [
    name,
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, name) ??
      Object.getOwnPropertyDescriptor(Element.prototype, name),
  ],
);
const sizeOf = (el: HTMLElement) =>
  el.dataset.testid === "session-scroll" ? 800 : 120;
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return sizeOf(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return sizeOf(this);
    },
  });
  // The scroll container can always scroll further: the virtualiser clamps
  // `scrollToIndex` to `scrollHeight - clientHeight`, which jsdom reports as 0.
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.testid === "session-scroll" ? 1e7 : sizeOf(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement): DOMRect {
      const height = sizeOf(this);
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 800,
        bottom: height,
        width: 800,
        height,
        toJSON: () => ({}),
      };
    },
  });
  // jsdom has no `scrollTo`; the virtualiser uses it to jump to a row and
  // listens for the resulting scroll event to move its window.
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value(this: HTMLElement, options?: ScrollToOptions | number) {
      const top = typeof options === "number" ? options : options?.top;
      if (typeof top !== "number") return;
      this.scrollTop = top;
      this.dispatchEvent(new Event("scroll"));
    },
  });
});
afterAll(() => {
  for (const [name, descriptor] of realLayout) {
    if (descriptor) {
      Object.defineProperty(HTMLElement.prototype, name, descriptor);
    } else {
      delete HTMLElement.prototype[name];
    }
  }
});

function older(n: number): TemporalMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `old-${i}`,
    source_id: null,
    project_id: "specimen",
    session_id: "specimen",
    role: "user",
    content: `older message ${i}`,
    tokens: 1,
    distilled: 0,
    created_at: 1_600_000_000_000 + i,
    metadata: "{}",
  }));
}

async function tick(n = 3) {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

function mount(over: Partial<Parameters<typeof SessionView>[0]> = {}) {
  const [anchor, setAnchor] = createSignal<string | null>(
    over.anchorParam ?? null,
  );
  const changes: Array<string | null> = [];
  const clipboard: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: (t: string) => {
        clipboard.push(t);
        return Promise.resolve();
      },
    },
  });
  const utils = render(() => (
    <SessionView
      sessionId="specimen"
      messages={over.messages ?? SPECIMEN}
      distillations={over.distillations ?? READER_SPECIMEN.distillations}
      messageCount={over.messageCount ?? SPECIMEN.length}
      hasOlder={over.hasOlder ?? false}
      linkBase={() => "http://gw.local/ui/projects/p/sessions/specimen"}
      anchorParam={anchor()}
      onAnchorChange={(a) => {
        changes.push(a);
        setAnchor(a);
      }}
      {...over}
    />
  ));
  return { ...utils, changes, clipboard, setAnchor, anchor };
}

describe("SessionView: deep links", () => {
  it("highlights the linked passage, opens the panel and shows no warning", async () => {
    const block = messageBlock(SPECIMEN[2]!); // "Should we replace the SQLite…"
    const part = block.parts[0]!;
    const start = part.text.indexOf("Portability");
    const anchor = anchorFor(block, part, start, start + 11);
    const { changes } = mount({ anchorParam: encodeAnchor(anchor) });
    await tick();
    const marks = document.querySelectorAll(`[${HIGHLIGHT_ATTR}]`);
    expect(Array.from(marks, (m) => m.textContent).join("")).toBe(
      "Portability",
    );
    expect(screen.getByTestId("selection-panel")).toBeInTheDocument();
    expect(screen.getByTestId("selection-quote")).toHaveTextContent(
      "Portability",
    );
    expect(screen.queryByTestId("link-state")).toBeNull();
    // Resolving a link never rewrites the URL.
    expect(changes).toEqual([]);
  });

  it("shows an honest 'source changed' state on a content-hash mismatch and highlights nothing", async () => {
    const block = messageBlock(SPECIMEN[2]!);
    const part = block.parts[0]!;
    const stale = {
      ...anchorFor(block, part, 0, 6),
      contentHash: "deadbeef",
    };
    mount({ anchorParam: encodeAnchor(stale) });
    await tick();
    const banner = screen.getByTestId("link-state");
    expect(banner).toHaveAttribute("data-tone", "warn");
    expect(banner).toHaveTextContent(/source changed/i);
    expect(document.querySelectorAll(`[${HIGHLIGHT_ATTR}]`).length).toBe(0);
    expect(screen.queryByTestId("selection-quote")).toBeNull();
  });

  it("says a span no longer exists when the range overruns the text", async () => {
    const block = messageBlock(SPECIMEN[2]!);
    const part = block.parts[0]!;
    mount({
      anchorParam: encodeAnchor({
        ...anchorFor(block, part, 0, 1),
        end: part.text.length + 50,
      }),
    });
    await tick();
    expect(screen.getByTestId("link-state")).toHaveTextContent(
      /no longer exists/i,
    );
  });

  it("reports a malformed anchor instead of ignoring it", async () => {
    mount({ anchorParam: "not-an-anchor" });
    await tick();
    expect(screen.getByTestId("link-state")).toHaveTextContent(
      /not understood/i,
    );
  });

  it("searches older pages for a missing block and reports honestly when it is not there", async () => {
    const missing = {
      ...blockAnchor(messageBlock(SPECIMEN[0]!)),
      blockId: "m.nowhere",
    };
    const [msgs, setMsgs] = createSignal(SPECIMEN);
    const [hasOlder, setHasOlder] = createSignal<boolean | null>(true);
    const [loading, setLoading] = createSignal(false);
    let loads = 0;
    const onLoadOlder = async () => {
      loads++;
      setLoading(true);
      await tick(1);
      setMsgs((prev) => [...older(2), ...prev]);
      setHasOlder(loads < 2);
      setLoading(false);
    };
    mount({
      anchorParam: encodeAnchor(missing),
      get messages() {
        return msgs();
      },
      get hasOlder() {
        return hasOlder();
      },
      get loadingOlder() {
        return loading();
      },
      onLoadOlder,
    });
    // Synchronously after mount the first older page is already requested.
    expect(screen.getByTestId("link-state")).toHaveTextContent(/looking/i);
    expect(loads).toBe(1);
    await tick(10);
    expect(loads).toBe(2);
    expect(hasOlder()).toBe(false);
    expect(screen.getByTestId("link-state")).toHaveTextContent(
      /not in this session's captured history/i,
    );
    expect(screen.getByTestId("history-start")).toBeInTheDocument();
  });

  it("finds a deep-linked block that arrives with an older page", async () => {
    const target = older(1)[0]!;
    const anchor = blockAnchor(messageBlock(target));
    const [msgs, setMsgs] = createSignal(SPECIMEN);
    const [hasOlder, setHasOlder] = createSignal<boolean | null>(true);
    const onLoadOlder = async () => {
      await tick(1);
      setMsgs((prev) => [target, ...prev]);
      setHasOlder(false);
    };
    mount({
      anchorParam: encodeAnchor(anchor),
      get messages() {
        return msgs();
      },
      get hasOlder() {
        return hasOlder();
      },
      onLoadOlder,
    });
    await tick(10);
    expect(screen.queryByTestId("link-state")).toBeNull();
    expect(screen.getByTestId("selection-panel")).toHaveTextContent(
      /whole message/,
    );
    expect(screen.getByTestId("selection-quote")).toHaveTextContent(
      "older message 0",
    );
  });

  it("resumes the older-history search when a narrower server page replaces the window holding the linked block", async () => {
    // Cached-first: the cache offers the whole history (target included), the
    // server's first page then replaces it with the newest messages only.
    const target = older(1)[0]!;
    const anchor = blockAnchor(messageBlock(target));
    const [msgs, setMsgs] = createSignal([target, ...SPECIMEN]);
    const [hasOlder, setHasOlder] = createSignal<boolean | null>(false);
    let loads = 0;
    const onLoadOlder = async () => {
      loads++;
      await tick(1);
      setMsgs((prev) => [target, ...prev]);
      setHasOlder(false);
    };
    mount({
      anchorParam: encodeAnchor(anchor),
      get messages() {
        return msgs();
      },
      get hasOlder() {
        return hasOlder();
      },
      onLoadOlder,
    });
    await tick();
    expect(screen.getByTestId("selection-quote")).toHaveTextContent(
      "older message 0",
    );

    setHasOlder(true);
    setMsgs(SPECIMEN);
    // Not a dead end: the search is back on and paging, not "not found".
    expect(screen.getByTestId("link-state")).toHaveTextContent(/looking/i);
    expect(screen.queryByTestId("selection-panel")).toBeNull();
    await tick(10);
    expect(loads).toBe(1);
    expect(screen.queryByTestId("link-state")).toBeNull();
    expect(screen.getByTestId("selection-quote")).toHaveTextContent(
      "older message 0",
    );
  });

  it("still reports 'not found' when the linked block leaves the window and older history has none of it", async () => {
    const target = older(1)[0]!;
    const anchor = blockAnchor(messageBlock(target));
    const [msgs, setMsgs] = createSignal([target, ...SPECIMEN]);
    mount({
      anchorParam: encodeAnchor(anchor),
      get messages() {
        return msgs();
      },
      hasOlder: false,
    });
    await tick();
    expect(screen.getByTestId("selection-panel")).toBeInTheDocument();
    setMsgs(SPECIMEN);
    await tick();
    expect(screen.queryByTestId("selection-panel")).toBeNull();
    expect(screen.getByTestId("link-state")).toHaveTextContent(
      /not in this session's captured history/i,
    );
  });

  it("drops a live selection and reports the change when the selected block is edited underneath it", async () => {
    const block = messageBlock(SPECIMEN[2]!);
    const part = block.parts[0]!;
    const start = part.text.indexOf("Portability");
    const anchor = anchorFor(block, part, start, start + 11);
    const [msgs, setMsgs] = createSignal(SPECIMEN);
    const { changes } = mount({
      anchorParam: encodeAnchor(anchor),
      get messages() {
        return msgs();
      },
    });
    await tick();
    expect(screen.getByTestId("selection-quote")).toHaveTextContent(
      "Portability",
    );

    // An unrelated block changes: the selection is untouched.
    setMsgs((prev) =>
      prev.map((m, i) =>
        i === 0 ? { ...m, content: `${m.content}\n\nappended` } : m,
      ),
    );
    await tick();
    expect(screen.getByTestId("selection-quote")).toHaveTextContent(
      "Portability",
    );
    expect(screen.queryByTestId("link-state")).toBeNull();

    // The selected block itself changes: honest state, no highlight, and
    // the URL is not rewritten to a similar passage.
    setMsgs((prev) =>
      prev.map((m, i) =>
        i === 2 ? { ...m, content: `${m.content}\n\nedited later` } : m,
      ),
    );
    await tick();
    const banner = screen.getByTestId("link-state");
    expect(banner).toHaveAttribute("data-tone", "warn");
    expect(banner).toHaveTextContent(/source changed/i);
    expect(document.querySelectorAll(`[${HIGHLIGHT_ATTR}]`).length).toBe(0);
    expect(screen.queryByTestId("selection-quote")).toBeNull();
    expect(changes).toEqual([]);
  });
});

describe("SessionView: selection panel", () => {
  it("selecting a passage publishes the anchor, copies with source, and shows disabled actions", async () => {
    const { changes, clipboard } = mount();
    await tick();
    const rich = document.querySelector<HTMLElement>(
      '[data-block="m.spec-u1"][data-part="0"]',
    )!;
    const textNode = rich.firstChild!.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 9); // "Should we"
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    fireEvent.pointerUp(screen.getByTestId("session-scroll"));
    await tick();

    expect(screen.getByTestId("selection-quote")).toHaveTextContent(
      "Should we",
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toContain("m.spec-u1");
    for (const label of FUTURE_ACTIONS) {
      const button = screen.getByRole("button", { name: new RegExp(label) });
      expect(button).toBeDisabled();
    }

    fireEvent.click(screen.getByTestId("copy-with-source"));
    await tick();
    expect(clipboard).toHaveLength(1);
    expect(clipboard[0]).toContain('"Should we"');
    const copiedLink = clipboard[0]!.split("\n").at(-1)!;
    expect(new URL(copiedLink).searchParams.get("a")).toBe(changes[0]);
    // The copied link also carries the quote as a standard text fragment.
    expect(new URL(copiedLink).hash).toBe("#:~:text=Should%20we");
    expect(clipboard[0]).toContain("session specimen");
    expect(screen.getByTestId("copy-with-source")).toHaveTextContent("Copied");

    fireEvent.click(screen.getByTestId("copy-link"));
    await tick();
    expect(clipboard[1]).toBe(copiedLink);
    expect(
      copiedLink.startsWith(
        "http://gw.local/ui/projects/p/sessions/specimen?a=",
      ),
    ).toBe(true);

    fireEvent.click(screen.getByTestId("selection-clear"));
    await tick();
    expect(screen.queryByTestId("selection-panel")).toBeNull();
    expect(changes.at(-1)).toBeNull();
  });

  it("tells the reader when a selection spans two passages", async () => {
    mount();
    await tick();
    const a = document.querySelector<HTMLElement>(
      '[data-block="m.spec-u1"][data-part="0"]',
    )!;
    const b = document.querySelector<HTMLElement>(
      '[data-block="m.spec-sys"][data-part="0"]',
    )!;
    const range = document.createRange();
    range.setStart(b.firstChild!.firstChild!, 1);
    range.setEnd(a.firstChild!.firstChild!, 3);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    fireEvent.pointerUp(screen.getByTestId("session-scroll"));
    await tick();
    expect(screen.getByTestId("selection-hint")).toHaveTextContent(
      /single passage/i,
    );
    expect(screen.queryByTestId("selection-panel")).toBeNull();
  });

  it("reports a failed copy instead of pretending", async () => {
    mount();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("denied")) },
    });
    await tick();
    const row = document.querySelector<HTMLElement>(
      '[data-row-key="m.spec-u1"]',
    )!;
    fireEvent.keyDown(row, { key: "Enter" });
    await tick();
    fireEvent.click(screen.getByTestId("copy-with-source"));
    await tick();
    expect(screen.getByRole("alert")).toHaveTextContent(/denied/);
  });
});

describe("SessionView: history and keyboard", () => {
  it("shows the coverage line, load-older control and prepends older rows", async () => {
    const [msgs, setMsgs] = createSignal(SPECIMEN);
    const [hasOlder, setHasOlder] = createSignal<boolean | null>(true);
    const onLoadOlder = vi.fn(async () => {
      setMsgs((prev) => [...older(3), ...prev]);
      setHasOlder(false);
    });
    mount({
      get messages() {
        return msgs();
      },
      get hasOlder() {
        return hasOlder();
      },
      messageCount: SPECIMEN.length + 3,
      onLoadOlder,
    });
    await tick();
    expect(screen.getByTestId("reader-coverage-line")).toHaveTextContent(
      `${SPECIMEN.length} of ${SPECIMEN.length + 3} captured messages loaded`,
    );
    fireEvent.click(screen.getByTestId("load-older"));
    await tick();
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("load-older")).toBeNull();
    expect(screen.getByTestId("history-start")).toBeInTheDocument();
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>("[data-row-key]"),
      (r) => r.dataset.rowKey,
    );
    expect(rows.slice(0, 3)).toEqual(["m.old-0", "m.old-1", "m.old-2"]);
    expect(
      document
        .querySelector('[data-row-key="m.old-0"]')
        ?.getAttribute("aria-posinset"),
    ).toBe("1");
  });

  it("never claims completeness it does not know", async () => {
    mount({ messageCount: null, hasOlder: null });
    await tick();
    expect(screen.getByTestId("reader-coverage-line")).toHaveTextContent(
      `${SPECIMEN.length} messages loaded`,
    );
    expect(screen.queryByTestId("history-start")).toBeNull();
    expect(screen.queryByTestId("load-older")).toBeNull();
  });

  it("moves focus between rows with the arrow keys and selects a block with Enter", async () => {
    const { changes } = mount();
    await tick();
    const first = document.querySelector<HTMLElement>(
      '[data-row-key="m.spec-sys"]',
    )!;
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    await tick();
    expect(document.activeElement?.getAttribute("data-row-key")).toBe(
      "m.spec-lore",
    );
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    await tick();
    expect(screen.getByTestId("selection-panel")).toHaveTextContent(
      /whole message/,
    );
    expect(changes).toHaveLength(1);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await tick();
    expect(screen.queryByTestId("selection-panel")).toBeNull();
  });

  it("renders distillations as labelled compressed context, loading detail on open", async () => {
    const loadDistillation = vi.fn(async (id: string) => ({
      ...READER_SPECIMEN.distillations[0]!,
      id,
      project_id: "specimen",
      observations: READER_SPECIMEN_DISTILLATION,
      source_ids: "[]",
    }));
    mount({ loadDistillation });
    await tick();
    const row = document.querySelector<HTMLElement>(
      '[data-row-key="d.spec-d0"]',
    )!;
    expect(row).toHaveTextContent(/compressed context/i);
    expect(row).toHaveTextContent(/not what anyone said/i);
    const details = row.querySelector("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    await tick();
    expect(loadDistillation).toHaveBeenCalledWith("spec-d0");
    expect(row).toHaveTextContent(READER_SPECIMEN_DISTILLATION.slice(0, 30));
  });
});

/** Wait past the search debounce and any slice yields. */
async function settleSearch() {
  await new Promise((r) => setTimeout(r, SEARCH_DEBOUNCE_MS + 40));
  await tick(6);
}

describe("SessionView: coverage badges", () => {
  it("declares captured history only for a complete, known total and always names the native transcript gap", async () => {
    mount();
    await tick();
    const coverage = screen.getByTestId("reader-coverage");
    expect(coverage.dataset.coverage).toBe("captured");
    expect(coverage).toHaveTextContent("Captured history");
    expect(screen.getByTestId("native-transcript")).toHaveTextContent(
      NATIVE_TRANSCRIPT_LABEL,
    );
  });

  it("stays partial for a cached window even when the count matches", async () => {
    mount({
      status: {
        loading: false,
        partial: true,
        stale: false,
        error: undefined,
        source: "cache",
      },
    });
    await tick();
    const coverage = screen.getByTestId("reader-coverage");
    expect(coverage.dataset.coverage).toBe("partial");
    expect(coverage.dataset.coverageReason).toBe("cached-window");
    expect(coverage).toHaveTextContent("Partial history");
    expect(screen.getByTestId("reader-coverage-line")).toHaveTextContent(
      "from the cached window",
    );
  });

  it("is partial with an unknown total even with no older page reported", async () => {
    mount({ messageCount: null, hasOlder: false });
    await tick();
    expect(screen.getByTestId("reader-coverage").dataset.coverage).toBe(
      "partial",
    );
    expect(screen.getByTestId("reader-coverage-line")).toHaveTextContent(
      "completeness unknown",
    );
  });
});

describe("SessionView: in-session search", () => {
  /** 60 rows of 120px in an 800px viewport: most are never mounted. */
  function longHistory(): TemporalMessage[] {
    return older(60).map((m, i) => ({
      ...m,
      content:
        i === 3 || i === 47 || i === 58
          ? `row ${i} carries the needle for search`
          : `row ${i} says nothing of interest`,
    }));
  }

  it("finds hits in unmounted rows, steps through them and highlights only the current one", async () => {
    const messages = longHistory();
    mount({ messages, messageCount: messages.length });
    await tick();
    const mounted = () =>
      Array.from(
        document.querySelectorAll<HTMLElement>("[data-row-key]"),
        (r) => r.dataset.rowKey,
      );
    expect(mounted()).not.toContain("m.old-47");
    expect(mounted().length).toBeLessThan(messages.length);

    const input = screen.getByTestId<HTMLInputElement>("search-input");
    fireEvent.input(input, { target: { value: "needle" } });
    expect(screen.queryByTestId("search-summary")).toBeNull(); // debounced
    await settleSearch();
    expect(screen.getByTestId("search-summary")).toHaveTextContent(
      "3 matches in loaded history",
    );
    expect(screen.queryByTestId("search-coverage")).toBeNull();

    fireEvent.click(screen.getByTestId("search-next"));
    await tick();
    expect(screen.getByTestId("search-summary")).toHaveTextContent(
      "1 of 3 in loaded history",
    );
    let marks = document.querySelectorAll<HTMLElement>(`mark.passage-search`);
    expect(marks).toHaveLength(1);
    expect(marks[0]!.textContent).toBe("needle");
    expect(
      marks[0]!.closest("[data-row-key]")?.getAttribute("data-row-key"),
    ).toBe("m.old-3");

    fireEvent.click(screen.getByTestId("search-next"));
    await tick();
    expect(screen.getByTestId("search-summary")).toHaveTextContent("2 of 3");
    marks = document.querySelectorAll<HTMLElement>(`mark.passage-search`);
    expect(marks).toHaveLength(1);
    expect(
      marks[0]!.closest("[data-row-key]")?.getAttribute("data-row-key"),
    ).toBe("m.old-47");
    expect(mounted()).toContain("m.old-47");

    // Previous wraps from the first hit to the last.
    fireEvent.click(screen.getByTestId("search-prev"));
    fireEvent.click(screen.getByTestId("search-prev"));
    await tick();
    expect(screen.getByTestId("search-summary")).toHaveTextContent("3 of 3");
    expect(
      document
        .querySelector("mark.passage-search")
        ?.closest("[data-row-key]")
        ?.getAttribute("data-row-key"),
    ).toBe("m.old-58");

    fireEvent.click(screen.getByTestId("search-clear"));
    await tick();
    expect(input.value).toBe("");
    expect(screen.queryByTestId("search-summary")).toBeNull();
    expect(document.querySelectorAll("mark.passage-search")).toHaveLength(0);
  });

  it("ignores one-character queries and reports no matches honestly", async () => {
    mount();
    await tick();
    const input = screen.getByTestId<HTMLInputElement>("search-input");
    fireEvent.input(input, { target: { value: "x" } });
    await settleSearch();
    expect(screen.queryByTestId("search-summary")).toBeNull();
    fireEvent.input(input, { target: { value: "zzqx-not-there" } });
    await settleSearch();
    expect(screen.getByTestId("search-summary")).toHaveTextContent(
      "No matches in loaded history",
    );
    expect(screen.getByTestId("search-next")).toBeDisabled();
    expect(screen.getByTestId("search-select")).toBeDisabled();
  });

  it("turns the current hit into a source anchor and keeps the selection independent of the search", async () => {
    const { changes, anchor } = mount();
    await tick();
    const input = screen.getByTestId<HTMLInputElement>("search-input");
    fireEvent.input(input, { target: { value: "Portability" } });
    await settleSearch();
    expect(screen.getByTestId("search-select")).toBeDisabled();
    fireEvent.click(screen.getByTestId("search-next"));
    await tick();
    fireEvent.click(screen.getByTestId("search-select"));
    await tick();
    expect(screen.getByTestId("selection-panel")).toBeInTheDocument();
    expect(screen.getByTestId("selection-quote")).toHaveTextContent(
      /portability/i,
    );
    expect(changes).toHaveLength(1);
    // The anchor is the first logical hit, derived from block data.
    const blocks = buildBlocks({
      messages: SPECIMEN,
      distillations: READER_SPECIMEN.distillations,
    });
    const first = searchRows(buildRows(blocks), queryMatcher("Portability")!)
      .hits[0]!;
    const block = blocks.byId.get(first.blockId)!;
    expect(block.kind).toBe("message");
    if (block.kind !== "message") return;
    expect(anchor()).toBe(
      encodeAnchor(
        anchorFor(block, block.parts[first.partIndex]!, first.start, first.end),
      ),
    );
    // Both marks coexist on the same part: the passage and the search hit.
    expect(document.querySelectorAll("mark.passage-target")).toHaveLength(1);
    expect(document.querySelectorAll("mark.passage-search")).toHaveLength(1);

    // Moving the search on does not move the selection…
    fireEvent.input(input, { target: { value: "SQLite" } });
    await settleSearch();
    fireEvent.click(screen.getByTestId("search-next"));
    await tick();
    expect(anchor()).toBe(changes[0]);
    expect(screen.getByTestId("selection-quote")).toHaveTextContent(
      /portability/i,
    );
    expect(
      Array.from(
        document.querySelectorAll("mark.passage-target"),
        (m) => m.textContent,
      ).join(""),
    ).toMatch(/^portability$/i);
    // …and clearing the search leaves the selected passage highlighted.
    fireEvent.click(screen.getByTestId("search-clear"));
    await tick();
    expect(document.querySelectorAll("mark.passage-search")).toHaveLength(0);
    expect(
      Array.from(
        document.querySelectorAll("mark.passage-target"),
        (m) => m.textContent,
      ).join(""),
    ).toMatch(/^portability$/i);
    expect(screen.getByTestId("selection-panel")).toBeInTheDocument();
  });

  it("scrolls to the search hit's own mark, not to a selection on the same block", async () => {
    const block = messageBlock(SPECIMEN[2]!); // "Should we replace the SQLite…"
    const part = block.parts[0]!;
    const start = part.text.indexOf("Portability");
    // jsdom has no scrollIntoView; record which element the reader targets.
    const scrolled: HTMLElement[] = [];
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value(this: HTMLElement) {
        scrolled.push(this);
      },
    });
    try {
      mount({
        anchorParam: encodeAnchor(anchorFor(block, part, start, start + 11)),
      });
      await tick();
      expect(document.querySelector("mark.passage-target")?.textContent).toBe(
        "Portability",
      );
      scrolled.length = 0;

      fireEvent.input(screen.getByTestId("search-input"), {
        target: { value: "SQLite" },
      });
      await settleSearch();
      // Step until the hit lands on the selected block.
      for (let i = 0; i < 10; i++) {
        fireEvent.click(screen.getByTestId("search-next"));
        await tick();
        const mark = document.querySelector<HTMLElement>("mark.passage-search");
        if (
          mark?.closest("[data-block]")?.getAttribute("data-block") === block.id
        )
          break;
      }
      const hitMark = document.querySelector<HTMLElement>(
        "mark.passage-search",
      );
      expect(hitMark?.closest("[data-block]")?.getAttribute("data-block")).toBe(
        block.id,
      );
      // Both marks are on this block; only the search hit's mark was scrolled to.
      expect(document.querySelector("mark.passage-target")?.textContent).toBe(
        "Portability",
      );
      const last = scrolled.at(-1);
      expect(last?.classList.contains("passage-search")).toBe(true);
      expect(last?.textContent).toBe("SQLite");
      expect(
        scrolled.some((el) => el.classList.contains("passage-target")),
      ).toBe(false);
    } finally {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown })
        .scrollIntoView;
    }
  });

  it("says when only the loaded part of a longer history was searched and re-scans after older rows arrive", async () => {
    const [msgs, setMsgs] = createSignal(SPECIMEN);
    const [hasOlder, setHasOlder] = createSignal<boolean | null>(true);
    mount({
      get messages() {
        return msgs();
      },
      get hasOlder() {
        return hasOlder();
      },
      messageCount: SPECIMEN.length + 2,
      onLoadOlder: async () => {
        setMsgs((prev) => [
          ...older(2).map((m) => ({
            ...m,
            content: `${m.content} Portability first`,
          })),
          ...prev,
        ]);
        setHasOlder(false);
      },
    });
    await tick();
    const input = screen.getByTestId<HTMLInputElement>("search-input");
    fireEvent.input(input, { target: { value: "Portability" } });
    await settleSearch();
    const before = screen.getByTestId("search-summary").textContent;
    expect(screen.getByTestId("search-coverage")).toHaveTextContent(
      "Searched the loaded history only",
    );
    fireEvent.click(screen.getByTestId("load-older"));
    await settleSearch();
    expect(screen.queryByTestId("search-coverage")).toBeNull();
    const after = screen.getByTestId("search-summary").textContent ?? "";
    expect(after).not.toBe(before);
    expect(Number.parseInt(after, 10)).toBe(
      Number.parseInt(before ?? "0", 10) + 2,
    );
  });

  it("skips distillations: compressed context is never a search hit", async () => {
    mount();
    await tick();
    // The distillation row is mounted and says "Compressed context" on screen…
    expect(
      document.querySelector('[data-row-key="d.spec-d0"]'),
    ).toHaveTextContent("Compressed context");
    // …but search reads the logical session speech, not the compressed row.
    fireEvent.input(screen.getByTestId("search-input"), {
      target: { value: "Compressed context" },
    });
    await settleSearch();
    expect(screen.getByTestId("search-summary")).toHaveTextContent(
      "No matches in loaded history",
    );
  });
});

describe("SessionView: whole-session search", () => {
  /**
   * A 3-page history: the loaded window holds `old-20..old-59`; each
   * `onLoadOlder` prepends 20 more. Message `old-3` is the only one with the
   * needle, so the loaded-window scan finds nothing until two pages arrive.
   */
  function pagedHistory(needleContent = "the portability needle sits here") {
    const all = older(60).map((m, i) => ({
      ...m,
      content: i === 3 ? needleContent : `row ${i} says nothing of interest`,
    }));
    const [from, setFrom] = createSignal(40);
    const messages = () => all.slice(from());
    const hasOlder = () => from() > 0;
    const loadOlder = vi.fn(async () => {
      await tick(1);
      setFrom((n) => Math.max(0, n - 20));
    });
    const server = (hits: Array<(typeof all)[number]>) =>
      vi.fn(
        async (
          _q: string,
          _cursor: string | null,
          _limit: number,
          _signal?: AbortSignal,
        ): Promise<SessionSearchPage> =>
          ({
            hits: hits.map((m) => ({
              message_id: m.id,
              created_at: m.created_at,
              role: m.role,
              snippet: m.content,
              rank: -1,
            })),
            terms: ["portability"],
            mode: "phrase",
            total: hits.length,
            next_cursor: null,
          }) satisfies SessionSearchPage,
      );
    return { all, messages, hasOlder, loadOlder, server, from };
  }

  function mountPaged(
    h: ReturnType<typeof pagedHistory>,
    onSearchWhole: Parameters<typeof SessionView>[0]["onSearchWhole"],
  ) {
    return mount({
      get messages() {
        return h.messages();
      },
      get hasOlder() {
        return h.hasOlder();
      },
      messageCount: h.all.length,
      onLoadOlder: h.loadOlder,
      onSearchWhole,
    });
  }

  async function typeAndSearchWhole(query: string) {
    fireEvent.input(screen.getByTestId("search-input"), {
      target: { value: query },
    });
    await settleSearch();
    expect(screen.getByTestId("search-summary")).toHaveTextContent(
      "No matches in loaded history",
    );
    fireEvent.click(screen.getByTestId("search-whole"));
    await tick(6);
  }

  it("pages older history to the server's hit and highlights it only once its text is on screen", async () => {
    const h = pagedHistory();
    const onSearchWhole = h.server([h.all[3]!]);
    mountPaged(h, onSearchWhole);
    await tick();
    await typeAndSearchWhole("portability");
    expect(onSearchWhole).toHaveBeenCalledTimes(1);
    expect(onSearchWhole.mock.calls[0]![0]).toBe("portability");
    const summary = screen.getByTestId("search-whole-summary");
    expect(summary).toHaveTextContent(
      "1 matching message in the whole session · 1 in older history",
    );
    // Nothing is highlighted yet: the message is not loaded.
    expect(document.querySelectorAll("mark.passage-search")).toHaveLength(0);

    fireEvent.click(screen.getByTestId("search-whole-next"));
    for (let i = 0; i < 6 && h.from() > 0; i++) await settleSearch();
    await settleSearch();
    expect(h.loadOlder).toHaveBeenCalledTimes(2);
    expect(h.from()).toBe(0);
    expect(screen.getByTestId("search-summary")).toHaveTextContent(
      "1 of 1 in loaded history",
    );
    const marks = document.querySelectorAll("mark.passage-search");
    expect(marks).toHaveLength(1);
    expect(marks[0]!.closest("[data-row-key]")).toHaveAttribute(
      "data-row-key",
      "m.old-3",
    );
    expect(screen.queryByTestId("search-reach")).toBeNull();
    expect(screen.queryByTestId("search-whole-next")).toBeNull();
    expect(summary).toHaveTextContent("nothing more in older history");
  });

  it("says plainly when the loaded message's displayed text has no literal match", async () => {
    // The server matched on stored text; on screen the words are apart.
    const h = pagedHistory("portability, then much later the needle");
    mountPaged(h, h.server([h.all[3]!]));
    await tick();
    await typeAndSearchWhole("portability needle");
    fireEvent.click(screen.getByTestId("search-whole-next"));
    for (let i = 0; i < 6 && h.from() > 0; i++) await settleSearch();
    await settleSearch();
    expect(screen.getByTestId("search-reach")).toHaveTextContent(
      "Matching message loaded · the stored text matches but the displayed text does not contain it literally",
    );
    expect(document.querySelectorAll("mark.passage-search")).toHaveLength(0);
    expect(screen.queryByTestId("search-whole-next")).toBeNull();
  });

  it("reports the server's failure instead of pretending the session was searched", async () => {
    const h = pagedHistory();
    const onSearchWhole = vi.fn(async () => {
      throw new Error("temporal_fts unavailable");
    });
    mountPaged(h, onSearchWhole);
    await tick();
    await typeAndSearchWhole("portability");
    expect(screen.getByTestId("search-whole-summary")).toHaveTextContent(
      "Whole-session search unavailable · temporal_fts unavailable",
    );
    expect(screen.getByTestId("search-whole-summary")).toHaveAttribute(
      "data-whole-state",
      "error",
    );
    expect(screen.getByTestId("search-coverage")).toHaveTextContent(
      "Searched the loaded history only",
    );
    // The loaded-window result stands and the server can be asked again.
    expect(screen.getByTestId("search-summary")).toHaveTextContent(
      "No matches in loaded history",
    );
    expect(screen.getByTestId("search-whole")).toHaveTextContent(
      "Retry whole-session search",
    );
    fireEvent.click(screen.getByTestId("search-whole"));
    await tick(6);
    expect(onSearchWhole).toHaveBeenCalledTimes(2);
  });

  it("forgets the server answer as soon as the query changes", async () => {
    const h = pagedHistory();
    mountPaged(h, h.server([h.all[3]!]));
    await tick();
    await typeAndSearchWhole("portability");
    expect(screen.getByTestId("search-whole-summary")).toBeInTheDocument();
    fireEvent.input(screen.getByTestId("search-input"), {
      target: { value: "portabilit" },
    });
    await settleSearch();
    expect(screen.queryByTestId("search-whole-summary")).toBeNull();
    expect(screen.getByTestId("search-whole")).toBeInTheDocument();
    expect(h.loadOlder).not.toHaveBeenCalled();
  });

  it("gives up after the page bound and offers to keep loading rather than looping", async () => {
    const h = pagedHistory();
    // The server names a message the paging never delivers.
    const ghost = { ...h.all[3]!, id: "ghost", content: "portability" };
    const noProgress = vi.fn(async () => {
      await tick(1);
    });
    mount({
      messages: h.all.slice(40),
      hasOlder: true,
      messageCount: h.all.length + 1,
      onLoadOlder: noProgress,
      onSearchWhole: h.server([ghost]),
    });
    await tick();
    await typeAndSearchWhole("portability");
    fireEvent.click(screen.getByTestId("search-whole-next"));
    for (let i = 0; i < WHOLE_LOAD_PAGES + 2; i++) await tick(4);
    expect(noProgress).toHaveBeenCalledTimes(WHOLE_LOAD_PAGES);
    expect(screen.getByTestId("search-reach")).toHaveTextContent(
      `further back than ${WHOLE_LOAD_PAGES} pages`,
    );
    expect(screen.getByTestId("search-whole-next")).toHaveTextContent(
      "Keep loading",
    );
  });

  it("offers no whole-session search when the loaded window is the whole captured history", async () => {
    mount({ hasOlder: false });
    await tick();
    fireEvent.input(screen.getByTestId("search-input"), {
      target: { value: "zzz-not-here" },
    });
    await settleSearch();
    expect(screen.queryByTestId("search-coverage")).toBeNull();
    expect(screen.queryByTestId("search-whole")).toBeNull();
  });
});
