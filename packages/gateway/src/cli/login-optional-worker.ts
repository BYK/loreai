import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { PersistedSession } from "../supabase";

type OptionalWork =
  | { kind: "profile" }
  | { kind: "provision"; providerToken: string };
export type OptionalResult =
  | {
      kind: "profile";
      profile: Pick<
        PersistedSession,
        "email" | "github_login" | "display_name"
      >;
    }
  | { kind: "provision"; teams: number };

const MAX_WORKERS = 16;
const DEADLINE_MS = 30_000;
let activeWorkers = 0;

/** Keep the worker owned until exit, even if its termination is delayed. */
export async function runOptionalLoginWorker(
  session: PersistedSession,
  work: OptionalWork,
  revision: string,
): Promise<OptionalResult | undefined> {
  if (activeWorkers >= MAX_WORKERS) return undefined;
  try {
    const embedded = (globalThis as Record<string, unknown>)
      .__LORE_LOGIN_WORKER_SOURCE__;
    const workerData = { revision, userId: session.user_id, work };
    // SEA assets live in memory, npm ships an adjacent CJS worker, and the
    // source checkout runs its TypeScript entry with the development loader.
    // The bundled worker loads the account SDK and database; 64 MiB can exhaust
    // V8's old generation during startup even for a successful profile request.
    const options = {
      execArgv: [],
      workerData,
      stdout: true,
      stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    };
    const worker =
      typeof embedded === "string"
        ? new Worker(embedded, { ...options, eval: true })
        : (() => {
            const bundled = fileURLToPath(
              new URL("./login-optional-task.cjs", import.meta.url),
            );
            if (existsSync(bundled)) return new Worker(bundled, options);
            const source = fileURLToPath(
              new URL("./login-optional-task.ts", import.meta.url),
            );
            return new Worker(
              `require(${JSON.stringify(createRequire(import.meta.url).resolve("tsx/cjs"))}); require(${JSON.stringify(source)});`,
              {
                ...options,
                eval: true,
                // Resolve workspace dependencies to source. Otherwise tsx must
                // transform the full built core barrel on a cold cache, which
                // can exhaust this worker's heap and abort the enclosing process.
                execArgv: ["--conditions=development"],
                resourceLimits: { maxOldGenerationSizeMb: 256 },
              },
            );
          })();
    worker.stdout.resume();
    worker.stderr.resume();
    activeWorkers++;
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (result?: OptionalResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Termination can itself stall. Unref keeps a stuck worker from pinning
        // the CLI; its slot remains owned until the worker actually exits.
        worker.unref();
        void worker.terminate().catch(() => {});
        resolve(result);
      };
      const timer = setTimeout(() => finish(), DEADLINE_MS);
      worker.once("message", (message: OptionalResult) => {
        if (message?.kind === work.kind) finish(message);
        else finish();
      });
      worker.once("error", () => finish());
      worker.once("exit", () => {
        activeWorkers--;
        finish();
      });
    });
  } catch {
    return undefined;
  }
}
