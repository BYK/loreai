/**
 * Anthropic SSE stream handling.
 *
 * Parses upstream Anthropic streaming responses (named SSE events), accumulates
 * the full response into a `GatewayResponse`, and provides helpers for
 * generating synthetic SSE event sequences (e.g. for compaction interception).
 *
 * Anthropic uses named SSE events with a lifecycle:
 *   message_start -> content_block_start/delta/stop (repeated) -> message_delta -> message_stop
 *
 * All functions are pure (no side effects) except `parseSSEStream` which is
 * an async generator consuming a byte stream.
 */
import {
  ZERO_USAGE,
  type GatewayContentBlock,
  type GatewayResponse,
  type GatewayUsage,
} from "../translate/types";
import {
  DEFAULT_MAX_REPORTED_USAGE,
  estimateTokens,
  scaleUsageForClient,
} from "../compaction";
import {
  ANTHROPIC_CONTENT_BLOCK_TYPES,
  ANTHROPIC_STOP_REASONS,
  normalizeAnthropicStopReason,
  toAnthropicStopReason,
} from "../anthropic-protocol";
import { isRecord, validateAnthropicUsage } from "../usage-validation";
// NOTE: `estimateTokens` re-exported from `compaction.ts` is now the BPE-backed
// helper from @loreai/core (see packages/core/src/tokenize.ts), no longer the
// legacy length/4 heuristic.

// ---------------------------------------------------------------------------
// SSE formatting
// ---------------------------------------------------------------------------

/** Format a single named SSE event for sending to the client. */
export function formatSSEEvent(eventType: string, data: string): string {
  return `event: ${eventType}\ndata: ${data}\n\n`;
}

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

type StreamChunkRead = Awaited<
  ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>
>;

/**
 * Foreground and worker SSE streams share this finite frame ceiling. The byte
 * ceilings bound retained data, while this independently bounds parser work for
 * tiny frames (including blank and comment-only frames).
 */
export const DEFAULT_MAX_SSE_FRAMES = 100_000;

/** A post-header transport failure while reading an SSE response body. */
export class SSEStreamTransportError extends Error {
  readonly kind: "inactivity" | "read";

  constructor(
    kind: "inactivity" | "read",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SSEStreamTransportError";
    this.kind = kind;
  }
}

/** Deterministic local stream limits must never be reclassified as transport. */
export class SSEStreamLimitError extends Error {}

/** Read one stream chunk while making abort and inactivity independently fatal. */
export async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  opts: { signal?: AbortSignal; inactivityMs?: number } = {},
): Promise<StreamChunkRead> {
  opts.signal?.throwIfAborted();
  const reads: Array<Promise<StreamChunkRead>> = [
    reader.read().catch((error: unknown) => {
      opts.signal?.throwIfAborted();
      if (error instanceof SSEStreamLimitError) throw error;
      throw new SSEStreamTransportError("read", "SSE stream read failed", {
        cause: error,
      });
    }),
  ];
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  let inactivityError: Error | undefined;
  let onAbort: (() => void) | undefined;

  if (opts.signal) {
    const signal = opts.signal;
    reads.push(
      new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          void reader.cancel(signal.reason).catch(() => {});
          try {
            signal.throwIfAborted();
          } catch (error) {
            reject(error);
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    );
  }

  if (opts.inactivityMs) {
    reads.push(
      new Promise<never>((_resolve, reject) => {
        inactivityTimer = setTimeout(() => {
          inactivityError = new SSEStreamTransportError(
            "inactivity",
            "SSE stream inactivity deadline exceeded",
          );
          void reader.cancel(inactivityError).catch(() => {});
          reject(inactivityError);
        }, opts.inactivityMs);
      }),
    );
  }

  try {
    const result = await Promise.race(reads);
    if (inactivityError) throw inactivityError;
    opts.signal?.throwIfAborted();
    return result;
  } finally {
    if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
    if (inactivityTimer) clearTimeout(inactivityTimer);
  }
}

/**
 * Parse an SSE byte stream into typed events.
 *
 * Handles:
 *  - `event: <type>` followed by `data: <json>`
 *  - Multiple `data:` lines (joined with `\n`)
 *  - Blank lines as event delimiters
 *  - Default event type `"message"` when no `event:` line precedes data
 */
export async function* parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  opts: {
    maxEventBytes?: number;
    maxFrames?: number;
    frameCounter?: { count: number };
    inactivityMs?: number;
    signal?: AbortSignal;
    requireEventTerminator?: boolean;
    maxTotalBytes?: number;
    fatalUtf8?: boolean;
  } = {},
): AsyncGenerator<{ event: string; data: string }> {
  // Expose BOM code points to the parser; `stripInitialBom` below owns removal
  // and byte accounting exactly once, including split transport chunks.
  const decoder = new TextDecoder("utf-8", {
    fatal: opts.fatalUtf8,
    ignoreBOM: true,
  });
  let bufferParts: string[] = [];
  let delimiterScanTail = "";
  let initialBytes: number[] = [];
  let initialBytesResolved = false;
  let bufferedBytes = 0;
  const maxEventBytes = opts.maxEventBytes ?? 4 * 1024 * 1024;
  const maxFrames = opts.maxFrames ?? DEFAULT_MAX_SSE_FRAMES;
  const frameCounter = opts.frameCounter ?? { count: 0 };
  let totalBytes = 0;
  const delimiterPattern =
    "(?:\\r\\n|(?<!\\r)\\n|\\r(?!\\n))(?:\\r\\n|(?<!\\r)\\n|\\r(?!\\n))";

  const appendDecoded = (text: string): boolean => {
    if (!text) return false;
    bufferParts.push(text);
    const scan = delimiterScanTail + text;
    const found = new RegExp(delimiterPattern).test(scan);
    // The longest delimiter is four characters, so retaining three detects
    // every delimiter completed by the next transport chunk without rescanning
    // the accumulated event.
    delimiterScanTail = scan.slice(-3);
    return found;
  };

  if (!Number.isSafeInteger(maxFrames) || maxFrames < 0) {
    throw new Error("SSE frame limit must be a non-negative safe integer");
  }

  const countFrame = (): void => {
    frameCounter.count++;
    if (frameCounter.count > maxFrames) {
      throw new SSEStreamLimitError(
        `SSE stream exceeded ${maxFrames} frame limit`,
      );
    }
  };

  const stripInitialBom = (
    value: Uint8Array | undefined,
    done: boolean,
  ): Uint8Array | undefined => {
    if (initialBytesResolved) return value;
    let offset = 0;
    while (value && offset < value.byteLength && initialBytes.length < 3) {
      initialBytes.push(value[offset++]);
      if (
        initialBytes[0] !== 0xef ||
        (initialBytes.length >= 2 && initialBytes[1] !== 0xbb)
      ) {
        break;
      }
    }
    if (initialBytes.length === 0 && !done) return undefined;
    const isBom =
      initialBytes.length === 3 &&
      initialBytes[0] === 0xef &&
      initialBytes[1] === 0xbb &&
      initialBytes[2] === 0xbf;
    const prefixMismatch =
      initialBytes[0] !== 0xef ||
      (initialBytes.length >= 2 && initialBytes[1] !== 0xbb) ||
      (initialBytes.length >= 3 && !isBom);
    if (!isBom && !prefixMismatch && !done) return undefined;

    initialBytesResolved = true;
    const prefix = isBom ? new Uint8Array() : Uint8Array.from(initialBytes);
    initialBytes = [];
    const suffix = value?.subarray(offset) ?? new Uint8Array();
    if (prefix.byteLength === 0) return suffix;
    if (suffix.byteLength === 0) return prefix;
    const combined = new Uint8Array(prefix.byteLength + suffix.byteLength);
    combined.set(prefix);
    combined.set(suffix, prefix.byteLength);
    return combined;
  };

  for (;;) {
    const { done, value } = await readStreamChunk(reader, {
      signal: opts.signal,
      inactivityMs: opts.inactivityMs,
    });
    const payload = stripInitialBom(value, done);
    let shouldProcess = false;
    if (payload && payload.byteLength > 0) {
      totalBytes += payload.byteLength;
      if (totalBytes > (opts.maxTotalBytes ?? Number.POSITIVE_INFINITY)) {
        throw new SSEStreamLimitError(
          "SSE stream exceeded aggregate byte limit",
        );
      }
      bufferedBytes += payload.byteLength;
      try {
        shouldProcess = appendDecoded(
          decoder.decode(payload, { stream: true }),
        );
      } catch {
        throw new Error("malformed SSE UTF-8");
      }
    }
    if (done) {
      try {
        shouldProcess = appendDecoded(decoder.decode()) || shouldProcess;
      } catch {
        throw new Error("malformed SSE UTF-8");
      }
    }
    if (shouldProcess) {
      // Join only when a complete event exists. An attacker fragmenting one
      // unterminated event into tiny chunks therefore cannot force repeated
      // copies and full-prefix delimiter scans.
      const buffer = bufferParts.join("");
      const delimiter = new RegExp(delimiterPattern, "g");
      let consumedChars = 0;
      let consumedBytes = 0;
      for (;;) {
        delimiter.lastIndex = consumedChars;
        const boundary = delimiter.exec(buffer);
        if (!boundary) break;
        const block = buffer.slice(consumedChars, boundary.index);
        // Every delimiter consumes parser work, even when its block is blank or
        // comment-only and therefore yields no event to the caller.
        countFrame();
        const blockBytes = Buffer.byteLength(block);
        if (blockBytes > maxEventBytes) {
          throw new SSEStreamLimitError(
            `SSE event exceeded ${maxEventBytes} byte limit`,
          );
        }
        consumedChars = boundary.index + boundary[0].length;
        consumedBytes += blockBytes + boundary[0].length;

        // Skip empty blocks
        if (block.trim() === "") continue;

        let eventType = "message";
        const dataLines: string[] = [];

        for (const line of block.split(/\r\n|\r|\n/)) {
          if (line.startsWith("event:")) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart());
          }
          // Lines starting with ':' are comments — ignore
          // Other lines without known prefix — ignore per SSE spec
        }

        if (dataLines.length > 0) {
          yield { event: eventType, data: dataLines.join("\n") };
        }
      }
      if (consumedChars > 0) {
        const remaining = buffer.slice(consumedChars);
        bufferParts = remaining ? [remaining] : [];
        delimiterScanTail = remaining.slice(-3);
        bufferedBytes -= consumedBytes;
      }
    }

    if (bufferedBytes > maxEventBytes) {
      throw new SSEStreamLimitError(
        `SSE event exceeded ${maxEventBytes} byte limit`,
      );
    }

    if (done) {
      const buffer = bufferParts.join("");
      // Flush any remaining partial block (shouldn't happen with well-formed SSE)
      if (buffer.trim()) {
        countFrame();
        if (opts.requireEventTerminator) {
          throw new Error("unterminated SSE event at EOF");
        }
        let eventType = "message";
        const dataLines: string[] = [];
        for (const line of buffer.split(/\r\n|\r|\n/)) {
          if (line.startsWith("event:")) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart());
          }
        }
        if (dataLines.length > 0) {
          yield { event: eventType, data: dataLines.join("\n") };
        }
      }
      break;
    }
  }
}

