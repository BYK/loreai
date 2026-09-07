import { it, expect } from "vitest";
import { close, db, ensureProject, saveSessionTracking } from "@loreai/core";
import { createHash } from "node:crypto";
import {
  PreparationTiming,
  prepareSemanticMessages,
} from "../src/semantic-preparation";
import { loreMessagesToGateway } from "../src/pipeline";
import { semanticHistory } from "./fixtures/semantic-history";

it.skipIf(process.env.LORE_TOKEN_BENCHMARK !== "1")(
  "measures realistic encrypted provenance across cold, warm, and reopened requests",
  async () => {
    const scope = {
      projectPath: "/test/semantic-token-benchmark",
      sessionID: "benchmark-session",
    };
    ensureProject(scope.projectPath);
    saveSessionTracking(scope.sessionID, {});
    const request = semanticHistory(5580, 4096);
    let baseline: string | undefined;
    for (const mode of [
      "uncached",
      "populate",
      "warm",
      "restart",
      "append",
    ] as const) {
      if (mode === "restart") close();
      const input = mode === "append" ? semanticHistory(5582, 4096) : request;
      const timing = new PreparationTiming(input);
      const started = performance.now();
      const prepared = await prepareSemanticMessages({
        ...scope,
        messages: input.messages,
        noStore: mode === "uncached",
        timing,
      });
      timing.upstreamStart();
      const elapsed = performance.now() - started;
      const wire = loreMessagesToGateway(
        prepared.loreMessages,
        prepared.provenanceByMessageId,
        true,
      );
      const hash = createHash("sha256")
        .update(JSON.stringify(wire))
        .digest("hex");
      if (mode === "uncached") baseline = hash;
      else if (mode !== "append") expect(hash).toBe(baseline);
      if (mode === "warm" || mode === "restart")
        expect(timing.observations.provenance_tokens_misses).toBe(0);
      if (mode === "append")
        expect(timing.observations.provenance_tokens_misses).toBe(1);
      process.stdout.write(
        JSON.stringify({
          mode,
          sourceMessages: input.messages.length,
          elapsed,
          stages: timing.stages,
          observations: timing.observations,
          wireHash: hash,
          cacheBytes: (
            db()
              .query(
                "SELECT COALESCE(SUM(length(payload)), 0) AS n FROM semantic_token_cache",
              )
              .get() as { n: number }
          ).n,
        }) + "\n",
      );
    }
  },
);
