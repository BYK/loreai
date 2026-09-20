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
import { SessionView } from "~/components/reader/SessionView";
import type { TemporalMessage } from "~/contracts";
import { anchorFor, blockAnchor, encodeAnchor } from "~/reader/anchors";
import { messageBlock } from "~/reader/blocks";
import { HIGHLIGHT_ATTR } from "~/reader/selection";
import {
  READER_SPECIMEN,
  READER_SPECIMEN_DISTILLATION,
} from "~/reader/specimen";

const SPECIMEN = READER_SPECIMEN.messages;

/** Give the virtualiser a viewport (800px) and every row a height (120px). */
const LAYOUT_PROPS = ["offsetHeight", "getBoundingClientRect"] as const;
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