/** Cancel without awaiting hostile sources, and release the reader lock safely. */
export function cancelAndReleaseReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason?: unknown,
): void {
  let cancellation: Promise<void>;
  try {
    cancellation = reader.cancel(reason).catch(() => {});
  } catch {
    cancellation = Promise.resolve();
  }
  const release = (): void => {
    try {
      reader.releaseLock();
    } catch {
      // A runtime may keep a raced read pending until cancellation settles.
    }
  };
  release();
  void cancellation.finally(release).catch(() => {});
}

// ---------------------------------------------------------------------------
// Stream accumulator
// ---------------------------------------------------------------------------

/** Intermediate block state during streaming. */
type AccumulatingBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "tool_use"; id: string; name: string; partialJson: string };

/** State machine that processes Anthropic SSE events and builds a GatewayResponse. */
export interface StreamAccumulator {
  /** Process a single SSE event. Returns the event line(s) to forward to client. */
  processEvent(eventType: string, data: string): string;
  /** Get the accumulated response after stream ends. */
  getResponse(): GatewayResponse;
  /** Whether the stream has completed (message_stop received). */
  isDone(): boolean;
}

/**
 * Scale the `usage` block of a terminal `message_delta` for the client.
 *
 * Anthropic's `message_delta` carries the FULL cumulative usage (input + cache
 * + output), not just `output_tokens`. We scale every field it carries so the
 * client's last-write-wins total stays under the cap. The delta's own fields
 * are authoritative for the scale basis (falling back to the internally
 * accumulated values only when a field is absent), so the basis can never
 * under-count and re-leak a raw, unscaled value. We never write back a raw
 * delta value — only the scaled result (0 if the scaler dropped the field).
 */
export function scaleMessageDeltaUsage(
  deltaUsage: Record<string, number>,
  accumulated: {
    inputTokens: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  },
  maxReportedUsage: number,
): Record<string, number> {
  const basisInput =
    typeof deltaUsage.input_tokens === "number"
      ? deltaUsage.input_tokens
      : accumulated.inputTokens;
  const basisCacheRead =
    typeof deltaUsage.cache_read_input_tokens === "number"
      ? deltaUsage.cache_read_input_tokens
      : accumulated.cacheReadInputTokens;
  const basisCacheCreation =
    typeof deltaUsage.cache_creation_input_tokens === "number"
      ? deltaUsage.cache_creation_input_tokens
      : accumulated.cacheCreationInputTokens;

  const scaled = scaleUsageForClient(
    {
      input_tokens: basisInput,
      output_tokens: deltaUsage.output_tokens,
      cache_read_input_tokens: basisCacheRead,
      cache_creation_input_tokens: basisCacheCreation,
    },
    maxReportedUsage,
  );

  const newUsage: Record<string, number> = {
    ...deltaUsage,
    output_tokens: scaled.output_tokens,
  };
  if (typeof deltaUsage.input_tokens === "number") {
    newUsage.input_tokens = scaled.input_tokens;
  }
  if (typeof deltaUsage.cache_read_input_tokens === "number") {
    newUsage.cache_read_input_tokens = scaled.cache_read_input_tokens ?? 0;
  }
  if (typeof deltaUsage.cache_creation_input_tokens === "number") {
    newUsage.cache_creation_input_tokens =
      scaled.cache_creation_input_tokens ?? 0;
  }
  return newUsage;
}

