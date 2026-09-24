import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

import type { CostsSnapshot, WarmingSnapshot } from "~/contracts";
import { CostsPage } from "~/components/lore/CostsPage";
import { WarmingPage } from "~/components/lore/WarmingPage";
import type { ApiClient } from "~/lib/api";
import { WorkspaceProvider } from "~/routes/workspace";

const workers = {
  distillation: { cost: 0.12, calls: 2 },
  curation: { cost: 0.03, calls: 1 },
  compaction: { cost: 0, calls: 0 },
  recall: { cost: 0.01, calls: 1 },
  warmup: { cost: 0.02, calls: 2 },
};

const warmingData: WarmingSnapshot = {
  enabled: true,
  override: null,
  env_forced: false,
  can_edit: true,
  can_toggle: true,
  summary: {
    live_sessions: 1,
    warming_now: 0,
    disabled_sessions: 0,
    total_warmups: 4,
    total_hits: 2,
    hit_rate: 0.5,
    tripped_buckets: 1,
  },
  circuit_breaker: {
    tripped_count: 1,
    entries: [
      {
        session_id: "session-1",
        model: "claude-sonnet",
        upstream: "https://api.anthropic.com · route e3b0c442",
        tripped_at: 1_700_000_000_000,
      },
    ],
  },
  sessions: [
    {
      session_id: "session-1",
      project_id: "project-1",
      project_name: "Project One",
      project_path: "/tmp/project-one",
      turns: 10,
      parent_session_id: null,
      is_subagent: false,
      actual_cost: 0.8,
      net_savings: 0.2,
      cost_without_lore: 1,
      cache_hit_pct: 75,
      conversation_cost: 0.6,
      worker_cost: 0.2,
      workers,
      warming: {
        enabled: true,
        should_warm: false,
        phase: "initial",
        reason: "Waiting for the cache window",
        ttl: "5m",
        idle_ms: 120_000,
        p_returns: 0.4,
        total_warmups: 4,
        warmup_hits: 2,
        disabled: false,
        user_stopped: false,
        force_keep_warm: false,
        circuit_breaker: {
          tripped: false,
          failures: 0,
          max_failures: 3,
          tripped_at: 0,
        },
      },
    },
  ],
  histograms: [
    {
      project_id: "project-1",
      project_name: "Project One",
      total: 2,
      counts: [1, 1, 0],
      bins_ms: [10_000, 60_000],
    },
  ],
};

const costsData: CostsSnapshot = {
  live: {
    session_count: 1,
    spend: 0.8,
    conversation_spend: 0.6,
    worker_cost: 0.2,
    net_savings: 0.2,
    cost_without_lore: 1,
    avoided_compactions: 1,
    avoided_compaction_cost: 0.1,
    warmup_savings: 0.05,
    ttl_savings: 0.03,
    batch_savings: 0.02,
    cache_read_tokens: 3000,
    input_tokens: 4000,
    turns: 10,
    workers,
    throttle: { events: 2, total_delay_ms: 1500 },
  },
  totals: {
    combined_session_count: 3,
    spend: 2.5,
    worker_cost: 0.6,
    net_savings: 0.7,
    cost_without_lore: 3.2,
    historical_conversation_spend: 1.1,
    avoided_compactions: 4,
  },
  historical: {
    distillation_cost: 0.2,
    distillation_calls: 4,
    distillation_batch_calls: 1,
    distillation_direct_calls: 3,
    avoided_compactions: 3,
    avoided_compaction_cost: 0.3,
    warmup_savings: 0.05,
    warmup_cost: 0.1,
    warmup_hits: 2,
    ttl_savings: 0.1,
    ttl_hits: 3,
    batch_savings: 0.05,
    session_count: 2,
    message_count: 20,
    total_worker_cost: 0.4,
    persisted_conversation_cost: 1.1,
    worker_breakdown: {
      distillation: { cost: 0.2, calls: 3 },
      curation: { cost: 0.05, calls: 1 },
      compaction: { cost: 0, calls: 0 },
      recall: { cost: 0.05, calls: 2 },
    },
  },
  daily: {
    entries: Array.from({ length: 14 }, (_, index) => ({
      date: `2026-09-${String(index + 1).padStart(2, "0")}`,
      cost: index === 13 ? 0.45 : 0,
    })),
    budget: {
      amount: 5,
      spend: 1.25,
      date: "2026-09-14",
      rate: 0.3,
      env_override: null,
      can_edit: true,
    },
  },
  sessions: warmingData.sessions.slice(0, 1),
};

