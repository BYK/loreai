import {
  SourceCheckpoint,
  SourceDeltaUnavailableError,
} from "./source-checkpoint";
import * as Sentry from "@sentry/bun";
import {
  isToolPart,
  log,
  temporal,
  SemanticTokenCache,
  type LoreMessageWithParts,
} from "@loreai/core";
import { gatewayMessagesToLore, resolveToolResults } from "./temporal-adapter";
import { captureTurnTemporalInput } from "./turn-temporal";
import {
  findSpeculativeSource,
  rememberSpeculativeSource,
  SPECULATIVE_SOURCE_MAX_MESSAGES,
} from "./speculative-source";
import type { GatewayMessage, GatewayRequest } from "./translate/types";

type Stage =
  | "source_validation"
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
    log.info(
      "semantic-preparation",
      JSON.stringify({
        ...this.counts,
        stages: this.stages,
        observations: this.observations,
      }),
    );
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
  protocol?: string;
  checkpointProtocol?: string;
  /** Whether the raw protocol item seam is safe for a future suffix. */
  checkpointBoundarySafe?: boolean;
  forceFull?: boolean;
  signal?: AbortSignal;
  sourcePrefix?: {
    sourceCount: number;
    sourceDigest: string;
  };
}) {
  input.signal?.throwIfAborted();
  const { timing } = input;
  for (const key of Object.keys(timing.counts) as Array<
    keyof typeof timing.counts
  >)
    timing.counts[key] = 0;
  const started = performance.now();
  const cpu = process.cpuUsage();
  const memory = process.memoryUsage();
  if (input.sourcePrefix && (input.noStore || !input.protocol)) {
    throw new SourceDeltaUnavailableError(
      "A context suffix cannot be prepared without its retained Lore checkpoint; retrying with the full conversation.",
    );
  }
  const speculative =
    input.protocol && !input.noStore && !input.sourcePrefix && !input.forceFull
      ? findSpeculativeSource({
          sessionID: input.sessionID,
          projectPath: input.projectPath,
          protocol: input.checkpointProtocol ?? input.protocol,
          messages: input.messages,
        })
      : undefined;
  const checkpoint =
    input.protocol && !input.noStore
      ? new SourceCheckpoint({
          ...input,
          protocol: input.checkpointProtocol ?? input.protocol,
          boundarySafe: input.checkpointBoundarySafe,
          speculativePrefix: speculative
            ? {
                sourceCount: speculative.sourceCount,
                sourceDigest: speculative.sourceDigest,
              }
            : undefined,
        })
      : undefined;
  const reuse =
    speculative &&
    checkpoint?.verifiedSpeculativePrefix &&
    (checkpoint.reason === "hit" ||
      checkpoint.reason === "missing" ||
      ((checkpoint.reason === "history" ||
        checkpoint.reason === "protocol" ||
        checkpoint.reason === "tool_boundary") &&
        speculative.fallbackReason === checkpoint.reason &&
        !checkpoint.base &&
        speculative.offset === 0 &&
        speculative.raw.length === speculative.sourceCount)) &&
    speculative.sourceCount > checkpoint.convertedFrom &&
    speculative.offset === checkpoint.offset
      ? speculative
      : undefined;
  const tokenCache = new SemanticTokenCache({
    ...input,
    retainUnused: !!checkpoint?.base,
  });
  const convertedFrom =
    reuse?.sourceCount ??
    checkpoint?.convertedFrom ??
    input.sourcePrefix?.sourceCount ??
    0;
  const sourceCount =
    (input.sourcePrefix?.sourceCount ?? 0) + input.messages.length;
  const suffixMessages = input.sourcePrefix
    ? input.messages
    : input.messages.slice(convertedFrom);
  const suffixStart = input.sourcePrefix?.sourceCount ?? convertedFrom;
  const offset = checkpoint?.offset ?? 0;
  // An immediate queued before synchronous preparation observes its event-loop
  // delay. Await it before the next stage so LTM work cannot pollute the sample.
  // The callback retains just a timestamp, never the transcript.
  const loopDelay = new Promise<number>((resolve) =>
    setImmediate(() => resolve(performance.now() - started)),
  );
  const suffix = timing.measure("conversion", () =>
    gatewayMessagesToLore(
      suffixMessages,
      input.sessionID,
      suffixStart,
      suffixStart,
      (visible, provenance) => tokenCache.count(visible, provenance),
    ),
  );
  input.signal?.throwIfAborted();
  const raw = reuse
    ? [...reuse.raw, ...suffix]
    : checkpoint?.base
      ? [...checkpoint.base.raw, ...suffix]
      : suffix;
  const loreMessages = checkpoint ? structuredClone(raw) : raw;
  const temporalInput = timing.measure("temporal_input", () =>
    captureTurnTemporalInput(raw, sourceCount, checkpoint),
  );
  timing.metric("source_converted_messages", suffix.length);
  timing.metric("source_total_messages", sourceCount);
  if (reuse) timing.metric("source_speculative_jump", convertedFrom);
  const provenanceByMessageId = timing.measure("provenance", () => {
    const provenance = reuse
      ? new Map(reuse.provenance)
      : (checkpoint?.storedProvenance ?? new Map());
    for (const [id, value] of responsesProvenanceByMessageId(
      suffixMessages,
      suffix,
    ))
      provenance.set(id, value);
    return provenance;
  });
  const candidates: Array<{
    sourceID: string;
    legacySourceID?: string;
    legacySourceIDs?: readonly string[];
  }> = [];
  timing.counts.messages = loreMessages.length;
  for (const [index, message] of loreMessages.entries()) {
    input.signal?.throwIfAborted();
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
      timing.counts.placeholders++;
      if (index < convertedFrom - offset) continue;
      candidates.push({
        sourceID: message.info.id,
        legacySourceID: message.legacySourceID,
        legacySourceIDs: message.legacySourceIDs,
      });
    }
  }
  const newIds = timing.measure("stored_ids", () =>
    temporal.storedMessageIds({
      projectPath: input.projectPath,
      sessionID: input.sessionID,
      messages: candidates,
      readOnly: input.noStore,
    }),
  );
  input.signal?.throwIfAborted();
  const ids = reuse
    ? new Map(reuse.ids)
    : (checkpoint?.storedIds ?? new Map<string, string>());
  for (const [id, stored] of newIds) ids.set(id, stored);
  timing.measure("resolve_tools", () =>
    resolveToolResults(loreMessages, (m) => ids.get(m.info.id) ?? m.info.id),
  );
  checkpoint?.capture(raw, loreMessages, ids, provenanceByMessageId);
  input.signal?.throwIfAborted();
  if (
    checkpoint &&
    !input.sourcePrefix &&
    !input.noStore &&
    raw.length >= 64 &&
    raw.length <= SPECULATIVE_SOURCE_MAX_MESSAGES
  ) {
    rememberSpeculativeSource(input.sessionID, {
      projectPath: input.projectPath,
      protocol: input.checkpointProtocol ?? input.protocol!,
      sourceCount,
      sourceDigest: checkpoint.digest,
      fallbackReason: checkpoint.reason,
      lastMessageID: raw.at(-1)!.info.id,
      offset: checkpoint.offset,
      raw,
      ids,
      provenance: provenanceByMessageId,
    });
  }
  // Publish before yielding; cache writes never wait for another writer.
  tokenCache.persist();
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
  for (const [name, value] of Object.entries(tokenCache.stats))
    timing.metric(`provenance_tokens_${name}`, value);
  return {
    loreMessages,
    temporalInput,
    provenanceByMessageId,
    sourceWindow: checkpoint?.sourceWindow,
    checkpoint,
  };
}