export function createStreamAccumulator(options?: {
  /** When true, scale usage fields in client-facing SSE events so Claude Code's
   *  auto-compact threshold is never reached.  Internal accumulation is unaffected. */
  scaleClientUsage?: boolean;
  /** Per-model usage cap (from `maxReportedUsageForModel`). Defaults to the
   *  200K-model cap when unknown. */
  maxReportedUsage?: number;
}): StreamAccumulator {
  const shouldScale = options?.scaleClientUsage ?? false;
  const maxReportedUsage =
    options?.maxReportedUsage ?? DEFAULT_MAX_REPORTED_USAGE;

  let id = "";
  let model = "";
  let stopReason = "";
  let done = false;

  const usage: GatewayUsage = {
    inputTokens: 0,
    outputTokens: 0,
  };

  /** Blocks indexed by their stream index. */
  const blocks = new Map<number, AccumulatingBlock>();
  /** Finalized content blocks in order. */
  const content: GatewayContentBlock[] = [];
  /** Track which indices have been finalized. */
  const finalized = new Set<number>();

  /**
   * Rewrite usage fields in a `message_start` or `message_delta` SSE event
   * payload so the client sees scaled token counts.  Returns the modified
   * JSON string, or `null` if no rewrite was needed.
   */
  function rewriteUsage(
    parsed: Record<string, unknown>,
    eventType: string,
  ): string | null {
    if (!shouldScale) return null;

    if (eventType === "message_start") {
      const message = parsed.message as Record<string, unknown> | undefined;
      const msgUsage = message?.usage as Record<string, number> | undefined;
      if (!msgUsage) return null;

      const scaled = scaleUsageForClient(
        {
          input_tokens: msgUsage.input_tokens ?? 0,
          output_tokens: msgUsage.output_tokens ?? 0,
          cache_read_input_tokens: msgUsage.cache_read_input_tokens,
          cache_creation_input_tokens: msgUsage.cache_creation_input_tokens,
        },
        maxReportedUsage,
      );
      // Only rewrite if scaling actually changed something
      if (scaled === msgUsage) return null;

      const rewritten = {
        ...parsed,
        message: { ...message, usage: { ...msgUsage, ...scaled } },
      };
      return JSON.stringify(rewritten);
    }

    if (eventType === "message_delta") {
      const deltaUsage = parsed.usage as Record<string, number> | undefined;
      if (!deltaUsage || typeof deltaUsage.output_tokens !== "number")
        return null;

      // See scaleMessageDeltaUsage: the terminal message_delta carries the full
      // cumulative usage, so scale every field it carries (client usage is
      // last-write-wins) using the delta's own values as the authoritative basis.
      const newUsage = scaleMessageDeltaUsage(
        deltaUsage,
        {
          inputTokens: usage.inputTokens,
          cacheReadInputTokens: usage.cacheReadInputTokens,
          cacheCreationInputTokens: usage.cacheCreationInputTokens,
        },
        maxReportedUsage,
      );
      return JSON.stringify({ ...parsed, usage: newUsage });
    }

    return null;
  }

  function processEvent(eventType: string, data: string): string {
    // Parse the data payload — if it's not valid JSON, just forward as-is
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return formatSSEEvent(eventType, data);
    }

    // Accumulate real values internally (always unscaled)
    switch (eventType) {
      case "message_start":
        handleMessageStart(parsed);
        break;
      case "content_block_start":
        handleContentBlockStart(parsed);
        break;
      case "content_block_delta":
        handleContentBlockDelta(parsed);
        break;
      case "content_block_stop":
        handleContentBlockStop(parsed);
        break;
      case "message_delta":
        handleMessageDelta(parsed);
        break;
      case "message_stop":
        done = true;
        break;
      // "ping" and unknown events — just forward
    }

    // Rewrite usage in client-facing events when scaling is active
    const rewritten = rewriteUsage(parsed, eventType);
    if (rewritten) return formatSSEEvent(eventType, rewritten);

    return formatSSEEvent(eventType, data);
  }

  function handleMessageStart(parsed: Record<string, unknown>): void {
    const message = parsed.message as Record<string, unknown> | undefined;
    if (!message) return;

    if (typeof message.id === "string") id = message.id;
    if (typeof message.model === "string") model = message.model;

    const msgUsage = message.usage as Record<string, number> | undefined;
    if (msgUsage) {
      if (typeof msgUsage.input_tokens === "number") {
        usage.inputTokens = msgUsage.input_tokens;
      }
      if (typeof msgUsage.output_tokens === "number") {
        usage.outputTokens = msgUsage.output_tokens;
      }
      if (typeof msgUsage.cache_read_input_tokens === "number") {
        usage.cacheReadInputTokens = msgUsage.cache_read_input_tokens;
      }
      if (typeof msgUsage.cache_creation_input_tokens === "number") {
        usage.cacheCreationInputTokens = msgUsage.cache_creation_input_tokens;
      }
    }
  }

  function handleContentBlockStart(parsed: Record<string, unknown>): void {
    const index = parsed.index as number;
    if (typeof index !== "number") return;

    const block = parsed.content_block as Record<string, unknown> | undefined;
    if (!block || typeof block.type !== "string") return;

    switch (block.type) {
      case "text":
        blocks.set(index, {
          type: "text",
          text: typeof block.text === "string" ? block.text : "",
        });
        break;
      case "thinking":
        blocks.set(index, {
          type: "thinking",
          thinking: typeof block.thinking === "string" ? block.thinking : "",
          signature: "",
        });
        break;
      case "tool_use":
        blocks.set(index, {
          type: "tool_use",
          id: typeof block.id === "string" ? block.id : "",
          name: typeof block.name === "string" ? block.name : "",
          partialJson: "",
        });
        break;
    }
  }

  function handleContentBlockDelta(parsed: Record<string, unknown>): void {
    const index = parsed.index as number;
    if (typeof index !== "number") return;

    const delta = parsed.delta as Record<string, unknown> | undefined;
    if (!delta || typeof delta.type !== "string") return;

    const block = blocks.get(index);
    if (!block) return;

    switch (delta.type) {
      case "text_delta":
        if (block.type === "text" && typeof delta.text === "string") {
          block.text += delta.text;
        }
        break;
      case "thinking_delta":
        if (block.type === "thinking" && typeof delta.thinking === "string") {
          block.thinking += delta.thinking;
        }
        break;
      case "signature_delta":
        if (block.type === "thinking" && typeof delta.signature === "string") {
          block.signature += delta.signature;
        }
        break;
      case "input_json_delta":
        if (
          block.type === "tool_use" &&
          typeof delta.partial_json === "string"
        ) {
          block.partialJson += delta.partial_json;
        }
        break;
    }
  }

  function handleContentBlockStop(parsed: Record<string, unknown>): void {
    const index = parsed.index as number;
    if (typeof index !== "number") return;

    const block = blocks.get(index);
    if (!block || finalized.has(index)) return;

    finalized.add(index);

    switch (block.type) {
      case "text":
        content.push({ type: "text", text: block.text });
        break;
      case "thinking": {
        const thinkingBlock: GatewayContentBlock = {
          type: "thinking",
          thinking: block.thinking,
        };
        if (block.signature) {
          (thinkingBlock as { signature?: string }).signature = block.signature;
        }
        content.push(thinkingBlock);
        break;
      }
      case "tool_use": {
        let input: unknown = {};
        if (block.partialJson) {
          try {
            input = JSON.parse(block.partialJson);
          } catch {
            // Malformed JSON — store as raw string
            input = block.partialJson;
          }
        }
        content.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input,
        });
        break;
      }
    }
  }

  function handleMessageDelta(parsed: Record<string, unknown>): void {
    const delta = parsed.delta as Record<string, unknown> | undefined;
    if (delta && typeof delta.stop_reason === "string") {
      stopReason = normalizeAnthropicStopReason(delta.stop_reason);
    }

    // message_delta usage is cumulative output tokens
    const deltaUsage = parsed.usage as Record<string, number> | undefined;
    if (deltaUsage) {
      if (typeof deltaUsage.output_tokens === "number") {
        usage.outputTokens = deltaUsage.output_tokens;
      }
    }
  }

  function getResponse(): GatewayResponse {
    // Finalize any blocks that weren't explicitly stopped (shouldn't happen
    // with well-formed streams, but be defensive)
    for (const [index, block] of blocks) {
      if (!finalized.has(index)) {
        finalized.add(index);
        switch (block.type) {
          case "text":
            content.push({ type: "text", text: block.text });
            break;
          case "thinking":
            content.push({
              type: "thinking",
              thinking: block.thinking,
              ...(block.signature ? { signature: block.signature } : {}),
            });
            break;
          case "tool_use": {
            let input: unknown = {};
            if (block.partialJson) {
              try {
                input = JSON.parse(block.partialJson);
              } catch {
                input = block.partialJson;
              }
            }
            content.push({
              type: "tool_use",
              id: block.id,
              name: block.name,
              input,
            });
            break;
          }
        }
      }
    }

    return {
      id,
      model,
      content,
      stopReason,
      usage: { ...usage },
    };
  }

  return {
    processEvent,
    getResponse,
    isDone: () => done,
  };
}