function clientWith(partial: Partial<ApiClient>): ApiClient {
  return { listProjects: async () => [], ...partial } as unknown as ApiClient;
}

function mountPage(page: "warming" | "costs", client: ApiClient) {
  const history = createMemoryHistory();
  history.set({ value: `/${page}` });
  return render(() => (
    <MemoryRouter history={history}>
      <Route
        path="*"
        component={() => (
          <WorkspaceProvider client={client} db={Promise.resolve(null)}>
            {page === "warming" ? <WarmingPage /> : <CostsPage />}
          </WorkspaceProvider>
        )}
      />
    </MemoryRouter>
  ));
}

describe("WarmingPage", () => {
  it("shows live warming state, histograms and runs the global/session controls", async () => {
    const setEnabled = vi.fn(async () => ({ enabled: false, override: false }));
    const resetBreakers = vi.fn(async () => ({
      reset: true,
      tripped_count: 0,
    }));
    const setMode = vi.fn(
      async (sessionId: string, mode: "keep" | "stop" | "auto") => ({
        session_id: sessionId,
        mode,
        disabled: mode === "stop",
        force_keep_warm: mode === "keep",
      }),
    );
    mountPage(
      "warming",
      clientWith({
        getWarming: async () => warmingData,
        setWarmingEnabled: setEnabled,
        resetWarmingCircuitBreaker: resetBreakers,
        setSessionWarmingMode: setMode,
      }),
    );

    expect((await screen.findAllByText("Project One")).length).toBeGreaterThan(
      0,
    );
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.getByText("Project histograms")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Disable warming" }));
    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith(false));
    fireEvent.click(
      screen.getByRole("button", { name: "Reset circuit breakers" }),
    );
    await waitFor(() => expect(resetBreakers).toHaveBeenCalledOnce());
    fireEvent.click(
      screen.getByRole("button", { name: "stop warming for session-1" }),
    );
    await waitFor(() =>
      expect(setMode).toHaveBeenCalledWith("session-1", "stop"),
    );
  });

  it("keeps a survival-disabled session in Auto mode", async () => {
    const pausedData: WarmingSnapshot = {
      ...warmingData,
      sessions: warmingData.sessions.map((row) => ({
        ...row,
        warming: row.warming
          ? {
              ...row.warming,
              disabled: true,
              user_stopped: false,
              reason: "Session paused by survival analysis",
            }
          : null,
      })),
    };
    mountPage("warming", clientWith({ getWarming: async () => pausedData }));

    expect(
      await screen.findByRole("button", {
        name: "auto warming for session-1",
      }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: "stop warming for session-1" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Paused by survival")).toBeInTheDocument();
  });

  it("recognizes an operator stop in an older snapshot", async () => {
    const legacyData: WarmingSnapshot = {
      ...warmingData,
      sessions: warmingData.sessions.map((row) => {
        if (!row.warming) return row;
        const warming = { ...row.warming };
        delete warming.user_stopped;
        return {
          ...row,
          warming: {
            ...warming,
            disabled: true,
            reason: "Warming stopped by user",
          },
        };
      }),
    };
    mountPage("warming", clientWith({ getWarming: async () => legacyData }));

    expect(
      await screen.findByRole("button", {
        name: "stop warming for session-1",
      }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Stopped")).toBeInTheDocument();
  });

  it("warns when an action succeeds but refreshing the snapshot fails", async () => {
    let reads = 0;
    mountPage(
      "warming",
      clientWith({
        getWarming: async () => {
          if (reads++ === 1) throw new Error("gateway offline");
          return warmingData;
        },
        setWarmingEnabled: async () => ({ enabled: false, override: false }),
      }),
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Disable warming" }),
    );
    const warning = await screen.findByRole("alert");
    expect(warning).toHaveTextContent("Showing the last successful snapshot");
    expect(warning).toHaveTextContent("gateway offline");

    fireEvent.click(within(warning).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});

describe("CostsPage", () => {
  it("rejects an empty daily budget instead of disabling the limit", async () => {
    const setBudget = vi.fn(async (amount: number) => ({
      amount,
      disabled: amount === 0,
    }));
    mountPage(
      "costs",
      clientWith({
        getCosts: async () => costsData,
        setDailyBudget: setBudget,
      }),
    );

    const input = await screen.findByLabelText("Daily budget in US dollars");
    fireEvent.input(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save budget" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter a daily budget between $0 and $1,000,000.",
    );
    expect(setBudget).not.toHaveBeenCalled();
  });

  it("accepts sub-cent budget amounts supported by the API", async () => {
    const setBudget = vi.fn(async (amount: number) => ({
      amount,
      disabled: amount === 0,
    }));
    mountPage(
      "costs",
      clientWith({
        getCosts: async () => costsData,
        setDailyBudget: setBudget,
      }),
    );

    const input = (await screen.findByLabelText(
      "Daily budget in US dollars",
    )) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "0.005" } });
    expect(input.checkValidity()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save budget" }));
    await waitFor(() => expect(setBudget).toHaveBeenCalledWith(0.005));
  });

  it("shows costs, history and per-session rows; saves and disables the budget", async () => {
    const setBudget = vi.fn(async (amount: number) => ({
      amount,
      disabled: amount === 0,
    }));
    mountPage(
      "costs",
      clientWith({
        getCosts: async () => costsData,
        setDailyBudget: setBudget,
      }),
    );

    expect(await screen.findByText("Historical estimates")).toBeInTheDocument();
    expect(screen.getByText("Per-session costs")).toBeInTheDocument();
    expect(screen.getByText("Avoided compactions · 3")).toBeInTheDocument();
    expect(screen.getByText("session-1")).toBeInTheDocument();

    fireEvent.input(screen.getByLabelText("Daily budget in US dollars"), {
      target: { value: "8.5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save budget" }));
    await waitFor(() => expect(setBudget).toHaveBeenCalledWith(8.5));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Disable budget" }),
      ).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Disable budget" }));
    await waitFor(() => expect(setBudget).toHaveBeenCalledWith(0));
  });

  it("shows an empty per-session state without hiding daily/history data", async () => {
    mountPage(
      "costs",
      clientWith({
        getCosts: async () => ({
          ...costsData,
          sessions: [],
          live: { ...costsData.live, session_count: 0 },
        }),
      }),
    );
    expect(await screen.findByText("No live costs yet")).toBeInTheDocument();
    expect(screen.getByText("Historical estimates")).toBeInTheDocument();
  });

  it("warns when saving succeeds but refreshing cost data fails", async () => {
    let reads = 0;
    mountPage(
      "costs",
      clientWith({
        getCosts: async () => {
          if (reads++ === 1) throw new Error("gateway offline");
          return costsData;
        },
        setDailyBudget: async (amount: number) => ({
          amount,
          disabled: amount === 0,
        }),
      }),
    );

    fireEvent.input(
      await screen.findByLabelText("Daily budget in US dollars"),
      { target: { value: "8.5" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save budget" }));
    const warning = await screen.findByRole("alert");
    expect(warning).toHaveTextContent("Showing the last successful snapshot");
    expect(warning).toHaveTextContent("gateway offline");

    fireEvent.click(within(warning).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});
