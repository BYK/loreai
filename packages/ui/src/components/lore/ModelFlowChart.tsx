/**
 * Solid port of the render glue in model-tides `src/flow-chart.ts` (render() +
 * resize(), vendored `renderFlowSvg` untouched). Daily counts become
 * `{ time, to: model, weight }` flow data; "Other models" groups everything
 * past `MAX_VISIBLE_MODELS`, with the same show-all toggle, legend
 * disambiguation and hover tooltip.
 */
import {
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";

import "~/vendor/model-tides/flow-svg.css";
import "./model-flow-chart.css";
import { renderFlowSvg, type FlowDatum } from "~/vendor/model-tides/renderer";
import {
  getModelColor,
  OTHER_MODEL_COLOR,
} from "~/vendor/model-tides/model-colors";

const DAY = 86_400_000;
const MAX_VISIBLE_MODELS = 6;
const formatCount = (value: number): string =>
  new Intl.NumberFormat("en-GB").format(value);
const formatDate = (date: Date, options: Intl.DateTimeFormatOptions): string =>
  new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "UTC" }).format(
    date,
  );
const titledPeriod = (period: string, time: number): string =>
  /\b\d{4}\b/.test(period)
    ? period
    : `${period} ${new Date(time).getUTCFullYear()}`;

export function shortModelName(model: string): string {
  const name = model.split("/").at(-1) ?? model;
  const claude =
    /^claude-(opus|sonnet|haiku)-(\d+)[-.](\d+)(?:-(\d{8}))?(.*)$/i.exec(name);
  if (claude) {
    const releaseTime = claude[4]
      ? Date.parse(
          `${claude[4].slice(0, 4)}-${claude[4].slice(4, 6)}-${claude[4].slice(6)}T00:00:00Z`,
        )
      : NaN;
    const validDate =
      Number.isFinite(releaseTime) &&
      new Date(releaseTime).toISOString().slice(0, 10).replaceAll("-", "") ===
        claude[4];
    const date = claude[4]
      ? ` · ${
          validDate
            ? formatDate(new Date(releaseTime), {
                month: "short",
                year: "numeric",
              })
            : claude[4]
        }`
      : "";
    return `${(claude[1]?.[0] ?? "").toUpperCase()}${claude[1]?.slice(1) ?? ""} ${claude[2]}.${claude[3]}${date}${claude[5]}`;
  }
  const gemini = /^gemini-(\d+(?:[.-]\d+)?)-(flash|pro)(-preview)?$/i.exec(
    name,
  );
  if (gemini)
    return `Gemini ${gemini[1]} ${(gemini[2]?.[0] ?? "").toUpperCase()}${gemini[2]?.slice(1) ?? ""}${gemini[3] ? " preview" : ""}`;
  if (/^gpt-/i.test(name))
    return name.replace(/^gpt-/i, "GPT-").replace(/-codex$/i, " Codex");
  return name;
}

function shortProviderName(model: string): string {
  const provider = model.split("/")[0] ?? "";
  return provider === "github-copilot"
    ? "Copilot"
    : provider === "openrouter"
      ? "OpenRouter"
      : `${provider[0]?.toUpperCase() ?? ""}${provider.slice(1)}`;
}

export interface ModelFlowChartProps {
  /** Filtered (from/to/project) daily rows. */
  rows: readonly FlowDatum[];
  /** Inclusive day bounds of `rows`, in ms. Empty when `rows` is empty. */
  startMs: number;
  endMs: number;
}