// ---------------------------------------------------------------------------
// Synthetic SSE builders
// ---------------------------------------------------------------------------

/**
 * Build a synthetic `message_start` SSE event from a GatewayResponse.
 *
 * Used when the gateway generates its own response (e.g. compaction
 * interception) and needs to emit a well-formed Anthropic stream.
 */
export function buildSSEMessageStart(response: GatewayResponse): string {
  const u = response.usage ?? ZERO_USAGE;
  const message = {
    type: "message_start",
    message: {
      id: response.id,
      type: "message",
      role: "assistant",
      content: [],
      model: response.model,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: u.inputTokens,
        output_tokens: 1,
        ...(u.cacheReadInputTokens != null
          ? { cache_read_input_tokens: u.cacheReadInputTokens }
          : {}),
        ...(u.cacheCreationInputTokens != null
          ? {
              cache_creation_input_tokens: u.cacheCreationInputTokens,
            }
          : {}),
      },
    },
  };

  return formatSSEEvent("message_start", JSON.stringify(message));
}

/**
 * Build a complete SSE event sequence for a simple text-only response.
 *
 * Generates the full Anthropic streaming lifecycle:
 *   message_start -> content_block_start -> content_block_delta ->
 *   content_block_stop -> message_delta -> message_stop
 *
 * Used for compaction interception where Lore generates a synthetic
 * response instead of forwarding to upstream.
 */
export function buildSSETextResponse(
  id: string,
  model: string,
  text: string,
  usage: { inputTokens: number; outputTokens: number },
): string {
  const events: string[] = [];

  // message_start
  events.push(
    formatSSEEvent(
      "message_start",
      JSON.stringify({
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: usage.inputTokens,
            output_tokens: 1,
          },
        },
      }),
    ),
  );

  // content_block_start
  events.push(
    formatSSEEvent(
      "content_block_start",
      JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
    ),
  );

  // content_block_delta — full text in one delta
  events.push(
    formatSSEEvent(
      "content_block_delta",
      JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      }),
    ),
  );

  // content_block_stop
  events.push(
    formatSSEEvent(
      "content_block_stop",
      JSON.stringify({
        type: "content_block_stop",
        index: 0,
      }),
    ),
  );

  // message_delta
  events.push(
    formatSSEEvent(
      "message_delta",
      JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: usage.outputTokens },
      }),
    ),
  );

  // message_stop
  events.push(
    formatSSEEvent("message_stop", JSON.stringify({ type: "message_stop" })),
  );

  return events.join("");
}

/**
 * Build a complete Anthropic SSE event sequence for a SYNTHETIC standalone
 * recall-marker message.
 *
 * Purpose: when a client speaks Anthropic SSE natively, the streaming recall
 * marker (e.g. `📚 Searching lore for "X"…`) is emitted as its OWN
 * `message_start`/`message_stop` envelope — so the client renders the marker
 * as a distinct assistant message in its transcript instead of an inline
 * reply block sitting next to the model's preamble text. The Anthropic SDK
 * (and Claude Code) treats each `message_start`/`message_stop` envelope as
 * a separate assistant turn for transcript rendering, even though all the
 * envelopes land in the same HTTP response stream.
 *
 * The synthetic message id MUST differ from the upstream message id so the
 * client's transcript row is distinct from any real model response.
 *
 * Lifecycle:
 *   message_start -> content_block_start -> content_block_delta ->
 *     content_block_stop -> message_delta -> message_stop
 *
 * Output token count is 1 (matches the `output_tokens: 1` convention used by
 * `buildSSEMessageStart` so clients that meter on `output_tokens` see a
 * consistent minimal value for synthetic messages).
 */
export function buildSSEMarkerMessage(
  messageId: string,
  model: string,
  markerText: string,
): string {
  const events: string[] = [];

  // message_start
  events.push(
    formatSSEEvent(
      "message_start",
      JSON.stringify({
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            output_tokens: 1,
          },
        },
      }),
    ),
  );

  // content_block_start
  events.push(
    formatSSEEvent(
      "content_block_start",
      JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
    ),
  );

  // content_block_delta — full marker text in one delta
  events.push(
    formatSSEEvent(
      "content_block_delta",
      JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: markerText },
      }),
    ),
  );

  // content_block_stop
  events.push(
    formatSSEEvent(
      "content_block_stop",
      JSON.stringify({
        type: "content_block_stop",
        index: 0,
      }),
    ),
  );

  // message_delta — end_turn because the marker is a complete, single-block message
  events.push(
    formatSSEEvent(
      "message_delta",
      JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      }),
    ),
  );

  // message_stop
  events.push(
    formatSSEEvent("message_stop", JSON.stringify({ type: "message_stop" })),
  );

  return events.join("");
}

/**
 * Build a complete Anthropic SSE event sequence from a fully-accumulated
 * `GatewayResponse`, preserving ALL content blocks — text, thinking, tool_use,
 * and opaque (image/etc.) — not just text.
 *
 * Used when the gateway has BUFFERED a non-Anthropic upstream response
 * (OpenAI / Responses / Gemini, which are accumulated rather than streamed
 * through) for an Anthropic-protocol client that requested `stream: true`.
 * The client's SDK opened the request expecting `text/event-stream`; handing it
 * a non-streaming JSON body leaves it waiting forever with no output — exactly
 * the "response reaches the gateway but never makes it to the UI" symptom for
 * GitHub Copilot + a Claude model via OpenCode's Anthropic SDK (#1052).
 *
 * Emits the full lifecycle, one block at a time:
 *   message_start
 *   → (content_block_start → content_block_delta* → content_block_stop) per block
 *   → message_delta → message_stop
 *
 * Unlike `buildSSETextResponse` (text-only, for synthetic single-string
 * responses) this must not drop tool_use blocks — a coding agent whose turn is
 * a tool call would otherwise receive an empty stream.
 */
export function buildSSEResponse(resp: GatewayResponse): string {
  const events: string[] = [buildSSEMessageStart(resp)];

  resp.content.forEach((block: GatewayContentBlock, index: number) => {
    let contentBlock: Record<string, unknown>;
    const deltas: Record<string, unknown>[] = [];

    switch (block.type) {
      case "text":
        contentBlock = { type: "text", text: "" };
        deltas.push({ type: "text_delta", text: block.text });
        break;
      case "thinking":
        contentBlock = { type: "thinking", thinking: "" };
        deltas.push({ type: "thinking_delta", thinking: block.thinking });
        if (block.signature != null) {
          deltas.push({ type: "signature_delta", signature: block.signature });
        }
        break;
      case "tool_use":
        contentBlock = {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: {},
        };
        // The full arguments object is delivered as one input_json_delta — the
        // accumulator on the other side concatenates partial_json then parses.
        deltas.push({
          type: "input_json_delta",
          partial_json: JSON.stringify(block.input ?? {}),
        });
        break;
      case "opaque":
        // Best-effort: re-emit the original block verbatim as a single-shot
        // start (no delta). Rare in a response; better than dropping.
        contentBlock = block.raw;
        break;
      default:
        // tool_result never appears in an assistant response.
        return;
    }

    events.push(
      formatSSEEvent(
        "content_block_start",
        JSON.stringify({
          type: "content_block_start",
          index,
          content_block: contentBlock,
        }),
      ),
    );
    for (const delta of deltas) {
      events.push(
        formatSSEEvent(
          "content_block_delta",
          JSON.stringify({ type: "content_block_delta", index, delta }),
        ),
      );
    }
    events.push(
      formatSSEEvent(
        "content_block_stop",
        JSON.stringify({ type: "content_block_stop", index }),
      ),
    );
  });

  const u = resp.usage ?? ZERO_USAGE;
  events.push(
    formatSSEEvent(
      "message_delta",
      JSON.stringify({
        type: "message_delta",
        delta: {
          stop_reason: toAnthropicStopReason(resp.stopReason ?? "end_turn"),
          stop_sequence: null,
        },
        usage: { output_tokens: u.outputTokens },
      }),
    ),
  );
  events.push(
    formatSSEEvent("message_stop", JSON.stringify({ type: "message_stop" })),
  );

  return events.join("");
}

