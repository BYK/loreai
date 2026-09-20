import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

import {
  DistillationBlockView,
  MessageBlockView,
  TIME_UNKNOWN,
} from "~/components/reader/SessionBlock";
import type { TemporalMessage } from "~/contracts";
import {
  CHUNK_SEPARATOR,
  distillationBlock,
  messageBlock,
} from "~/reader/blocks";

function msg(over: Partial<TemporalMessage> = {}): TemporalMessage {
  return {
    id: "m-1",
    source_id: null,
    project_id: "p",
    session_id: "s",
    role: "assistant",
    content: "Hello **world**",
    tokens: 3,
    distilled: 0,
    created_at: 1_700_000_000_000,
    metadata: JSON.stringify({ modelID: "claude-x", providerID: "anthropic" }),
    ...over,
  };
}

describe("MessageBlockView", () => {
  it("renders role, model and sanitised Markdown with anchor data attributes", () => {
    const block = messageBlock(msg());
    render(() => <MessageBlockView block={block} />);
    const article = document.getElementById("m.m-1");
    expect(article).not.toBeNull();
    expect(article?.dataset.blockId).toBe("m.m-1");
    expect(article?.dataset.origin).toBe("agent");
    expect(screen.getByText("Agent")).toBeInTheDocument();
    expect(screen.getByText("claude-x")).toBeInTheDocument();
    expect(screen.getByRole("strong")).toHaveTextContent("world");
    const rich = article?.querySelector<HTMLElement>(".rich-text");
    expect(rich?.dataset.block).toBe("m.m-1");
    expect(rich?.dataset.part).toBe("0");
    expect(article?.querySelector("time")?.getAttribute("datetime")).toBe(
      new Date(1_700_000_000_000).toISOString(),
    );
  });

  it("says 'time unknown' instead of inventing a timestamp", () => {
    render(() => (
      <MessageBlockView block={messageBlock(msg({ created_at: 0 }))} />
    ));
    expect(screen.getByText(TIME_UNKNOWN)).toBeInTheDocument();
    expect(document.querySelector("time")).toBeNull();
  });

  it("labels Lore-injected and system-prompt blocks (#1508)", () => {
    render(() => (
      <>
        <MessageBlockView
          block={messageBlock(
            msg({ id: "l", role: "user", metadata: '{"synthetic":true}' }),
          )}
        />
        <MessageBlockView
          block={messageBlock(msg({ id: "s", role: "system", metadata: "{}" }))}
        />
        <MessageBlockView
          block={messageBlock(
            msg({ id: "u", role: "user", metadata: '{"agent":"opencode"}' }),
          )}
        />
      </>
    ));
    expect(screen.getByText("Lore")).toBeInTheDocument();
    expect(screen.getByText("injected by Lore")).toBeInTheDocument();
    expect(document.getElementById("m.l")?.dataset.origin).toBe("lore");
    expect(screen.getByText("System prompt")).toBeInTheDocument();
    expect(document.getElementById("m.s")?.dataset.origin).toBe("system");
    expect(screen.getByText("User")).toBeInTheDocument();
    expect(screen.getByText("via opencode")).toBeInTheDocument();
  });

  it("renders tool and reasoning parts collapsed and expandable", () => {
    const content = [
      "Let me look.",
      "[reasoning] private-ish thinking",
      "[tool:read] <script>alert(1)</script>\nline 2",
    ].join(CHUNK_SEPARATOR);
    render(() => <MessageBlockView block={messageBlock(msg({ content }))} />);
    const details = document.querySelectorAll("details");
    expect(details).toHaveLength(2);
    expect(details[0]?.dataset.partKind).toBe("reasoning");
    expect(details[1]?.dataset.partKind).toBe("tool");
    expect(details[1]?.open).toBe(false);
    expect(screen.getByText("read")).toBeInTheDocument();
    expect(screen.getByText(/2 lines/)).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
    expect(details[1]?.querySelector(".rich-text")?.textContent).toContain(
      "<script>alert(1)</script>",
    );
    expect(
      details[1]?.querySelector<HTMLElement>(".rich-text")?.dataset.part,
    ).toBe("2");
  });

  it("opens parts when asked (deep link / search hit)", () => {
    const content = `x${CHUNK_SEPARATOR}[tool:bash] ls`;
    render(() => (
      <MessageBlockView block={messageBlock(msg({ content }))} openParts />
    ));
    expect(document.querySelector("details")?.open).toBe(true);
  });
});

describe("DistillationBlockView", () => {
  const block = distillationBlock({
    id: "d-1",
    session_id: "s",
    generation: 1,
    token_count: 1234,
    r_compression: 3.25,
    c_norm: null,
    archived: 1,
    created_at: 0,
    call_type: null,
  });

  it("is labelled compressed context, never speech, and loads on demand", () => {
    const onOpen = vi.fn();
    render(() => <DistillationBlockView block={block} onOpen={onOpen} />);
    const aside = document.getElementById("d.d-1");
    expect(aside?.tagName).toBe("ASIDE");
    expect(aside?.dataset.origin).toBe("distillation");
    expect(screen.getByText("Compressed context")).toBeInTheDocument();
    expect(screen.getByText("generation 1")).toBeInTheDocument();
    expect(screen.getByText("archived")).toBeInTheDocument();
    expect(
      screen.getByText(/1,234 tokens · 3.3× compression/),
    ).toBeInTheDocument();
    expect(screen.getByText(TIME_UNKNOWN)).toBeInTheDocument();
    expect(aside?.querySelector("pre")).toBeNull();

    const details = aside?.querySelector("details");
    expect(details).not.toBeNull();
    if (details) {
      details.open = true;
      fireEvent(details, new Event("toggle"));
    }
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("shows the compressed text as plain text when supplied", () => {
    render(() => (
      <DistillationBlockView
        block={block}
        detail={{
          id: "d-1",
          session_id: "s",
          project_id: "p",
          generation: 1,
          token_count: 1234,
          r_compression: 3.25,
          c_norm: null,
          archived: 1,
          created_at: 0,
          observations: "<b>summary</b> of things",
          source_ids: "[]",
        }}
      />
    ));
    const pre = document.querySelector("pre");
    expect(pre?.textContent).toBe("<b>summary</b> of things");
    expect(document.querySelector("b")).toBeNull();
  });
});
