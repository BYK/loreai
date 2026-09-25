import type { GatewayRequest } from "./translate/types";

export interface BenchmarkTimingSample {
  requestId: string;
  decodeMs: number;
  postDecodeToUpstreamMs: number;
  outcome: "upstream" | "failure";
}

interface DecodeTiming {
  requestId: string;
  startedAt: number;
}

interface RequestTiming extends DecodeTiming {
  decodedAt: number;
}

const timings = new Map<string, RequestTiming>();
let observer: ((sample: BenchmarkTimingSample) => void) | null = null;
let failureObserver:
  | ((sample: {
      requestId: string;
      decodeMs: number;
      postDecodeToFailureMs: number;
    }) => void)
  | null = null;

/** Harness-only data-free observer. Production leaves this unset. */
export function setBenchmarkTimingObserver(
  next: ((sample: BenchmarkTimingSample) => void) | null,
): void {
  observer = next;
}

export function setBenchmarkFailureObserver(
  next:
    | ((sample: {
        requestId: string;
        decodeMs: number;
        postDecodeToFailureMs: number;
      }) => void)
    | null,
): void {
  failureObserver = next;
}

export function beginBenchmarkDecode(req: Request): DecodeTiming | undefined {
  if (!observer) return undefined;
  const requestId = req.headers.get("x-lore-benchmark-id");
  if (!requestId || !/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)) return undefined;
  return { requestId, startedAt: performance.now() };
}

export function finishBenchmarkDecode(
  request: GatewayRequest,
  timing: DecodeTiming | undefined,
): void {
  if (!timing || !observer) return;
  timings.set(timing.requestId, { ...timing, decodedAt: performance.now() });
}

export function observeBenchmarkUpstreamStart(request: GatewayRequest): void {
  const requestId = request.rawHeaders["x-lore-benchmark-id"];
  const timing = requestId ? timings.get(requestId) : undefined;
  if (!timing || !observer) return;
  const upstreamAt = performance.now();
  try {
    observer({
      requestId: timing.requestId,
      decodeMs: timing.decodedAt - timing.startedAt,
      postDecodeToUpstreamMs: upstreamAt - timing.decodedAt,
      outcome: "upstream",
    });
  } catch {
    // Benchmark observation never changes request delivery.
  }
}

export function clearBenchmarkTiming(request: GatewayRequest): void {
  const requestId = request.rawHeaders["x-lore-benchmark-id"];
  if (requestId) timings.delete(requestId);
}

export function observeBenchmarkFailure(
  request: GatewayRequest,
  _error: unknown,
): void {
  const requestId = request.rawHeaders["x-lore-benchmark-id"];
  const timing = requestId ? timings.get(requestId) : undefined;
  if (requestId) timings.delete(requestId);
  if (!timing || !failureObserver) return;
  try {
    failureObserver({
      requestId: timing.requestId,
      decodeMs: timing.decodedAt - timing.startedAt,
      postDecodeToFailureMs: performance.now() - timing.decodedAt,
    });
  } catch {
    // Benchmark observation never changes request delivery.
  }
}