/**
 * Build a *live* compaction SSE `Response` that emits keep-alive `ping` events
 * while `summaryPromise` is still pending, then streams the summary text once
 * it resolves.
 *
 * This lets the gateway hold the client connection open during a long
 * compaction wait (e.g. urgent distillation of the remainder riding out a 429)
 * without the client hitting a read-timeout. `ping` is a first-class event in
 * Anthropic's streaming protocol — clients (and our openai/openai-responses
 * translators) skip it — so the heartbeats are protocol-safe.
 *
 * The event lifecycle is always well-formed:
 *   message_start → content_block_start → ping* → content_block_delta →
 *   content_block_stop → message_delta → message_stop
 *
 * If `summaryPromise` resolves to `null` (nothing to compact) or rejects, an
 * empty assistant turn is emitted so the stream still terminates cleanly.
 */
export function buildKeepaliveCompactionStream(
  id: string,
  model: string,
  summaryPromise: Promise<string | null>,
  pingMs: number,
): Response {
  const enc = new TextEncoder();
  const messageStart = buildSSEMessageStart({
    id,
    model,
    content: [],
    stopReason: "end_turn",
    usage: ZERO_USAGE,
  });

  let pingTimer: ReturnType<typeof setInterval> | null = null;
  const clearPing = () => {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (s: string) => {
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          // Controller already closed (client disconnected) — ignore.
        }
      };

      emit(messageStart);
      emit(
        formatSSEEvent(
          "content_block_start",
          JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          }),
        ),
      );

      pingTimer = setInterval(() => {
        emit(formatSSEEvent("ping", JSON.stringify({ type: "ping" })));
      }, pingMs);

      let text: string;
      try {
        text = (await summaryPromise) ?? "";
      } catch (e) {
        // The summary genuinely failed (e.g. a DB error mid-compaction). Do
        // NOT emit a normal `message_stop` — a complete-but-empty turn would
        // be treated by the client as a *successful* empty compaction and wipe
        // its context. Instead, error the stream: the truncated SSE (no
        // message_stop) signals failure, so the client keeps its history and
        // can retry. (A null/empty *resolution* below is different — that means
        // there is genuinely nothing to compact, for which an empty turn is
        // correct.)
        clearPing();
        try {
          controller.error(e instanceof Error ? e : new Error(String(e)));
        } catch {
          // Controller already closed (client disconnected) — nothing to do.
        }
        return;
      }
      clearPing();

      emit(
        formatSSEEvent(
          "content_block_delta",
          JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text },
          }),
        ),
      );
      emit(
        formatSSEEvent(
          "content_block_stop",
          JSON.stringify({ type: "content_block_stop", index: 0 }),
        ),
      );
      emit(
        formatSSEEvent(
          "message_delta",
          JSON.stringify({
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            // NOTE: `estimateTokens` here uses the default cl100k_base
            // encoding, NOT the `claude` encoding — `compaction.estimateTokens`
            // is provider-agnostic by design (avoids dragging a provider param
            // through the SSE fabrication path). For Anthropic traffic this
            // undercounts by ~10–30% vs. the real Claude tokenizer. The
            // fabricated number is only consumed client-side by Claude Code's
            // auto-compaction heuristics (it does NOT bill the upstream
            // provider), so being in the right order of magnitude is enough.
            // If accurate Anthropic fabrication becomes important, thread the
            // active provider through here and call `coreEstimateTokens(text,
            // { providerID: "anthropic", modelID })`.
            usage: { output_tokens: estimateTokens(text) },
          }),
        ),
      );
      emit(
        formatSSEEvent(
          "message_stop",
          JSON.stringify({ type: "message_stop" }),
        ),
      );
      controller.close();
    },
    cancel() {
      clearPing();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

/**
 * Build a complete SSE event sequence for a synthetic tool_use response.
 *
 * Generates the full Anthropic streaming lifecycle for a single tool_use block
 * with `stop_reason: "tool_use"`:
 *   message_start -> content_block_start (tool_use) -> content_block_delta
 *   (input_json_delta) -> content_block_stop -> message_delta -> message_stop
 *
 * Used by the synthetic-tool primitive to short-circuit the first turn and
 * return a gateway-generated tool_use that the client harness must execute.
 */
export function buildSSEToolUseResponse(
  id: string,
  model: string,
  toolUse: { id: string; name: string; input: unknown },
): string {
  const events: string[] = [];

  // message_start
  events.push(
    formatSSEEvent(
      "message_start",
      JSON.stringify({
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 1 },
        },
      }),
    ),
  );

  // content_block_start — tool_use (input starts empty)
  events.push(
    formatSSEEvent(
      "content_block_start",
      JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: toolUse.id,
          name: toolUse.name,
          input: {},
        },
      }),
    ),
  );

  // content_block_delta — full input in one delta
  events.push(
    formatSSEEvent(
      "content_block_delta",
      JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(toolUse.input),
        },
      }),
    ),
  );

  // content_block_stop
  events.push(
    formatSSEEvent(
      "content_block_stop",
      JSON.stringify({
        type: "content_block_stop",
        index: 0,
      }),
    ),
  );

  // message_delta — stop_reason is "tool_use"
  events.push(
    formatSSEEvent(
      "message_delta",
      JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 0 },
      }),
    ),
  );

  // message_stop
  events.push(
    formatSSEEvent("message_stop", JSON.stringify({ type: "message_stop" })),
  );

  return events.join("");
}

// ---------------------------------------------------------------------------
// Recall-aware stream accumulator
// ---------------------------------------------------------------------------

/**
 * Extended accumulator interface with recall-aware filtering.
 *
 * Wraps the standard `StreamAccumulator` and adds:
 *  - Suppression of recall tool_use blocks (not forwarded to client)
 *  - Re-indexing of subsequent blocks to maintain contiguity
 *  - Detection of which recall case (only vs mixed) applies
 *  - Access to the suppressed recall block data
 *
 * For events targeting a suppressed (recall) block, `processEvent` returns
 * an empty string (nothing to forward). For all other events, it returns
 * the SSE text to forward — with adjusted block indices if needed.
 *
 * Also holds back `message_delta` and `message_stop` events when recall is
 * detected, so the caller can decide whether to forward them (Case 2) or
 * replace them with the continuation stream (Case 1).
 */
