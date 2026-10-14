// Real SDK + independent coordinator/SQLite connection, with network access
// restricted to the integration test's loopback auth server.
import { getAuthedClient, getCurrentUser } from "../../src/supabase";

const nativeFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== process.env.SUPABASE_URL)
    throw new Error("Unexpected remote request in account refresh test");
  return nativeFetch(input, init);
}) as typeof fetch;

process.send?.("ready");
await new Promise<void>((resolve) => process.once("message", () => resolve()));
const pending = getCurrentUser();
process.send?.("attempted");
const user = await pending;
if (!user) throw new Error("Test session could not be restored");
// A restore deadline must not become a lifetime deadline for the returned
// database client. Trigger it deterministically after authentication completes.
const timeout = AbortSignal.timeout;
const deadline = new AbortController();
AbortSignal.timeout = () => deadline.signal;
const client = await getAuthedClient();
AbortSignal.timeout = timeout;
deadline.abort();
if (!client) throw new Error("Missing restored test client");
const verification = await client.from("profiles").select("id");
if (verification.error)
  throw new Error("Restored client retained its authentication deadline");
console.log(JSON.stringify({ user_id: user.user_id }));
process.disconnect?.();
