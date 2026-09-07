import { createHash } from "node:crypto";
import { log } from "@loreai/core";
import { MAX_RECALL_DEPTH } from "./recall";

/** Request-local comparisons only. Fingerprints and recall content never leave this closure. */
export function createRecallDiagnostics(enabled = true) {
  const inputs = new Set<string>();
  const results = new Set<string>();
  const pairs = new Set<string>();
  const started = performance.now();
  let finished = false;
  let rounds = 0;
  let detailCalls = 0;
  let emptyBodies = 0;
  let resultBytes = 0;
  const fingerprint = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  return {
    record(
      input: { query: string; scope?: string; id?: string },
      result: string,
    ): void {
      if (!enabled || finished || rounds >= MAX_RECALL_DEPTH) return;
      rounds++;
      if (input.id) detailCalls++;
      if (!result.trim()) emptyBodies++;
      resultBytes += Buffer.byteLength(result);
      // ID lookup ignores query; scope stays part of the conservative comparison.
      const inputKey = fingerprint(
        JSON.stringify([
          input.scope ?? "all",
          input.id || null,
          input.id ? null : input.query.trim(),
        ]),
      );
      const resultKey = fingerprint(result);
      const pair = `${inputKey}:${resultKey}`;
      const repeatedInput = inputs.has(inputKey);
      const repeatedResult = results.has(resultKey);
      const repeatedPair = pairs.has(pair);
      inputs.add(inputKey);
      results.add(resultKey);
      pairs.add(pair);
      log.info(
        `recall-round ${JSON.stringify({ round: rounds, kind: input.id ? "detail" : "search", repeatedInput, repeatedResult, repeatedPair, resultBytes: Buffer.byteLength(result) })}`,
      );
    },
    finish(outcome: "completed" | "failed" | "aborted"): void {
      if (finished) return;
      finished = true;
      if (enabled && rounds > 0) {
        log.info(
          `recall-chain ${JSON.stringify({ outcome, rounds, detailCalls, repeatedInputs: rounds - inputs.size, repeatedResults: rounds - results.size, repeatedPairs: rounds - pairs.size, emptyBodies, resultBytes, elapsedMs: Math.min(300_000, Math.max(0, Math.round(performance.now() - started))) })}`,
        );
      }
      inputs.clear();
      results.clear();
      pairs.clear();
    },
  };
}
