import { expect, test } from "@playwright/test";

const workers = {
  distillation: { cost: 0, calls: 0 },
  curation: { cost: 0, calls: 0 },
  compaction: { cost: 0, calls: 0 },
  recall: { cost: 0, calls: 0 },
  warmup: { cost: 0.02, calls: 2 },
};
const warming = {
  enabled: true,
  override: null,
  env_forced: false,
  can_edit: true,
  can_toggle: true,
  summary: {
    live_sessions: 1,
    warming_now: 0,
    disabled_sessions: 0,
    total_warmups: 2,
    total_hits: 1,
    hit_rate: 0.5,
    tripped_buckets: 1,
  },
  circuit_breaker: {
    tripped_count: 1,
    entries: [
      {
        session_id: "fixture-session",
        model: "fictional-model",
        upstream: "https://example.test/route",
        tripped_at: 1_700_000_000_000,
      },
    ],
  },
  sessions: [
    {
      session_id: "fixture-session",
      project_id: null,
      project_name:
        "A recorded project with a very long unbroken label " + "x".repeat(80),
      project_path: null,
      turns: 4,
      parent_session_id: null,
      is_subagent: false,
      actual_cost: 0.1,
      net_savings: 0.01,
      cost_without_lore: 0.11,
      cache_hit_pct: 50,
      conversation_cost: 0.08,
      worker_cost: 0.02,
      workers,
      warming: {
        enabled: true,
        should_warm: false,
        phase: "initial",
        reason: "Waiting for the cache window",
        ttl: "5m",
        idle_ms: 120_000,
        p_returns: 0.4,
        total_warmups: 2,
        warmup_hits: 1,
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
  histograms: [],
};

for (const width of [320, 390]) {
  test(`operation disclosures keep warnings and controls reachable at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.route("**/api/v1/warming", (route) =>
      route.fulfill({ json: warming }),
    );
    await page.goto("/ui/warming");
    const warning = page.getByTestId("warming-breaker");
    await expect(warning).toBeVisible();
    const reset = warning.getByRole("button", {
      name: "Reset circuit breakers",
    });
    await expect(reset).toBeVisible();
    await expect(
      warning.getByText("fictional-model", { exact: false }),
    ).not.toBeVisible();
    for (const button of [
      reset,
      page.getByRole("button", { name: "stop warming for fixture-session" }),
    ]) {
      expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    }
    await expect(
      page.getByText("P(return)", { exact: true }),
    ).not.toBeVisible();
    const diagnostics = page.getByText("Session diagnostics", { exact: true });
    expect((await diagnostics.boundingBox())?.height).toBeGreaterThanOrEqual(
      44,
    );
    await diagnostics.focus();
    await diagnostics.press("Enter");
    await expect(page.getByText("P(return)", { exact: true })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);

    await page.goto("/ui/costs");
    await expect(
      page.getByText("Live spend since gateway start"),
    ).toBeVisible();
    const pacingSwitch = page.getByRole("switch", { name: "Automatic pacing" });
    await expect(pacingSwitch).toBeVisible();
    expect((await pacingSwitch.boundingBox())?.height).toBeGreaterThanOrEqual(
      44,
    );
    expect((await pacingSwitch.boundingBox())?.width).toBeGreaterThanOrEqual(
      44,
    );
    const history = page.getByText("Historical estimates", { exact: true });
    await expect(history.locator("..")).not.toHaveAttribute("open");
    await expect(
      page.getByText("Distillation estimate", { exact: true }),
    ).not.toBeVisible();
    await history.click();
    await expect(
      page.getByText("Distillation estimate", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Refresh", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);

    await page.goto("/ui/model-usage");
    const totals = page.getByText("Model totals", { exact: true });
    await expect(totals.locator("..")).not.toHaveAttribute("open");
    await expect(page.getByTestId("model-usage-scope")).toContainText(
      "session-days",
    );
    await expect(page.getByTestId("project-select")).toBeVisible();
    const reviewUpload = page.getByRole("button", {
      name: "Review upload…",
      exact: true,
    });
    await expect(reviewUpload).toBeVisible();
    expect((await reviewUpload.boundingBox())?.height).toBeGreaterThanOrEqual(
      44,
    );
    await totals.click();
    await expect(
      page.getByRole("columnheader", { name: /Model/ }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}
