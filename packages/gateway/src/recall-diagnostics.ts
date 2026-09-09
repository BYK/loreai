import { createHash } from "node:crypto";
import { log, type RecallCoverage } from "@loreai/core";

/** Keep request-local diagnostic state bounded while observing chains beyond ten rounds. */
export const MAX_RECALL_DIAGNOSTIC_ROUNDS = 64;

/** Request-local comparisons only. Fingerprints and recall content never leave this closure. */
export function createRecallDiagnostics(enabled = true) {
  const inputs = new Set<string>();
  const results = new Set<string>();
  const pairs = new Set<string>();
  const coverage = new Set<string>();
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
      input: { query: string; scope?: string; id?: string; ids?: string[] },
      result: string,
      deliveredCoverage: readonly RecallCoverage[] = [],
    ): void {
      if (!enabled || finished || rounds >= MAX_RECALL_DIAGNOSTIC_ROUNDS)
        return;
      rounds++;
      if (input.id) detailCalls++;
      else if (input.ids) detailCalls += input.ids.length;
      if (!result.trim()) emptyBodies++;
      resultBytes += Buffer.byteLength(result);
      // ID lookup ignores query; scope stays part of the conservative comparison.
      const inputKey = fingerprint(
        JSON.stringify([
          input.scope ?? "all",
          input.id || input.ids || null,
          input.id || input.ids ? null : input.query.trim(),
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
      const coverageProgress = deliveredCoverage.some((item) => {
        if (item.length <= 0) return false;
        const key = fingerprint(
          `${item.identity}\u0000${item.revision}\u0000${item.kind ?? "detail"}\u0000${item.offset}\u0000${item.length}`,
        );
        if (coverage.has(key)) return false;
        coverage.add(key);
        return true;
      });
      log.info(
        `recall-round ${JSON.stringify({ round: rounds, kind: input.id || input.ids ? "detail" : "search", repeatedInput, repeatedResult, repeatedPair, coverageProgress, resultBytes: Buffer.byteLength(result) })}`,
      );
    },
    finish(outcome: "completed" | "failed" | "aborted"): void {
      if (finished) return;
      finished = true;
      if (enabled && rounds > 0) {
        log.info(
          `recall-chain ${JSON.stringify({ outcome, rounds, detailCalls, repeatedInputs: rounds - inputs.size, repeatedResults: rounds - results.size, repeatedPairs: rounds - pairs.size, emptyBodies, resultBytes, coverageItems: coverage.size, elapsedMs: Math.min(300_000, Math.max(0, Math.round(performance.now() - started))) })}`,
        );
      }
      inputs.clear();
      results.clear();
      pairs.clear();
      coverage.clear();
    },
  };
}