export interface RecallAwareAccumulator extends StreamAccumulator {
  /** Whether a recall tool_use block was detected in the stream. */
  hasRecall(): boolean;
  /** Whether non-recall tool_use blocks exist in the stream. */
  hasOtherTools(): boolean;
  /** The upstream block index at which recall was first detected. */
  recallBlockIndex(): number;
  /** Number of non-suppressed content blocks forwarded to the client. */
  clientBlockCount(): number;
  /** The held-back message_delta + message_stop events (SSE text). */
  heldBackEvents(): string;
  /**
   * Atomically return the held-back events AND clear the held-back buffer
   * so subsequent calls return "" — prevents double-emission when multiple
   * branches in the caller (e.g. marker-emission seam + mixed-tools
   * terminal-close branch) both want to forward the close events.
   */
  takeHeldBackEvents(): string;
}

/**
 * Create a recall-aware stream accumulator.
 *
 * @param recallToolName - The name of the recall tool to intercept (default: "recall")
 * @param options.scaleClientUsage - Scale usage numbers for the client (anti-compaction)
 * @param options.maxReportedUsage - Per-model usage cap (from `maxReportedUsageForModel`)
 * @param options.blockOffset - Added to all emitted block indices (for continuation streams
 *   that must continue the client's block numbering from where a previous stream left off)
 * @param options.suppressMessageStart - Suppress message_start events (continuation streams
 *   where the client already received one from the original stream)
 */
export function createRecallAwareAccumulator(
  recallToolName = "recall",
  options?: {
    scaleClientUsage?: boolean;
    maxReportedUsage?: number;
    blockOffset?: number;
    suppressMessageStart?: boolean;
  },
): RecallAwareAccumulator {
  const shouldScale = options?.scaleClientUsage ?? false;
  const maxReportedUsage =
    options?.maxReportedUsage ?? DEFAULT_MAX_REPORTED_USAGE;
  const baseOffset = options?.blockOffset ?? 0;
  const suppressMsgStart = options?.suppressMessageStart ?? false;
  // Delegate to the standard accumulator for actual accumulation (never scales — internal only)
  const inner = createStreamAccumulator();

  /** Set of upstream block indices that are suppressed (recall). */
  const suppressedIndices = new Set<number>();
  /** Tracks other tool_use block indices (non-recall). */
  const otherToolIndices = new Set<number>();
  /** Number of suppressed blocks seen so far (for re-indexing). */
  let suppressedCount = 0;
  /** First suppressed block index (for continuation re-indexing). */
  let firstSuppressedIndex = -1;
  /** Total client-visible blocks forwarded. */
  let clientBlocks = 0;
  /** Held-back message_delta + message_stop SSE text. */
  let heldBack = "";
  /** Whether we've detected recall in this stream. */
  let recallDetected = false;

  /** Scale usage in a parsed SSE event and return the rewritten JSON, or null if unchanged. */
  function maybeScaleEvent(
    parsed: Record<string, unknown>,
    eventType: string,
  ): string | null {
    if (!shouldScale) return null;

    if (eventType === "message_start") {
      const message = parsed.message as Record<string, unknown> | undefined;
      const msgUsage = message?.usage as Record<string, number> | undefined;
      if (!msgUsage) return null;
      const scaled = scaleUsageForClient(
        {
          input_tokens: msgUsage.input_tokens ?? 0,
          output_tokens: msgUsage.output_tokens ?? 0,
          cache_read_input_tokens: msgUsage.cache_read_input_tokens,
          cache_creation_input_tokens: msgUsage.cache_creation_input_tokens,
        },
        maxReportedUsage,
      );
      if (scaled === msgUsage) return null;
      return JSON.stringify({
        ...parsed,
        message: { ...message, usage: { ...msgUsage, ...scaled } },
      });
    }

    if (eventType === "message_delta") {
      const deltaUsage = parsed.usage as Record<string, number> | undefined;
      if (!deltaUsage || typeof deltaUsage.output_tokens !== "number")
        return null;
      // The terminal message_delta carries the full cumulative usage; scale
      // every field it carries (not just output_tokens) so the client's
      // last-write-wins usage stays under the cap. Base the factor on the
      // delta's own values, falling back to the inner accumulator's real totals.
      const iu = inner.getResponse().usage ?? ZERO_USAGE;
      const newUsage = scaleMessageDeltaUsage(
        deltaUsage,
        {
          inputTokens: iu.inputTokens,
          cacheReadInputTokens: iu.cacheReadInputTokens,
          cacheCreationInputTokens: iu.cacheCreationInputTokens,
        },
        maxReportedUsage,
      );
      return JSON.stringify({ ...parsed, usage: newUsage });
    }

    return null;
  }

  /** Format an SSE event, applying usage scaling when active. */
  function forwardEvent(
    eventType: string,
    data: string,
    parsed?: Record<string, unknown>,
  ): string {
    if (parsed) {
      const rewritten = maybeScaleEvent(parsed, eventType);
      if (rewritten) return formatSSEEvent(eventType, rewritten);
    }
    return formatSSEEvent(eventType, data);
  }

  function processEvent(eventType: string, data: string): string {
    // Always feed the inner accumulator (it tracks full state)
    inner.processEvent(eventType, data);

    // Parse the data payload
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      // Non-JSON events (pings, etc.) — forward as-is
      return formatSSEEvent(eventType, data);
    }

    switch (eventType) {
      case "content_block_start": {
        const index = parsed.index as number;
        if (typeof index !== "number") break;

        const block = parsed.content_block as
          | Record<string, unknown>
          | undefined;
        if (block?.type === "tool_use" && block.name === recallToolName) {
          // Suppress this block
          suppressedIndices.add(index);
          suppressedCount++;
          recallDetected = true;
          if (firstSuppressedIndex < 0) firstSuppressedIndex = index;
          return ""; // Don't forward
        }

        if (block?.type === "tool_use") {
          otherToolIndices.add(index);
        }

        clientBlocks++;
        // Re-index: apply suppression offset + base offset
        if (suppressedCount > 0 || baseOffset > 0) {
          const adjusted = {
            ...parsed,
            index: index - suppressedCount + baseOffset,
          };
          return formatSSEEvent(eventType, JSON.stringify(adjusted));
        }
        break;
      }

      case "content_block_delta":
      case "content_block_stop": {
        const index = parsed.index as number;
        if (typeof index === "number" && suppressedIndices.has(index)) {
          return ""; // Don't forward recall block events
        }
        // Re-index: apply suppression offset + base offset
        if (
          (suppressedCount > 0 || baseOffset > 0) &&
          typeof parsed.index === "number"
        ) {
          const adjusted = {
            ...parsed,
            index: parsed.index - suppressedCount + baseOffset,
          };
          return formatSSEEvent(eventType, JSON.stringify(adjusted));
        }
        break;
      }

      case "message_delta":
      case "message_stop": {
        if (recallDetected) {
          // Hold back — caller decides whether to forward or replace.
          // Apply scaling to held-back events too (they may be forwarded later).
          heldBack += forwardEvent(eventType, data, parsed);
          return "";
        }
        break;
      }

      // message_start — suppress for continuation streams (client already has one)
      case "message_start": {
        if (suppressMsgStart) return "";
        break;
      }

      // ping, etc. — forward with possible usage scaling
    }

    return forwardEvent(eventType, data, parsed);
  }

  return {
    processEvent,
    getResponse: () => inner.getResponse(),
    isDone: () => inner.isDone(),
    hasRecall: () => recallDetected,
    hasOtherTools: () => otherToolIndices.size > 0,
    recallBlockIndex: () => firstSuppressedIndex,
    clientBlockCount: () => clientBlocks,
    heldBackEvents: () => heldBack,
    takeHeldBackEvents: () => {
      const out = heldBack;
      heldBack = "";
      return out;
    },
  };
}

function malformedAnthropicStream(): never {
  throw new Error("malformed Anthropic stream event");
}

