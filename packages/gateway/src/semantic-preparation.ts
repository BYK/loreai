import * as Sentry from "@sentry/bun";
import {
  isToolPart,
  log,
  temporal,
  type LoreMessageWithParts,
} from "@loreai/core";
import { gatewayMessagesToLore, resolveToolResults } from "./temporal-adapter";
import { captureTurnTemporalInput } from "./turn-temporal";
import type { GatewayMessage, GatewayRequest } from "./translate/types";

type Stage =
  | "conversion"
  | "provenance"
  | "temporal_input"
  | "stored_ids"
  | "resolve_tools"
  | "semantic_total"
  | "turn_to_upstream";
export interface StageTiming {
  wallMs: number;
  cpuMs: number;
}

/** Only fixed stage/protocol labels and numeric measurements leave this module. */
export class PreparationTiming {
  readonly stages: Partial<Record<Stage, StageTiming>> = {};
  readonly observations: Record<string, number> = {};
  readonly counts = {
    messages: 0,
    parts: 0,
    toolUses: 0,
    toolResults: 0,
    placeholders: 0,
  };
  private readonly started = performance.now();
  private readonly cpu = process.cpuUsage();
  private readonly attributes: {
    protocol: string;
    codex: boolean;
    streaming: boolean;
  };
  constructor(request: Pick<GatewayRequest, "protocol" | "codex" | "stream">) {
    this.attributes = {
      protocol: request.protocol,
      codex: request.codex === true,
      streaming: request.stream,
    };
  }
  measure<T>(stage: Stage, fn: () => T): T {
    const started = performance.now();
    const cpu = process.cpuUsage();
    let span: Sentry.Span | undefined;
    try {
      span = Sentry.startInactiveSpan({
        name: stage,
        op: "lore.semantic.prepare",
        attributes: this.attributes,
      });
    } catch {
      /* telemetry is best effort */
    }
    try {
      return fn();
    } finally {
      const delta = process.cpuUsage(cpu);
      this.record(stage, {
        wallMs: performance.now() - started,
        cpuMs: (delta.user + delta.system) / 1000,
      });
      try {
        span?.end();
      } catch {
        /* telemetry is best effort */
      }
    }
  }
  record(stage: Stage, timing: StageTiming): void {
    this.stages[stage] = timing;
    this.metric("wall_ms", timing.wallMs, stage);
    this.metric("cpu_ms", timing.cpuMs, stage);
  }
  metric(name: string, value: number, stage?: Stage): void {
    if (!stage) this.observations[name] = value;
    try {
      if (Sentry.isInitialized())
        Sentry.metrics.distribution(`lore.preparation.${name}`, value, {
          ...(name.endsWith("_ms") ? { unit: "millisecond" } : {}),
          attributes: { ...this.attributes, ...(stage ? { stage } : {}) },
        });
    } catch {
      /* observability must never fail a turn */
    }
  }
  upstreamStart(): void {
    const delta = process.cpuUsage(this.cpu);
    this.record("turn_to_upstream", {
      wallMs: performance.now() - this.started,
      cpuMs: (delta.user + delta.system) / 1000,
    });
    log.info("semantic-preparation", { ...this.counts, stages: this.stages });
  }
}

/** Request-only Responses provenance; never copied into temporal storage. */
export function responsesProvenanceByMessageId(
  messages: GatewayMessage[],
  loreMessages: LoreMessageWithParts[],
): ReadonlyMap<
  string,
  Pick<GatewayMessage, "content" | "provenanceContent" | "provenancePositions">
> {
  const result = new Map<
    string,
    Pick<
      GatewayMessage,
      "content" | "provenanceContent" | "provenancePositions"
    >
  >();
  for (let i = 0; i < loreMessages.length; i++) {
    const original = messages[i];
    if (original?.provenanceContent)
      result.set(loreMessages[i].info.id, {
        content: original.content,
        provenanceContent: original.provenanceContent,
        provenancePositions: original.provenancePositions,
      });
  }
  return result;
}

/** Convert once, snapshot the storage boundary, and resolve placeholders in batches. */
export async function prepareSemanticMessages(input: {
  messages: GatewayMessage[];
  sessionID: string;
  projectPath: string;
  noStore: boolean;
  timing: PreparationTiming;
}) {
  const { timing } = input;
  const started = performance.now();
  const cpu = process.cpuUsage();
  const memory = process.memoryUsage();
  // An immediate queued before synchronous preparation observes its event-loop
  // delay. Await it before the next stage so LTM work cannot pollute the sample.
  // The callback retains just a timestamp, never the transcript.
  const loopDelay = new Promise<number>((resolve) =>
    setImmediate(() => resolve(performance.now() - started)),
  );
  const loreMessages = timing.measure("conversion", () =>
    gatewayMessagesToLore(input.messages, input.sessionID),
  );
  const temporalInput = timing.measure("temporal_input", () =>
    captureTurnTemporalInput(loreMessages),
  );
  const provenanceByMessageId = timing.measure("provenance", () =>
    responsesProvenanceByMessageId(input.messages, loreMessages),
  );
  const candidates: Array<{ sourceID: string; legacySourceID?: string }> = [];
  timing.counts.messages = loreMessages.length;
  for (const message of loreMessages) {
    timing.counts.parts += message.parts.length;
    let results = 0;
    for (const part of message.parts)
      if (isToolPart(part)) {
        if (part.tool === "result") {
          results++;
          timing.counts.toolResults++;
        } else timing.counts.toolUses++;
      }
    if (
      message.info.role === "user" &&
      results > 0 &&
      results === message.parts.length
    ) {
      candidates.push({
        sourceID: message.info.id,
        legacySourceID: message.legacySourceID,
      });
    }
  }
  timing.counts.placeholders = candidates.length;
  const ids = timing.measure("stored_ids", () =>
    temporal.storedMessageIds({
      projectPath: input.projectPath,
      sessionID: input.sessionID,
      messages: candidates,
      readOnly: input.noStore,
    }),
  );
  timing.measure("resolve_tools", () =>
    resolveToolResults(loreMessages, (m) => ids.get(m.info.id) ?? m.info.id),
  );
  const delta = process.cpuUsage(cpu);
  timing.record("semantic_total", {
    wallMs: performance.now() - started,
    cpuMs: (delta.user + delta.system) / 1000,
  });
  const after = process.memoryUsage();
  timing.metric("rss_delta_bytes", after.rss - memory.rss);
  timing.metric("heap_delta_bytes", after.heapUsed - memory.heapUsed);
  for (const [name, count] of Object.entries(timing.counts))
    timing.metric(name, count);
  timing.metric("stored_id_resolutions", candidates.length);
  timing.metric("event_loop_delay_ms", await loopDelay);
  return { loreMessages, temporalInput, provenanceByMessageId };
}