export const ModelFlowChart = (props: ModelFlowChartProps) => {
  let scrollRef: HTMLDivElement | undefined;
  let canvasRef: HTMLDivElement | undefined;
  let tooltipRef: HTMLDivElement | undefined;
  const [showAll, setShowAll] = createSignal(false);
  const [size, setSize] = createSignal({ width: 0, height: 0 });

  const counts = createMemo(() => {
    const map = new Map<string, number>();
    for (const { to, weight } of props.rows)
      map.set(to, (map.get(to) ?? 0) + (weight ?? 0));
    return [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  });
  const visible = createMemo(() =>
    showAll() || counts().length <= MAX_VISIBLE_MODELS
      ? counts().map(([model]) => model)
      : [
          ...counts()
            .slice(0, MAX_VISIBLE_MODELS)
            .map(([model]) => model),
          "Other models",
        ],
  );
  const visibleSet = createMemo(() => new Set(visible()));
  const displayModel = (model: string): string =>
    visibleSet().has(model) ? model : "Other models";
  const total = createMemo(() =>
    props.rows.reduce((sum, row) => sum + (row.weight ?? 0), 0),
  );

  const ariaLabel = "Your model usage over time";

  const svg = createMemo(() => {
    const rows = props.rows;
    if (!rows.length) return "";
    const { width, height } = size();
    const start = props.startMs;
    const end = props.endMs + DAY - 1;
    const label = "active session-days";
    return renderFlowSvg(rows, {
      start,
      end,
      width: width || 900,
      height: height || 520,
      weeklyBuckets: true,
      inferMigrations: true,
      nativeTooltips: false,
      order: visible(),
      displayKey: displayModel,
      displayName: (model) =>
        model === "Other models" ? model : model.replace("/", " / "),
      colorFor: (model) =>
        model === "Other models" ? OTHER_MODEL_COLOR : getModelColor(model),
      streamColorFor: (model) => getModelColor(model),
      formatValue: formatCount,
      formatPeriod: (time, intervalDays) =>
        formatDate(
          new Date(time),
          intervalDays === 30
            ? { month: "short", year: "numeric" }
            : { day: "numeric", month: "short" },
        ),
      formatNodeTitle: ({ period, time, label: model, value }) =>
        `${titledPeriod(period, time)} · ${model} · ${formatCount(value)} ${label}`,
      formatLinkTitle: ({ toLabel, toPeriod, time, value }) =>
        `${formatCount(value)} ${label} of ${toLabel} in ${titledPeriod(toPeriod, time)}`,
      formatContinuityTitle: ({
        label: model,
        fromPeriod,
        fromTime,
        toPeriod,
        time,
      }) =>
        `${model} appears in both ${titledPeriod(fromPeriod, fromTime)} and ${titledPeriod(toPeriod, time)}. This does not track individual sessions.`,
      formatMigrationTitle: ({
        fromLabel,
        toLabel,
        fromPeriod,
        toPeriod,
        value,
      }) =>
        `Possible shift: ${fromLabel} → ${toLabel}, ${fromPeriod} – ${toPeriod}. Up to ${formatCount(value)} ${label} line up; this is inferred, not tracked.`,
      axisCaption: "Time →",
      ariaLabel,
    });
  });

  const hideTooltip = () => {
    if (tooltipRef) tooltipRef.hidden = true;
  };
  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType === "touch") {
      hideTooltip();
      return;
    }
    const mark = (event.target as Element | null)?.closest?.(
      "[data-flow-action]",
    );
    const title =
      mark && canvasRef?.contains(mark)
        ? mark.getAttribute("data-flow-tooltip")
        : null;
    if (!mark || !title || !tooltipRef || !scrollRef) {
      hideTooltip();
      return;
    }
    const tooltip = tooltipRef;
    tooltip.textContent = title;
    tooltip.style.setProperty(
      "--hover-color",
      mark.getAttribute("fill") ?? "var(--accent)",
    );
    const bounds = scrollRef.getBoundingClientRect();
    tooltip.style.left = `${Math.max(10, Math.min(event.clientX - bounds.left + 14, bounds.width - 290))}px`;
    tooltip.style.top = `${Math.max(10, Math.min(event.clientY - bounds.top + 14, bounds.height - 95))}px`;
    tooltip.hidden = false;
  };

  const resize = () => {
    const bounds = scrollRef?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0) return;
    const viewportWidth = Math.max(
      1,
      window.visualViewport?.width ?? window.innerWidth,
    );
    const viewportHeight = Math.max(
      1,
      window.visualViewport?.height ?? window.innerHeight,
    );
    const width = Math.round(bounds.width);
    const height = Math.max(
      320,
      Math.round(
        Math.min(
          ((width * viewportHeight) / viewportWidth) * 0.66,
          viewportHeight * 0.78,
        ),
      ),
    );
    const current = size();
    if (current.width === width && current.height === height) return;
    setSize({ width, height });
    scrollRef?.style.setProperty("--flow-chart-height", `${height}px`);
  };

  onMount(() => {
    const observer = new ResizeObserver(resize);
    if (scrollRef) observer.observe(scrollRef);
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    resize();
    onCleanup(() => {
      observer.disconnect();
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
    });
  });

  const legendNames = createMemo(() =>
    visible().map((model) =>
      model === "Other models" ? model : shortModelName(model),
    ),
  );

  return (
    <section
      class="rounded-lg border border-line bg-bg p-4"
      data-testid="model-flow-chart"
    >
      <div class="mb-2 flex flex-wrap items-start justify-between gap-3">
        <p class="text-xs text-muted">
          Hover over a bar for its model and count.
        </p>
        <div class="flex items-center gap-3 text-xs">
          <span class="text-muted" data-testid="model-visibility">
            {counts().length > MAX_VISIBLE_MODELS && !showAll()
              ? `Top ${MAX_VISIBLE_MODELS} models`
              : `${formatCount(counts().length)} ${counts().length === 1 ? "model" : "models"}`}
          </span>
          <Show when={counts().length > MAX_VISIBLE_MODELS}>
            <button
              type="button"
              class="text-accent hover:underline"
              aria-expanded={showAll()}
              data-testid="show-models"
              onClick={() => setShowAll(!showAll())}
            >
              {showAll()
                ? "Show top models"
                : `Show all ${formatCount(counts().length)}`}
            </button>
          </Show>
        </div>
      </div>
      <p
        class="mb-2 text-xs text-muted"
        role="status"
        data-testid="chart-status"
      >
        Showing{" "}
        {formatDate(new Date(props.startMs), {
          day: "numeric",
          month: "short",
          year: "numeric",
        })}{" "}
        –{" "}
        {formatDate(new Date(props.endMs), {
          day: "numeric",
          month: "short",
          year: "numeric",
        })}{" "}
        · {formatCount(total())} active session-days
      </p>
      <div
        class="mb-3 flex flex-wrap items-center gap-x-3.5 gap-y-1"
        role="group"
        aria-label="Model colors"
        data-testid="model-legend"
      >
        <For each={visible()}>
          {(model, index) => {
            const short = () => legendNames()[index()];
            const ambiguous = () =>
              legendNames().filter((label) => label === short()).length > 1;
            return (
              <span
                class="inline-flex items-center gap-1.5 text-[11px] font-medium"
                title={model}
              >
                <i
                  class="inline-block size-2 rounded-[2px]"
                  style={{
                    "background-color":
                      model === "Other models"
                        ? OTHER_MODEL_COLOR
                        : getModelColor(model),
                  }}
                />
                <span>
                  {ambiguous() && model !== "Other models"
                    ? `${short()} · ${shortProviderName(model)}`
                    : short()}
                </span>
              </span>
            );
          }}
        </For>
      </div>
      <div class="relative">
        <div
          ref={(el) => (scrollRef = el)}
          class="w-full overflow-hidden"
          onPointerMove={onPointerMove}
          onPointerLeave={hideTooltip}
          onPointerDown={hideTooltip}
        >
          {/* oxlint-disable-next-line no-inner-declarations -- renderFlowSvg output is internally escaped (escapeSvg on every interpolated value). */}
          <div
            ref={(el) => (canvasRef = el)}
            role="img"
            aria-label={ariaLabel}
            /* eslint-disable-next-line solid/no-innerhtml */
            innerHTML={svg()}
          />
        </div>
        <div
          ref={(el) => (tooltipRef = el)}
          class="chart-tooltip pointer-events-none absolute z-10 max-w-[280px] rounded border border-line bg-soft px-2 py-1 text-[11px] shadow"
          role="tooltip"
          hidden
        />
      </div>
    </section>
  );
};