function validateAnthropicStreamBlock(block: unknown): string {
  if (
    !isRecord(block) ||
    typeof block.type !== "string" ||
    !ANTHROPIC_CONTENT_BLOCK_TYPES.has(block.type)
  ) {
    malformedAnthropicStream();
  }

  switch (block.type) {
    case "text":
      if (typeof block.text !== "string") malformedAnthropicStream();
      if (
        block.citations !== undefined &&
        block.citations !== null &&
        (!Array.isArray(block.citations) ||
          block.citations.some((citation) => !isRecord(citation)))
      ) {
        malformedAnthropicStream();
      }
      break;
    case "thinking":
      if (
        typeof block.thinking !== "string" ||
        (block.signature !== undefined && typeof block.signature !== "string")
      ) {
        malformedAnthropicStream();
      }
      break;
    case "redacted_thinking":
      if (typeof block.data !== "string") malformedAnthropicStream();
      break;
    case "tool_use":
      if (
        typeof block.id !== "string" ||
        typeof block.name !== "string" ||
        !isRecord(block.input)
      ) {
        malformedAnthropicStream();
      }
      break;
    case "server_tool_use":
      if (
        typeof block.id !== "string" ||
        typeof block.name !== "string" ||
        block.input === undefined
      ) {
        malformedAnthropicStream();
      }
      break;
    case "container_upload":
      if (typeof block.file_id !== "string") malformedAnthropicStream();
      break;
    case "web_search_tool_result":
    case "web_fetch_tool_result":
    case "code_execution_tool_result":
    case "bash_code_execution_tool_result":
    case "text_editor_code_execution_tool_result":
    case "tool_search_tool_result":
      if (typeof block.tool_use_id !== "string" || block.content == null) {
        malformedAnthropicStream();
      }
      break;
    case "fallback":
      // Server-side fallback emits only a start/stop boundary block.
      break;
  }
  return block.type;
}

function validateAnthropicMessageStart(parsed: Record<string, unknown>): void {
  if (!isRecord(parsed.message)) malformedAnthropicStream();
  const message = parsed.message;
  if (
    typeof message.id !== "string" ||
    message.type !== "message" ||
    message.role !== "assistant" ||
    typeof message.model !== "string" ||
    !Array.isArray(message.content) ||
    message.content.length !== 0 ||
    message.stop_reason !== null ||
    message.stop_sequence !== null
  ) {
    malformedAnthropicStream();
  }
  if (
    message.container !== undefined &&
    message.container !== null &&
    !isRecord(message.container)
  ) {
    malformedAnthropicStream();
  }
  if (
    message.stop_details !== undefined &&
    message.stop_details !== null &&
    !isRecord(message.stop_details)
  ) {
    malformedAnthropicStream();
  }
  validateAnthropicUsage(message.usage, {
    message: "malformed Anthropic stream event",
    required: true,
    requireInput: true,
    requireOutput: true,
  });
}

function validateAnthropicMessageDelta(
  parsed: Record<string, unknown>,
): string | null {
  if (!isRecord(parsed.delta)) malformedAnthropicStream();
  const delta = parsed.delta;
  if (!("stop_reason" in delta)) malformedAnthropicStream();
  const stopReason = delta.stop_reason;
  if (
    stopReason !== null &&
    (typeof stopReason !== "string" || !ANTHROPIC_STOP_REASONS.has(stopReason))
  ) {
    malformedAnthropicStream();
  }
  if (
    delta.stop_sequence !== undefined &&
    delta.stop_sequence !== null &&
    typeof delta.stop_sequence !== "string"
  ) {
    malformedAnthropicStream();
  }
  if (
    delta.container !== undefined &&
    delta.container !== null &&
    !isRecord(delta.container)
  ) {
    malformedAnthropicStream();
  }
  if (
    delta.stop_details !== undefined &&
    delta.stop_details !== null &&
    !isRecord(delta.stop_details)
  ) {
    malformedAnthropicStream();
  }
  validateAnthropicUsage(parsed.usage, {
    message: "malformed Anthropic stream event",
    required: true,
    requireOutput: true,
    allowNullCounts: true,
  });
  return typeof stopReason === "string" ? stopReason : null;
}

/** Incremental strict validator shared by buffered and true-streaming paths. */
export class AnthropicSSEValidator {
  private messageStarted = false;
  private messageDeltaPhase = false;
  private terminalStopReason: string | null = null;
  private terminalSeen = false;
  private readonly activeBlocks = new Set<number>();
  private readonly seenBlocks = new Set<number>();
  private readonly blockTypes = new Map<number, string>();
  private readonly toolUseIds = new Set<string>();

  process(event: string, data: string): void {
    let parsed: Record<string, unknown>;
    try {
      const decoded: unknown = JSON.parse(data);
      if (!isRecord(decoded)) malformedAnthropicStream();
      parsed = decoded;
    } catch {
      malformedAnthropicStream();
    }
    if (this.terminalSeen || parsed.type !== event) malformedAnthropicStream();
    const index = parsed.index;
    const validIndex = Number.isSafeInteger(index) && (index as number) >= 0;
    switch (event) {
      case "error":
        throw new Error("Anthropic stream error event");
      case "ping":
        break;
      case "message_start":
        if (this.messageStarted) malformedAnthropicStream();
        validateAnthropicMessageStart(parsed);
        this.messageStarted = true;
        break;
      case "content_block_start": {
        if (
          !this.messageStarted ||
          this.messageDeltaPhase ||
          !validIndex ||
          this.activeBlocks.has(index as number) ||
          this.seenBlocks.has(index as number)
        ) {
          malformedAnthropicStream();
        }
        const blockType = validateAnthropicStreamBlock(parsed.content_block);
        const block = parsed.content_block as Record<string, unknown>;
        const hasToolIdentity =
          blockType === "tool_use" || blockType === "server_tool_use";
        if (
          hasToolIdentity &&
          (!block.id || this.toolUseIds.has(block.id as string))
        ) {
          malformedAnthropicStream();
        }
        if (hasToolIdentity) this.toolUseIds.add(block.id as string);
        this.blockTypes.set(index as number, blockType);
        this.activeBlocks.add(index as number);
        this.seenBlocks.add(index as number);
        break;
      }
      case "content_block_delta": {
        if (
          !validIndex ||
          !this.activeBlocks.has(index as number) ||
          !isRecord(parsed.delta)
        ) {
          malformedAnthropicStream();
        }
        const delta = parsed.delta;
        switch (delta.type) {
          case "text_delta":
            if (typeof delta.text !== "string") malformedAnthropicStream();
            break;
          case "thinking_delta":
            if (typeof delta.thinking !== "string") malformedAnthropicStream();
            break;
          case "signature_delta":
            if (typeof delta.signature !== "string") malformedAnthropicStream();
            break;
          case "input_json_delta":
            if (typeof delta.partial_json !== "string") {
              malformedAnthropicStream();
            }
            break;
          case "citations_delta":
            if (!isRecord(delta.citation)) malformedAnthropicStream();
            break;
          default:
            malformedAnthropicStream();
        }
        const blockType = this.blockTypes.get(index as number);
        const validDeltaForBlock =
          blockType === "text"
            ? delta.type === "text_delta" || delta.type === "citations_delta"
            : blockType === "thinking"
              ? delta.type === "thinking_delta" ||
                delta.type === "signature_delta"
              : blockType === "tool_use" || blockType === "server_tool_use"
                ? delta.type === "input_json_delta"
                : false;
        if (!validDeltaForBlock) malformedAnthropicStream();
        break;
      }
      case "content_block_stop":
        if (!validIndex || !this.activeBlocks.delete(index as number)) {
          malformedAnthropicStream();
        }
        break;
      case "message_delta": {
        if (!this.messageStarted || this.activeBlocks.size > 0) {
          malformedAnthropicStream();
        }
        this.messageDeltaPhase = true;
        const stopReason = validateAnthropicMessageDelta(parsed);
        if (
          stopReason !== null &&
          this.terminalStopReason !== null &&
          this.terminalStopReason !== stopReason
        ) {
          malformedAnthropicStream();
        }
        this.terminalStopReason = stopReason ?? this.terminalStopReason;
        break;
      }
      case "message_stop":
        if (
          !this.messageStarted ||
          this.terminalStopReason === null ||
          this.activeBlocks.size > 0
        ) {
          malformedAnthropicStream();
        }
        this.terminalSeen = true;
        break;
      default:
        malformedAnthropicStream();
    }
  }

