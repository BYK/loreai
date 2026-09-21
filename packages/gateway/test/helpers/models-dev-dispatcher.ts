import type { Dispatcher } from "undici";

export const CANNED_MODELS_DEV = Object.freeze({
  anthropic: {
    models: {
      "claude-opus-4-6": {
        id: "claude-opus-4-6",
        cost: { input: 5, output: 25, cache_read: 0.5 },
        limit: { context: 1_000_000, output: 128_000 },
      },
      "claude-sonnet-4-20250514": {
        id: "claude-sonnet-4-20250514",
        cost: { input: 3, output: 15, cache_read: 0.3 },
        limit: { context: 200_000, output: 64_000 },
      },
      "claude-sonnet-4-6": {
        id: "claude-sonnet-4-6",
        cost: { input: 3, output: 15, cache_read: 0.3 },
        limit: { context: 1_000_000, output: 128_000 },
      },
      "claude-haiku-4-5": {
        id: "claude-haiku-4-5",
        cost: { input: 1, output: 5, cache_read: 0.1 },
        limit: { context: 200_000, output: 64_000 },
      },
      "offline-isolation-model": {
        id: "offline-isolation-model",
        cost: { input: 2, output: 10, cache_read: 0.2 },
        limit: { context: 300_000, output: 32_000 },
      },
    },
  },
  openai: {
    models: {
      "gpt-4o-mini": {
        id: "gpt-4o-mini",
        cost: { input: 0.15, output: 0.6, cache_read: 0.075 },
        limit: { context: 128_000, output: 16_384 },
      },
      "gpt-5.4-mini": {
        id: "gpt-5.4-mini",
        cost: { input: 0.75, output: 4.5, cache_read: 0.19 },
        limit: { context: 400_000, output: 100_000 },
      },
    },
  },
});

let requestCount = 0;
let dispatcher: Dispatcher | undefined;
let mockAgent: InstanceType<(typeof import("undici"))["MockAgent"]> | undefined;
let previousDispatcher: Dispatcher | null = null;
let installationCount = 0;

export async function installOfflineModelsDevDispatcher(): Promise<void> {
  if (dispatcher) {
    installationCount++;
    return;
  }

  {
    const { MockAgent } = await import("undici");
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    mockAgent
      .get("https://models.dev")
      .intercept({ path: "/api.json", method: "GET" })
      .reply(() => {
        requestCount++;
        return {
          statusCode: 200,
          data: JSON.stringify(CANNED_MODELS_DEV),
          responseOptions: { headers: { "content-type": "application/json" } },
        };
      })
      .persist();
    dispatcher = mockAgent;
    const { setUpstreamDispatcherForTest } = await import("../../src/fetch");
    previousDispatcher = setUpstreamDispatcherForTest(dispatcher);
    installationCount = 1;
  }
}

export async function uninstallOfflineModelsDevDispatcher(): Promise<void> {
  if (installationCount > 1) {
    installationCount--;
    return;
  }
  installationCount = 0;
  const activeDispatcher = dispatcher;
  const activeMockAgent = mockAgent;
  const restoreDispatcher = previousDispatcher;
  dispatcher = undefined;
  mockAgent = undefined;
  previousDispatcher = null;

  if (activeDispatcher) {
    const { restoreUpstreamDispatcherForTest } =
      await import("../../src/fetch");
    restoreUpstreamDispatcherForTest(activeDispatcher, restoreDispatcher);
  }
  await activeMockAgent?.close();
}

export function offlineModelsDevResponse(
  input: RequestInfo | URL,
  init?: RequestInit,
): Response | undefined {
  const url = input instanceof Request ? input.url : String(input);
  const method =
    init?.method ?? (input instanceof Request ? input.method : "GET");
  if (url !== "https://models.dev/api.json" || method.toUpperCase() !== "GET") {
    return undefined;
  }

  requestCount++;
  return Response.json(CANNED_MODELS_DEV);
}

export function resetOfflineModelsDevRequestCount(): void {
  requestCount = 0;
}

export function offlineModelsDevRequestCount(): number {
  return requestCount;
}
