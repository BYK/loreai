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
const boundedFetch: typeof fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await upstreamFetch(input, { ...init, redirect: "error" });
    if (!response.body) return response;
    let size = 0;
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          size += chunk.byteLength;
          if (size > 16_384) throw new Error("Response too large");
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
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
    const { data, error } = await client
      .from("profiles")
      .select("github_login, display_name, email")
      .eq("id", input.userId)
      .maybeSingle();
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
