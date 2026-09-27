/**
 * ContextWindowPane (#1924): the five sections render from a session-context
 * answer, every empty/honest state is stated rather than invented, hostile
 * server text stays inert, and links go through `knowledgeHref` only.
 */
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { MemoryRouter, Route } from "@solidjs/router";
import { describe, expect, it, vi } from "vitest";

import { ContextWindowPane } from "~/components/reader/ContextWindow";
import type { SessionContext } from "~/contracts";
import { ApiError } from "~/lib/api";
import { READER_SPECIMEN_CONTEXT } from "~/reader/specimen";

const HREF = (id: string) => `/ui/projects/p/knowledge/${id}`;

function mount(props: {
  context?: SessionContext;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
}) {
  const Pane = () => (
    <ContextWindowPane
      context={props.context}
      loading={props.loading ?? false}
      error={props.error}
      onRetry={props.onRetry ?? (() => {})}
      knowledgeHref={HREF}
    />
  );
  return render(() => (
    <MemoryRouter>
      <Route path="*" component={Pane} />
    </MemoryRouter>
  ));
}

function empty(over: Partial<SessionContext> = {}): SessionContext {
  return {
    session_id: "s",
    layer: null,
    history: { message_count: 0, token_estimate: 0 },
    distilled_prefix: { token_count: 0, distillations: [] },
    knowledge: {
      cache_text: null,
      cache_tokens: null,
      pin_tokens: null,
      stable_tokens: null,
      injections: [],
    },
    prompt_deltas: [],
    turns: [],
    ...over,
  };
}

describe("ContextWindowPane", () => {
  it("renders all five sections from the specimen context", () => {
    mount({ context: READER_SPECIMEN_CONTEXT });
    const summary = screen.getByTestId("context-summary");
    // Latest turn is layer 2: 31,000 raw → 9,800 sent.
    expect(summary).toHaveTextContent("9,800");
    expect(summary).toHaveTextContent("31,000");
    expect(summary).toHaveTextContent("×3.2");
    expect(summary).toHaveTextContent("Layer 2 · tool-output stripped");
    expect(screen.getByText("Distilled prefix")).toBeInTheDocument();
    const injections = screen.getByTestId("context-injections");
    expect(injections.querySelector("a")?.getAttribute("href")).toBe(
      "/ui/projects/p/knowledge/spec-k1",
    );
    expect(injections).toHaveTextContent("(entry removed)");
    expect(injections).toHaveTextContent("cache 1,240 · pinned 96 tokens");
    const deltas = screen.getByTestId("context-deltas");
    expect(deltas).toHaveTextContent("seq 0");
    expect(deltas).toHaveTextContent("1 removed");
    // The delta's text lives behind a <details> as inert text.
    expect(deltas.textContent).toContain("memory refreshed");
    // Turns table: three rows, usage "—" for the null-usage turn.
    expect(screen.getByText("Turns")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(4);
  });

  it("shows honest empty states for a context with nothing recorded", () => {
    mount({ context: empty() });
    expect(screen.getByTestId("context-summary")).toHaveTextContent(
      "No per-turn stats recorded yet",
    );
    expect(
      screen.getByText("No distilled prefix in effect."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No knowledge injected into this session."),
    ).toBeInTheDocument();
    expect(screen.getByText("No prompt updates.")).toBeInTheDocument();
    expect(screen.queryByText("Turns")).toBeNull();
  });

  it("shows the layer badge without turns when context.layer is set", () => {
    mount({ context: empty({ layer: 1 }) });
    expect(screen.getByTestId("context-summary")).toHaveTextContent(
      "Layer 1 · distilled prefix",
    );
  });

  it("renders a loading status while nothing is known", () => {
    mount({ loading: true });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading context window…",
    );
  });

  it("maps not_found to the empty record state and other errors to retry", () => {
    mount({ error: new ApiError("not_found", "/x", "gone", 404) });
    expect(screen.getByText("No context record")).toBeInTheDocument();

    mount({ error: new ApiError("unauthorized", "/x", "denied") });
    expect(screen.getByText("Context window hidden")).toBeInTheDocument();

    const onRetry = vi.fn();
    mount({ error: new ApiError("http", "/x", "boom", 500), onRetry });
    fireEvent.click(screen.getByTestId("context-retry"));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("keeps loaded context visible when a refresh fails", () => {
    mount({ context: READER_SPECIMEN_CONTEXT, error: new Error("off") });
    expect(screen.getByRole("alert")).toHaveTextContent("Refresh failed");
    expect(screen.getByTestId("context-summary")).toHaveTextContent("9,800");
  });

  it("keeps hostile injection titles as inert text", () => {
    const hostile = `<img src=x onerror=alert(1)>`;
    mount({
      context: empty({
        knowledge: {
          cache_text: null,
          cache_tokens: null,
          pin_tokens: null,
          stable_tokens: null,
          injections: [
            {
              logical_id: "k-bad",
              title: hostile,
              category: "gotcha",
              confidence: 0.1,
              created_at: 1_700_000_000_000,
              credited: false,
              verdict: null,
            },
          ],
        },
      }),
    });
    const pane = screen.getByTestId("context-injections");
    expect(pane.textContent).toContain(hostile);
    expect(pane.querySelector("img")).toBeNull();
    expect(pane.querySelector("a")?.textContent).toBe(hostile);
  });

  it("caps the turns table at the last 20 and says so", () => {
    const turns = Array.from({ length: 25 }, (_, i) => ({
      message_id: `m-${i}`,
      created_at: 1_700_000_000_000 + i,
      layer: 0,
      raw_tokens: i,
      total_tokens: i,
      distilled_tokens: 0,
      usage: null,
    }));
    mount({ context: empty({ turns }) });
    expect(screen.getByText("showing last 20 of 25")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(21);
  });
});
