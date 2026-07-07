// Behavioral-signal trace extractor for the live counterfactual eval (#1402).
//
// Reads the per-turn `sessions/*.json` streams the driver already writes (an
// `opencode run --format json` event stream) and reconstructs the ordered list
// of model STEPS in the shape `degradation-signals.ts` consumes (`TraceStep`),
// so we can run the real 5-signal rot curve on an absolute-prompt-token axis and
// A/B the lore vs nolore arms behaviorally (not via judge composites).
//
// Event model (verified against captured streams):
//   step_start ... [tool_use | text]* ... step_finish
// A single STEP is the window between a `step_start` and its `step_finish`.
//   - `tool_use.part.tool`             -> tool name
//   - `tool_use.part.state.status`     -> "completed" | "error" | "pending"
//   - `tool_use.part.state.input`      -> tool input (target via extractFilePath/Command)
//   - `text.part.text`                 -> assistant text (self_correction regex)
//   - `step_finish.part.tokens`        -> { input, output, cache:{read,write} }
//     promptTokens = input + cache.read + cache.write  (prompt-side context size)
//
// Target derivation reuses the same helpers the gateway uses to record
// tool_calls provenance (#1424), so the eval's (tool,target) identity matches
// production exactly and retry/reread heuristics line up with the shared spec.

import fs from "node:fs";
import path from "node:path";

// Re-use the production target extractors (#1424, tool-trace.ts). Import from
// source so the eval never drifts from what the gateway records.
import { extractFilePath, extractCommand } from "../../src/tool-trace.ts";

/**
 * Derive the salient `(tool, target)` identity for a tool call. File tools →
 * their path; shell tools → the command string; everything else → null (so
 * retry/reread never fire on a targetless call — the safe direction).
 */
export function toolCallTarget(toolName, input) {
  const name = String(toolName || "").toLowerCase();
  const file = extractFilePath(input);
  if (file) return file;
  // bash/shell/exec → command identity
  if (
    name.includes("bash") ||
    name.includes("shell") ||
    name.includes("exec")
  ) {
    return extractCommand(input);
  }
  return null;
}

/**
 * Parse one `sessions/*.json` event stream into an ordered `TraceStep[]`.
 * A step accumulates every tool_use + text between a step_start and the next
 * step_finish; promptTokens comes from that step_finish.
 */
export function stepsFromStream(jsonlPath) {
  const raw = fs.existsSync(jsonlPath)
    ? fs.readFileSync(jsonlPath, "utf8")
    : "";
  const steps = [];
  // Current in-progress step accumulator. We open one lazily on the first
  // event of a step (step_start OR a stray tool_use/text before any start) and
  // flush it on step_finish.
  let cur = null;
  const open = () => {
    if (!cur) cur = { assistantText: "", toolCalls: [], promptTokens: 0 };
    return cur;
  };
  const flush = (promptTokens) => {
    const s = open();
    s.promptTokens = promptTokens;
    s.role = "assistant";
    steps.push({
      role: s.role,
      assistantText: s.assistantText || undefined,
      toolCalls: s.toolCalls,
      promptTokens: s.promptTokens,
    });
    cur = null;
  };

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const part = o.part || {};
    switch (o.type) {
      case "step_start":
        // A new step boundary. If a prior step never saw step_finish (rare
        // truncation), flush it with 0 tokens so its tool calls aren't lost.
        if (cur) flush(0);
        open();
        break;
      case "tool_use": {
        const state = part.state || {};
        const name = part.tool || part.name || "";
        open().toolCalls.push({
          name: String(name),
          target: toolCallTarget(name, state.input),
          isError: state.status === "error",
        });
        break;
      }
      case "text":
        open().assistantText += part.text || "";
        break;
      case "step_finish": {
        const t = part.tokens || {};
        const cache = t.cache || {};
        const promptTokens =
          (t.input || 0) + (cache.read || 0) + (cache.write || 0);
        flush(promptTokens);
        break;
      }
      default:
        break;
    }
  }
  // Flush a dangling step (stream ended without a final step_finish).
  if (cur && (cur.toolCalls.length > 0 || cur.assistantText)) flush(0);
  return steps;
}

/**
 * Collect all TraceSteps for a completed run directory, in session/turn order.
 * The driver writes `sessions/s{i}-{id}-t{j}.json` (and `s{i}-{id}.json` for
 * single-turn sessions); we sort lexicographically, which matches the numeric
 * session/turn ordering for the driver's zero-padded-free naming as long as we
 * sort by the (session-index, turn-index) parsed from the filename.
 */
export function stepsFromRun(runDir) {
  const dir = path.join(runDir, "sessions");
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    // Sort by (session index, turn index) parsed from `s{i}...-t{j}` / `s{i}-...`.
    .map((f) => {
      const sm = /^s(\d+)/.exec(f);
      const tm = /-t(\d+)/.exec(f) || /-(\d+)\.json$/.exec(f);
      return {
        f,
        si: sm ? Number(sm[1]) : 0,
        ti: tm ? Number(tm[1]) : 0,
      };
    })
    .sort((a, b) => a.si - b.si || a.ti - b.ti || a.f.localeCompare(b.f));
  const all = [];
  for (const { f } of files) {
    for (const step of stepsFromStream(path.join(dir, f))) all.push(step);
  }
  return all;
}
