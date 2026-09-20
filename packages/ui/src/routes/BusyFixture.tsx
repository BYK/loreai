/**
 * `/ui/fixture?view=busy` — the deterministic busy-session fixture (plan
 * §16.1) mounted on the real `SessionView`. No backend: `generateBusySession`
 * supplies the retained history and `BusyStreamEngine` the live traffic.
 *
 * The controls drive the scenarios the plan lists — streaming at 50 deltas/s
 * per stream, a 1,000-event burst, disconnect → stale snapshot → reconnect,
 * a hidden tab, a failing cache write, a source edit under a live link — and
 * `Verify` compares what the reader holds with what the engine produced
 * (no lost or reordered text, no duplicate blocks). Metrics are shown live
 * and exposed as JSON for the Playwright budget run.
 *
 * Live events are coalesced per message id and applied once per animation
 * frame, so the pending queue is bounded by the number of live messages,
 * not by the event rate.
 */
import type { Component } from "solid-js";
import {
  For,
  Show,
  batch,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { useSearchParams } from "@solidjs/router";

import { DocHeader } from "~/components/lore/Document";
import { SessionView } from "~/components/reader/SessionView";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import type { TemporalMessage } from "~/contracts";
import { BusyMetrics, type MetricsReport } from "~/fixture/busy-metrics";
import {
  BUSY_DEFAULT_BLOCKS,
  BUSY_DEFAULT_SEED,
  BUSY_DELTAS_PER_SECOND,
  BUSY_SESSION_ID,
  BUSY_STREAMS,
  type BusyEvent,
  BusyStreamEngine,
  applyEvents,
  generateBusySession,
  mutateMessage,
  reconcile,
} from "~/fixture/busy-session";
import { decodeAnchor } from "~/reader/anchors";
import type { KeyStatus } from "~/state/status";

export interface VerifyReport {
  ok: boolean;
  duplicates: number;
  missing: number;
  mismatched: number;
  extra: number;
  /** True when every message is in non-decreasing `created_at` order. */
  ordered: boolean;
}

/** Compare the reader's list with the engine's expected content. */
export function verifyAgainst(
  messages: readonly TemporalMessage[],
  base: readonly TemporalMessage[],
  expected: ReadonlyMap<string, TemporalMessage>,
): VerifyReport {
  const seen = new Set<string>();
  let duplicates = 0;
  let mismatched = 0;
  let extra = 0;
  let ordered = true;
  let last = Number.NEGATIVE_INFINITY;
  const baseById = new Map(base.map((m) => [m.id, m]));
  for (const m of messages) {
    if (seen.has(m.id)) duplicates++;
    seen.add(m.id);
    if (m.created_at < last) ordered = false;
    last = m.created_at;
    const want = expected.get(m.id) ?? baseById.get(m.id);
    if (!want) extra++;
    else if (want.content !== m.content) mismatched++;
  }
  let missing = 0;
  for (const id of expected.keys()) if (!seen.has(id)) missing++;
  for (const id of baseById.keys()) if (!seen.has(id)) missing++;
  return {
    ok:
      duplicates === 0 &&
      missing === 0 &&
      mismatched === 0 &&
      extra === 0 &&
      ordered,
    duplicates,
    missing,
    mismatched,
    extra,
    ordered,
  };
}

/** Upper bound for `?blocks=`: enough to stress the reader, not to hang the tab. */
export const BUSY_MAX_BLOCKS = 100_000;

export function intParam(
  value: string | undefined,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : fallback;
}

function heapLabel(bytes: number | null): string {
  return bytes === null ? "n/a" : `${(bytes / 1_048_576).toFixed(1)} MiB`;
}

const OK_STATUS: KeyStatus = {
  loading: false,
  stale: false,
  partial: false,
  error: undefined,
  source: "server",
};

export const BusyFixture: Component = () => {
  const [search, setSearch] = useSearchParams<{
    a?: string;
    blocks?: string;
    seed?: string;
  }>();
  const blockCount = intParam(
    search.blocks,
    BUSY_DEFAULT_BLOCKS,
    BUSY_MAX_BLOCKS,
  );
  const seed = intParam(search.seed, BUSY_DEFAULT_SEED);

  const genStart = performance.now();
  const session = generateBusySession({ blocks: blockCount, seed });
  const generateMs = Math.round(performance.now() - genStart);
  const engine = new BusyStreamEngine(session.messages, seed);
  const metrics = new BusyMetrics();

  // The engine opens its streams on construction; start from that snapshot
  // so the first tick is a replacement, not a surprise append.
  const [messages, setMessages] = createSignal<TemporalMessage[]>(
    reconcile(session.messages, engine.snapshot()),
  );
  const [streaming, setStreaming] = createSignal(false);
  const [connected, setConnected] = createSignal(true);
  const [hidden, setHidden] = createSignal(false);
  const [cacheFails, setCacheFails] = createSignal(false);
  const [cacheFailures, setCacheFailures] = createSignal(0);
  const [report, setReport] = createSignal<MetricsReport | null>(null);
  const [verify, setVerify] = createSignal<VerifyReport | null>(null);
  const [applied, setApplied] = createSignal(0);
  const [received, setReceived] = createSignal(0);
  const [pendingCount, setPendingCount] = createSignal(0);

  // Coalesced pending events: one per message id, newest wins.
  const pending = new Map<string, BusyEvent>();
  let frame: number | null = null;
  let ticker: ReturnType<typeof setInterval> | undefined;

  function enqueue(events: readonly BusyEvent[]) {
    for (const e of events) {
      const prev = pending.get(e.message.id);
      pending.set(e.message.id, {
        kind: prev?.kind === "append" ? "append" : e.kind,
        message: e.message,
        payload: e.payload,
      });
      if (e.kind === "replace" && e.payload > 0) metrics.recordDelta(e.payload);
    }
    batch(() => {
      setReceived((n) => n + events.length);
      setPendingCount(pending.size);
    });
    scheduleApply();
  }

  function scheduleApply() {
    if (frame !== null || hidden() || !connected()) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      drain();
    });
  }

  function drain() {
    if (pending.size === 0) return;
    const started = performance.now();
    const queued = pending.size;
    const events = [...pending.values()];
    pending.clear();
    setMessages((prev) => applyEvents(prev, events));
    metrics.recordApply(performance.now() - started, queued);
    batch(() => {
      setApplied((n) => n + events.length);
      setPendingCount(0);
    });
    void cacheWrite();
  }

  /** The reader's IndexedDB write-through, simulated; failure is non-fatal. */
  async function cacheWrite() {
    await Promise.resolve();
    if (cacheFails()) {
      setCacheFailures((n) => n + 1);
      console.warn("cache write failed", new Error("fixture: quota exceeded"));
    }
  }

  function tick() {
    const events = engine.tick();
    if (connected()) enqueue(events);
  }

  function start() {
    if (ticker) return;
    setStreaming(true);
    metrics.start();
    ticker = setInterval(tick, 1000 / BUSY_DELTAS_PER_SECOND);
  }
  function stop() {
    clearInterval(ticker);
    ticker = undefined;
    setStreaming(false);
    setReport(metrics.report());
  }
  let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    clearInterval(ticker);
    clearTimeout(hiddenTimer);
    if (frame !== null) cancelAnimationFrame(frame);
    metrics.stop();
  });

  function burst(count: number) {
    const events = engine.burst(count);
    if (connected()) enqueue(events);
  }

  // Disconnect: live events are lost on the wire. Reconnect: refetch the
  // snapshot and reconcile by id; the stale variant reconciles with the
  // snapshot taken *at* disconnect, then lets live events catch up.
  let staleSnapshot: ReturnType<BusyStreamEngine["snapshot"]> | null = null;
  const [staleReconnect, setStaleReconnect] = createSignal(false);
  function disconnect() {
    staleSnapshot = engine.snapshot();
    pending.clear();
    setPendingCount(0);
    setConnected(false);
  }
  /**
   * A fresh snapshot converges by itself. A stale one (taken at disconnect)
   * cannot: messages created *and finished* while offline never re-appear
   * in the delta stream, so the reader stays honest about it (`stale`)
   * until `refetch()` reconciles with the server's current state.
   */
  function reconnect(useStale: boolean) {
    const snapshot =
      useStale && staleSnapshot ? staleSnapshot : engine.snapshot();
    batch(() => {
      setMessages((prev) => reconcile(prev, snapshot));
      setConnected(true);
      setStaleReconnect(useStale);
    });
    scheduleApply();
  }
  function refetch() {
    batch(() => {
      setMessages((prev) => reconcile(prev, engine.snapshot()));
      setStaleReconnect(false);
    });
  }

  onMount(() => {
    const onVisibility = () => {
      setHidden(document.visibilityState === "hidden");
      if (!hidden()) scheduleApply();
    };
    document.addEventListener("visibilitychange", onVisibility);
    onCleanup(() =>
      document.removeEventListener("visibilitychange", onVisibility),
    );
  });
  function simulateHidden() {
    setHidden(true);
    clearTimeout(hiddenTimer);
    hiddenTimer = setTimeout(() => {
      hiddenTimer = undefined;
      setHidden(false);
      scheduleApply();
    }, 2_000);
  }

  /** Edit the block the current `?a=` link points at (source-changed path). */
  function editLinked() {
    const decoded = decodeAnchor(search.a);
    const blockId = decoded?.anchor.blockId ?? "";
    if (!blockId.startsWith("m.")) return;
    setMessages((prev) => mutateMessage(prev, blockId.slice(2)));
  }

  function runVerify() {
    setVerify(verifyAgainst(messages(), session.messages, engine.expected()));
  }

  const status = createMemo<KeyStatus>(() => ({
    ...OK_STATUS,
    stale: !connected() || staleReconnect(),
  }));

  const streams = () => {
    applied();
    return engine.status();
  };

  const [mounted, setMounted] = createSignal(0);
  const countMounted = () =>
    setMounted(
      document.querySelectorAll('[data-testid="session-rows"] [data-row-key]')
        .length,
    );
  onMount(() => {
    countMounted();
    const timer = setInterval(countMounted, 500);
    onCleanup(() => clearInterval(timer));
  });

  const [snapshotReport, setSnapshotReport] = createSignal<string>("");
  function snapshotMetrics() {
    const r = metrics.report();
    setReport(r);
    countMounted();
    setSnapshotReport(
      JSON.stringify({
        ...r,
        blocks: messages().length,
        mounted: mounted(),
        generateMs,
        received: received(),
        applied: applied(),
        appended: engine.appendedCount,
        approvals: engine.approvals.length,
        streams: engine.status(),
      }),
    );
  }

  return (
    <div
      class="flex h-[calc(100dvh-62px)] min-h-0 flex-col"
      data-testid="busy-fixture"
      data-streaming={streaming() ? "true" : "false"}
    >
      <div class="max-h-[35dvh] shrink-0 overflow-y-auto border-b border-line px-5 py-3 sm:max-h-none sm:overflow-visible sm:px-7.5">
        <DocHeader
          crumb={["Fixture", "Busy session"]}
          title={`${session.messages.length.toLocaleString()} synthetic blocks · seed ${seed}`}
          trailing={`generated in ${generateMs} ms`}
        />
        <div class="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
          <Button
            size="sm"
            variant="outline"
            data-testid="busy-start"
            onClick={start}
            disabled={streaming()}
          >
            Stream ×{BUSY_STREAMS} @ {BUSY_DELTAS_PER_SECOND}/s
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="busy-stop"
            onClick={stop}
            disabled={!streaming()}
          >
            Stop
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="busy-burst"
            onClick={() => burst(1_000)}
          >
            Burst 1,000 events
          </Button>
          <Show
            when={connected()}
            fallback={
              <>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="busy-reconnect"
                  onClick={() => reconnect(false)}
                >
                  Reconnect (fresh snapshot)
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="busy-reconnect-stale"
                  onClick={() => reconnect(true)}
                >
                  Reconnect (stale snapshot)
                </Button>
              </>
            }
          >
            <Button
              size="sm"
              variant="outline"
              data-testid="busy-disconnect"
              onClick={disconnect}
            >
              Disconnect
            </Button>
          </Show>
          <Button
            size="sm"
            variant="outline"
            data-testid="busy-hide"
            onClick={simulateHidden}
            disabled={hidden()}
          >
            Hide tab 2 s
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="busy-cache-fail"
            aria-pressed={cacheFails() ? "true" : "false"}
            onClick={() => setCacheFails((v) => !v)}
          >
            {cacheFails() ? "Cache writes failing" : "Fail cache writes"}
          </Button>
          <Show when={staleReconnect()}>
            <Button
              size="sm"
              variant="outline"
              data-testid="busy-refetch"
              onClick={refetch}
            >
              Refetch snapshot
            </Button>
          </Show>
          <Button
            size="sm"
            variant="outline"
            data-testid="busy-edit-linked"
            onClick={editLinked}
            disabled={!search.a}
          >
            Edit linked block
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="busy-verify"
            onClick={runVerify}
          >
            Verify
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="busy-metrics"
            onClick={snapshotMetrics}
          >
            Metrics
          </Button>
        </div>
        <div
          class="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted"
          data-testid="busy-state"
        >
          <Badge
            variant={connected() ? "teal" : "danger"}
            data-testid="busy-connection"
          >
            {connected() ? "connected" : "disconnected"}
          </Badge>
          <Show when={hidden()}>
            <Badge variant="outline">tab hidden · queue coalescing</Badge>
          </Show>
          <Show when={staleReconnect()}>
            <Badge variant="outline" data-testid="busy-stale">
              reconciled with a stale snapshot · refetch pending
            </Badge>
          </Show>
          <span data-testid="busy-applied">
            applied {applied().toLocaleString()} of{" "}
            {received().toLocaleString()} events
          </span>
          <span data-testid="busy-pending">pending {pendingCount()}</span>
          <span data-testid="busy-mounted">mounted rows {mounted()}</span>
          <Show when={cacheFailures() > 0}>
            <span data-testid="busy-cache-failures">
              cache write failed ×{cacheFailures()} · reader unaffected
            </span>
          </Show>
          <For each={streams()}>
            {(s, i) => (
              <span data-testid="busy-stream">
                s{i() + 1} {s.phase}
              </span>
            )}
          </For>
          <Show when={verify()}>
            {(v) => (
              <Badge
                variant={v().ok ? "teal" : "danger"}
                data-testid="busy-verify-result"
                data-verify={v().ok ? "ok" : "mismatch"}
              >
                {v().ok
                  ? "verified: no lost, duplicated or reordered blocks"
                  : `mismatch: ${v().duplicates} dup · ${v().missing} missing · ${v().mismatched} changed · ${v().extra} extra${v().ordered ? "" : " · out of order"}`}
              </Badge>
            )}
          </Show>
        </div>
        <Show when={report()}>
          {(r) => (
            <dl
              class="mt-2 grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] text-muted sm:grid-cols-4"
              data-testid="busy-report"
            >
              <dt>input→paint p95</dt>
              <dd>{r().inputToPaintP95 ?? "n/a"} ms</dd>
              <dt>frame p95 / max</dt>
              <dd>
                {r().frames.p95?.toFixed(1) ?? "n/a"} /{" "}
                {r().frames.max?.toFixed(1) ?? "n/a"} ms
              </dd>
              <dt>long tasks (&gt;50 ms)</dt>
              <dd>
                {r().longTasks.count} · {r().longTasks.totalMs} ms · max{" "}
                {r().longTasks.maxMs ?? "n/a"} ms
              </dd>
              <dt>apply p95</dt>
              <dd>
                {r().apply.p95?.toFixed(2) ?? "n/a"} ms × {r().apply.count}
              </dd>
              <dt>queue high-water</dt>
              <dd>{r().queueHighWater}</dd>
              <dt>edit payloads</dt>
              <dd>
                {r().deltas.count.toLocaleString()} · {r().deltas.minChars}–
                {r().deltas.maxChars} chars
              </dd>
              <dt>heap used</dt>
              <dd>{heapLabel(r().heapUsedBytes)}</dd>
            </dl>
          )}
        </Show>
        <Show when={snapshotReport()}>
          <pre class="sr-only" data-testid="busy-report-json">
            {snapshotReport()}
          </pre>
        </Show>
      </div>
      <SessionView
        sessionId={BUSY_SESSION_ID}
        messages={messages()}
        distillations={session.distillations}
        messageCount={messages().length}
        hasOlder={false}
        status={status()}
        anchorParam={search.a ?? null}
        onAnchorChange={(encoded) =>
          setSearch({ a: encoded ?? undefined }, { replace: true })
        }
        linkBase={() => window.location.href}
        class="h-auto min-h-0 flex-1"
      />
    </div>
  );
};