  isDone(): boolean {
    return this.terminalSeen;
  }

  assertDone(): void {
    if (!this.terminalSeen) {
      throw new Error("missing Anthropic message_stop terminal");
    }
  }
}

/**
 * Consume an Anthropic SSE streaming Response and return the accumulated
 * GatewayResponse. Useful when the response needs to be translated to another
 * protocol format (e.g. OpenAI) after the pipeline produces Anthropic SSE.
 */
export async function accumulateSSEResponse(
  response: Response,
  opts: {
    signal?: AbortSignal;
    stopAtTerminal?: boolean;
    strict?: boolean;
    inactivityMs?: number;
    maxFrames?: number;
    onSemanticContent?: () => void;
  } = {},
): Promise<GatewayResponse> {
  const accumulator = createStreamAccumulator();
  let messageStarted = false;
  let messageDeltaPhase = false;
  let terminalStopReason: string | null = null;
  const activeBlocks = new Set<number>();
  const seenBlocks = new Set<number>();
  const blockTypes = new Map<number, string>();
  const toolUseIds = new Set<string>();
  const strictValidator = opts.strict ? new AnthropicSSEValidator() : undefined;
  if (!response.body) throw new Error("Response has no body");
  const reader = response.body.getReader();

  try {
    for await (const { event, data } of parseSSEStream(reader, {
      signal: opts.signal,
      inactivityMs: opts.inactivityMs,
      requireEventTerminator: opts.strict,
      fatalUtf8: opts.strict,
      maxEventBytes: opts.strict ? undefined : Number.POSITIVE_INFINITY,
      maxFrames: opts.strict
        ? (opts.maxFrames ?? DEFAULT_MAX_SSE_FRAMES)
        : opts.maxFrames,
      maxTotalBytes: opts.strict ? 4 * 1024 * 1024 : undefined,
    })) {
      strictValidator?.process(event, data);
      if (opts.strict) {
        let parsed: Record<string, unknown>;
        try {
          const decoded: unknown = JSON.parse(data);
          if (!isRecord(decoded)) malformedAnthropicStream();
          parsed = decoded;
        } catch {
          malformedAnthropicStream();
        }
        if (parsed.type !== event) malformedAnthropicStream();
        const index = parsed.index;
        const validIndex =
          Number.isSafeInteger(index) && (index as number) >= 0;
        switch (event) {
          case "error":
            throw new Error("Anthropic stream error event");
          case "ping":
            break;
          case "message_start":
            if (messageStarted) malformedAnthropicStream();
            validateAnthropicMessageStart(parsed);
            messageStarted = true;
            break;
          case "content_block_start":
            if (
              !messageStarted ||
              messageDeltaPhase ||
              !validIndex ||
              activeBlocks.has(index as number) ||
              seenBlocks.has(index as number)
            ) {
              malformedAnthropicStream();
            }
            {
              const blockType = validateAnthropicStreamBlock(
                parsed.content_block,
              );
              const block = parsed.content_block as Record<string, unknown>;
              const hasToolIdentity =
                blockType === "tool_use" || blockType === "server_tool_use";
              if (
                hasToolIdentity &&
                (!block.id || toolUseIds.has(block.id as string))
              ) {
                malformedAnthropicStream();
              }
              if (hasToolIdentity) {
                toolUseIds.add(block.id as string);
              }
              blockTypes.set(index as number, blockType);
            }
            activeBlocks.add(index as number);
            seenBlocks.add(index as number);
            break;
          case "content_block_delta":
            if (
              !validIndex ||
              !activeBlocks.has(index as number) ||
              !isRecord(parsed.delta)
            ) {
              malformedAnthropicStream();
            }
            {
              const delta = parsed.delta;
              switch (delta.type) {
                case "text_delta":
                  if (typeof delta.text !== "string") {
                    malformedAnthropicStream();
                  }
                  break;
                case "thinking_delta":
                  if (typeof delta.thinking !== "string") {
                    malformedAnthropicStream();
                  }
                  break;
                case "signature_delta":
                  if (typeof delta.signature !== "string") {
                    malformedAnthropicStream();
                  }
                  break;
                case "input_json_delta":
                  if (typeof delta.partial_json !== "string") {
                    malformedAnthropicStream();
                  }
                  break;
                case "citations_delta":
                  if (!isRecord(delta.citation)) malformedAnthropicStream();
                  break;
                default:
                  malformedAnthropicStream();
              }
              const blockType = blockTypes.get(index as number);
              const validDeltaForBlock =
                blockType === "text"
                  ? delta.type === "text_delta" ||
                    delta.type === "citations_delta"
                  : blockType === "thinking"
                    ? delta.type === "thinking_delta" ||
                      delta.type === "signature_delta"
                    : blockType === "tool_use" ||
                        blockType === "server_tool_use"
                      ? delta.type === "input_json_delta"
                      : false;
              if (!validDeltaForBlock) malformedAnthropicStream();
            }
            break;
          case "content_block_stop":
            if (!validIndex || !activeBlocks.delete(index as number)) {
              malformedAnthropicStream();
            }
            break;
          case "message_delta":
            if (!messageStarted || activeBlocks.size > 0) {
              malformedAnthropicStream();
            }
            messageDeltaPhase = true;
            {
              const stopReason = validateAnthropicMessageDelta(parsed);
              if (
                stopReason !== null &&
                terminalStopReason !== null &&
                terminalStopReason !== stopReason
              ) {
                malformedAnthropicStream();
              }
              terminalStopReason = stopReason ?? terminalStopReason;
            }
            break;
          case "message_stop":
            if (
              !messageStarted ||
              terminalStopReason === null ||
              activeBlocks.size > 0
            ) {
              malformedAnthropicStream();
            }
            break;
          default:
            malformedAnthropicStream();
        }
      }
      if (opts.onSemanticContent) {
        let semantic = false;
        try {
          const parsed = JSON.parse(data) as Record<string, unknown>;
          if (
            event === "content_block_start" &&
            isRecord(parsed.content_block)
          ) {
            const block = parsed.content_block;
            semantic =
              block.type === "tool_use" ||
              block.type === "server_tool_use" ||
              (block.type === "text" &&
                typeof block.text === "string" &&
                block.text.length > 0) ||
              (block.type === "thinking" &&
                typeof block.thinking === "string" &&
                block.thinking.length > 0);
          } else if (
            event === "content_block_delta" &&
            isRecord(parsed.delta)
          ) {
            semantic = [
              parsed.delta.text,
              parsed.delta.thinking,
              parsed.delta.partial_json,
            ].some((value) => typeof value === "string" && value.length > 0);
          }
        } catch {
          // Strict parsing above owns malformed JSON diagnostics.
        }
        if (semantic) opts.onSemanticContent();
      }
      accumulator.processEvent(event, data);
      if (opts.stopAtTerminal && accumulator.isDone()) break;
    }
  } finally {
    cancelAndReleaseReader(reader);
  }

  if (opts.stopAtTerminal && !accumulator.isDone()) {
    throw new Error("missing Anthropic message_stop terminal");
  }
  if (opts.stopAtTerminal) strictValidator?.assertDone();

  return accumulator.getResponse();
}
