import { parentPort, workerData } from "node:worker_threads";
import {
  accountDataClient,
  captureLoginRevision,
  loadPersistedSession,
} from "../supabase";

type Work = { kind: "profile" } | { kind: "provision"; providerToken: string };

const input = workerData as { revision: string; userId: string; work: Work };

// Bound every upstream body, including SDK token-refresh responses, without
// exposing response contents outside this worker.
const upstreamFetch = globalThis.fetch;
const unavailable = () =>
  Response.json({ msg: "Account service unavailable" }, { status: 499 });
const boundedFetch: typeof fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await upstreamFetch(input, { ...init, redirect: "error" });
    if (!response.body) return response;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let complete = false;
    try {
      // Finish the bounded read before handing the response to the SDK. A
      // streaming read error is otherwise treated as a retryable Auth transport
      // failure, triggering repeated refresh requests.
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          complete = true;
          break;
        }
        size += value.byteLength;
        if (size > 16_384) return unavailable();
        if (value.byteLength) chunks.push(value);
      }
      return new Response(Buffer.concat(chunks), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch {
      return unavailable();
    } finally {
      // The worker retains its admission slot if cancellation stalls; its parent
      // can still terminate it at the existing whole-operation deadline.
      if (!complete) await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  },
  { preconnect: upstreamFetch.preconnect },
);
globalThis.fetch = boundedFetch;

// Run the existing cross-process refresh coordinator inside the terminable
// worker. The account client rechecks revision and user immediately before
// supplying credentials to each SDK request.
async function run(): Promise<void> {
  const session = loadPersistedSession();
  if (
    !session ||
    session.user_id !== input.userId ||
    captureLoginRevision() !== input.revision
  ) {
    return;
  }
  const client = accountDataClient(
    input.revision,
    session,
    () => new AbortController().signal,
  );
  if (input.work.kind === "profile") {
    // Credential acquisition runs before boundedFetch. This best-effort GET
    // must not turn a failed coordinated refresh into repeated auth requests.
    const { data, error } = await client
      .from("profiles")
      .select("github_login, display_name, email")
      .eq("id", input.userId)
      .maybeSingle()
      .retry(false);
    if (error || !data) return;
    const profile: Record<string, string | null> = {};
    for (const field of ["email", "github_login", "display_name"] as const) {
      if (data[field] === null || typeof data[field] === "string")
        profile[field] = data[field];
    }
    parentPort?.postMessage({ kind: "profile", profile });
  } else {
    const { data, error, response } = await client.functions.invoke(
      "github-provision",
      {
        body: { provider_token: input.work.providerToken },
      },
    );
    if (response?.body && !response.bodyUsed)
      await response.body.cancel().catch(() => {});
    if (!error && Number.isSafeInteger(data?.teams) && data.teams > 0)
      parentPort?.postMessage({ kind: "provision", teams: data.teams });
  }
}

void run()
  .catch(() => {})
  .finally(() => parentPort?.postMessage({ kind: "done" }));
