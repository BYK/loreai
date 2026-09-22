import { createHash } from "node:crypto";
import {
  type ContextBoundaryProtocol,
  SourceWindowStore,
  TOKEN_ESTIMATE_CACHE_VERSION,
  estimateMessages,
  isToolPart,
  type LoreMessageWithParts,
  type SourceWindow,
} from "@loreai/core";
import type { GatewayMessage } from "./translate/types";
import type { PreparationTiming } from "./semantic-preparation";
import {
  CHAIN_DIGEST_SEED,
  digestChain,
  extendChainDigest,
} from "./chain-digest";

const LEGACY_VERSION = `gateway-source-window-v1:${TOKEN_ESTIMATE_CACHE_VERSION}`;
const CONTEXT_VERSION = `gateway-source-window-context-v1:${TOKEN_ESTIMATE_CACHE_VERSION}`;
/** Separate namespace so legacy full-history checkpoints keep their digest contract. */
export const SOURCE_CHECKPOINT_PROTOCOL_PREFIX = "context-boundary-v1:";

export function sourceCheckpointProtocol(
  protocol: ContextBoundaryProtocol,
): string {
  return `${SOURCE_CHECKPOINT_PROTOCOL_PREFIX}${protocol}`;
}

function isContextCheckpointProtocol(protocol: string): boolean {
  return protocol.startsWith(SOURCE_CHECKPOINT_PROTOCOL_PREFIX);
}
export const SOURCE_WINDOW_MAX_MESSAGES = 2048;
const PREFIX_COUNTS = 4096;
const BLOOM_BYTES = 65_536;
type Provenance = Pick<
  GatewayMessage,
  "content" | "provenanceContent" | "provenancePositions"
>;
interface Payload {
  version: string;
  protocol: string;
  sourceCount: number;
  sourceDigest: string;
  raw: LoreMessageWithParts[];
  resolvedTokens: number[];
  provenance: Array<[string, Provenance]>;
  ids: Array<[string, string]>;
  window: SourceWindow;
  toolIds: string;
  /** Whether raw-item normalization can safely resume after this checkpoint. */
  boundarySafe?: boolean;
}
type Reason =
  | "disabled"
  | "missing"
  | "checkpoint"
  | "protocol"
  | "history"
  | "unsafe_boundary"
  | "tool_boundary"
  | "forced"
  | "hit";

/** A source suffix cannot be safely prepared without its retained prefix. */
export class SourceDeltaUnavailableError extends Error {
  constructor(
    message = "The retained Lore context does not match the request",
  ) {
    super(message);
    this.name = "SourceDeltaUnavailableError";
  }
}

function validPart(part: LoreMessageWithParts["parts"][number]): boolean {
  if (!part || typeof part.id !== "string") return false;
  if (part.type === "text" || part.type === "reasoning")
    return typeof part.text === "string";
  if (part.type === "opaque") return !!part.raw && typeof part.raw === "object";
  if (
    !isToolPart(part) ||
    typeof part.callID !== "string" ||
    typeof part.tool !== "string" ||
    !part.state
  )
    return false;
  if (part.state.status === "completed")
    return typeof part.state.output === "string";
  if (part.state.status === "error")
    return typeof part.state.error === "string";
  return part.state.status === "pending";
}

/** False positives cost a full reconciliation; a false negative must be impossible. */
class ToolIds {
  readonly bits: Buffer;
  constructor(encoded?: string) {
    this.bits = encoded
      ? Buffer.from(encoded, "base64")
      : Buffer.alloc(BLOOM_BYTES);
  }
  indexes(id: string): number[] {
    const hash = createHash("sha256").update(id).digest();
    return [0, 4, 8, 12].map((i) => hash.readUInt32LE(i) % (BLOOM_BYTES * 8));
  }
  add(id: string) {
    for (const i of this.indexes(id)) this.bits[i >> 3] |= 1 << (i & 7);
  }
  has(id: string): boolean {
    return this.indexes(id).every(
      (i) => (this.bits[i >> 3] & (1 << (i & 7))) !== 0,
    );
  }
}

function valid(value: unknown, sessionID: string): value is Payload {
  if (!value || typeof value !== "object") return false;
  const v = value as Payload;
  return (
    (v.version === LEGACY_VERSION || v.version === CONTEXT_VERSION) &&
    typeof v.protocol === "string" &&
    Number.isSafeInteger(v.sourceCount) &&
    v.sourceCount > 0 &&
    typeof v.sourceDigest === "string" &&
    /^[a-f0-9]{64}$/.test(v.sourceDigest) &&
    !!v.window &&
    Number.isSafeInteger(v.window.offset) &&
    v.window.offset >= 0 &&
    v.window.offset < v.sourceCount &&
    Number.isSafeInteger(v.window.omittedTokens) &&
    v.window.omittedTokens >= 0 &&
    Array.isArray(v.window.prefixTokens) &&
    v.window.prefixTokens.length <= PREFIX_COUNTS + 1 &&
    v.window.prefixTokens[0] === 0 &&
    v.window.prefixTokens.every(
      (n, i, all) =>
        Number.isSafeInteger(n) && n >= 0 && (i === 0 || n >= all[i - 1]),
    ) &&
    (v.window.prefixTokens[v.window.offset] === undefined ||
      v.window.prefixTokens[v.window.offset] === v.window.omittedTokens) &&
    Array.isArray(v.window.previousWindowIDs) &&
    v.window.previousWindowIDs.length <= SOURCE_WINDOW_MAX_MESSAGES + 16 &&
    v.window.previousWindowIDs.every((id) => typeof id === "string") &&
    Array.isArray(v.raw) &&
    v.raw.length === v.sourceCount - v.window.offset &&
    v.raw.length <= SOURCE_WINDOW_MAX_MESSAGES &&
    v.raw.every(
      (m) =>
        m?.info?.sessionID === sessionID &&
        typeof m.info.id === "string" &&
        ["user", "assistant"].includes(m.info.role) &&
        !!m.info.time &&
        Number.isFinite(m.info.time.created) &&
        (m.hiddenInputTokens === undefined ||
          (Number.isFinite(m.hiddenInputTokens) && m.hiddenInputTokens >= 0)) &&
        Array.isArray(m.parts) &&
        m.parts.every(validPart),
    ) &&
    Array.isArray(v.resolvedTokens) &&
    v.resolvedTokens.length === v.raw.length &&
    v.resolvedTokens.every((n) => Number.isSafeInteger(n) && n >= 0) &&
    Array.isArray(v.ids) &&
    v.ids.length <= SOURCE_WINDOW_MAX_MESSAGES &&
    v.ids.every(
      (e) =>
        Array.isArray(e) &&
        e.length === 2 &&
        e.every((s) => typeof s === "string"),
    ) &&
    Array.isArray(v.provenance) &&
    v.provenance.length <= SOURCE_WINDOW_MAX_MESSAGES &&
    v.provenance.every(
      (e) =>
        Array.isArray(e) &&
        e.length === 2 &&
        typeof e[0] === "string" &&
        Array.isArray(e[1]?.content) &&
        Array.isArray(e[1]?.provenanceContent),
    ) &&
    typeof v.toolIds === "string" &&
    Buffer.from(v.toolIds, "base64").length === BLOOM_BYTES &&
    (v.version !== CONTEXT_VERSION || typeof v.boundarySafe === "boolean")
  );
}

/**
 * Generic clients still validate O(wire bytes). Boundary-only digests or client
 * supplied head IDs cannot prove that an earlier message was not edited. This
 * pass constructs no Lore objects, pairs no tools and performs no tokenization.
 */
function sourceDigests(
  messages: GatewayMessage[],
  previousCount?: number,
  chained = false,
) {
  if (chained) {
    let digest = CHAIN_DIGEST_SEED;
    let previous: string | undefined;
    for (let i = 0; i < messages.length; i++) {
      digest = extendChainDigest(digest, messages[i]);
      if (i + 1 === previousCount) previous = digest;
    }
    return { previous, current: digest };
  }
  const hash = createHash("sha256");
  let previous: string | undefined;
  for (let i = 0; i < messages.length; i++) {
    const encoded = JSON.stringify(messages[i]);
    hash.update(`${Buffer.byteLength(encoded)}:`).update(encoded);
    if (i + 1 === previousCount) previous = hash.copy().digest("hex");
  }
  return { previous, current: hash.digest("hex") };
}

function crossesToolBoundary(
  candidate: Payload,
  suffix: GatewayMessage[],
): boolean {
  const toolIds = new ToolIds(candidate.toolIds);
  return (
    candidate.raw.some((m) =>
      m.parts.some((p) => isToolPart(p) && toolIds.has(p.callID)),
    ) ||
    suffix.some((m) =>
      m.content.some(
        (b) =>
          (b.type === "tool_use" && toolIds.has(b.id)) ||
          (b.type === "tool_result" && toolIds.has(b.toolUseId)),
      ),
    )
  );
}

export class SourceCheckpoint {
  readonly store: SourceWindowStore;
  readonly base?: Payload;
  readonly digest: string;
  readonly reason: Reason;
  private next?: Payload;
  private raw: LoreMessageWithParts[] = [];
  private resolvedTokens: number[] = [];
  private provenance = new Map<string, Provenance>();
  private ids = new Map<string, string>();

  private readonly scope: {
    protocol: string;
    noStore: boolean;
    timing: PreparationTiming;
    sourceCount: number;
    boundarySafe?: boolean;
  };
  private readonly version: string;

  constructor(input: {
    messages: GatewayMessage[];
    sessionID: string;
    projectPath: string;
    noStore: boolean;
    protocol: string;
    forceFull?: boolean;
    boundarySafe?: boolean;
    sourcePrefix?: {
      sourceCount: number;
      sourceDigest: string;
    };
    timing: PreparationTiming;
  }) {
    const contextProtocol = isContextCheckpointProtocol(input.protocol);
    this.version = contextProtocol ? CONTEXT_VERSION : LEGACY_VERSION;
    const sourcePrefixCount = input.sourcePrefix?.sourceCount ?? 0;
    this.scope = {
      protocol: input.protocol,
      noStore: input.noStore,
      timing: input.timing,
      sourceCount: sourcePrefixCount + input.messages.length,
      boundarySafe: input.boundarySafe,
    };
    this.store = new SourceWindowStore(input);
    const loaded = this.store.load();
    const candidate = valid(loaded, input.sessionID) ? loaded : undefined;

    if (input.sourcePrefix) {
      if (!contextProtocol) {
        throw new SourceDeltaUnavailableError(
          "A context suffix requires a source checkpoint; retrying with the full conversation.",
        );
      }
      this.digest = digestChain(
        input.messages,
        input.sourcePrefix.sourceDigest,
      );
      const unavailableReason = input.noStore
        ? "disabled"
        : input.forceFull
          ? "forced"
          : !candidate
            ? "checkpoint"
            : candidate.protocol !== input.protocol
              ? "protocol"
              : candidate.boundarySafe !== true
                ? "unsafe_boundary"
                : candidate.sourceCount !== input.sourcePrefix.sourceCount ||
                    candidate.sourceDigest !== input.sourcePrefix.sourceDigest
                  ? "history"
                  : undefined;
      if (unavailableReason) {
        input.timing.metric("source_delta_unavailable", 1);
        input.timing.metric(`source_delta_unavailable_${unavailableReason}`, 1);
        throw new SourceDeltaUnavailableError(
          "The retained Lore context no longer matches the request prefix; retrying with the full conversation.",
        );
      }
      // `unavailableReason` includes a missing candidate; keep the invariant
      // explicit so TypeScript and future edits cannot weaken it.
      if (!candidate) throw new SourceDeltaUnavailableError();
      if (crossesToolBoundary(candidate, input.messages)) {
        input.timing.metric("source_delta_unavailable", 1);
        throw new SourceDeltaUnavailableError(
          "The request crosses a retained tool-call boundary; retrying with the full conversation.",
        );
      }
      this.base = candidate;
      this.reason = "hit";
      input.timing.metric("source_checkpoint_hit", 1);
      return;
    }

    const hashes = input.timing.measure("source_validation", () =>
      sourceDigests(input.messages, candidate?.sourceCount, contextProtocol),
    );
    this.digest = hashes.current;
    let reason: Reason = input.noStore
      ? "disabled"
      : input.forceFull
        ? "forced"
        : !loaded
          ? "missing"
          : !candidate
            ? "checkpoint"
            : candidate.protocol !== input.protocol
              ? "protocol"
              : candidate.sourceCount > input.messages.length ||
                  hashes.previous !== candidate.sourceDigest
                ? "history"
                : "hit";
    if (reason === "hit" && candidate) {
      // Check both directions: the adapter pairs all results with all calls,
      // including an old result reused by a newly appended call.
      const crossing = crossesToolBoundary(
        candidate,
        input.messages.slice(candidate.sourceCount),
      );
      if (crossing) reason = "tool_boundary";
      else this.base = candidate;
    }
    this.reason = reason;
    input.timing.metric("source_checkpoint_hit", reason === "hit" ? 1 : 0);
    if (reason !== "hit") input.timing.metric(`source_fallback_${reason}`, 1);
  }

  get offset(): number {
    return this.base?.window.offset ?? 0;
  }
  get convertedFrom(): number {
    return this.base?.sourceCount ?? 0;
  }
  get sourceWindow(): SourceWindow | undefined {
    // This describes an omitted prefix, not whether a checkpoint was reused.
    // At offset zero, base/convertedFrom still enable suffix-only preparation,
    // while undefined preserves the pipeline's complete-source provenance path.
    const window = this.base?.window;
    return window && window.offset > 0 ? window : undefined;
  }
  get storedIds(): Map<string, string> {
    return new Map(this.base?.ids);
  }
  get storedProvenance(): Map<string, Provenance> {
    return new Map(this.base?.provenance);
  }
  get hasPendingPublication(): boolean {
    return this.next !== undefined;
  }

  capture(
    raw: LoreMessageWithParts[],
    resolved: LoreMessageWithParts[],
    ids: Map<string, string>,
    provenance: ReadonlyMap<string, Provenance>,
  ) {
    this.raw = raw;
    // Appended results may change an older pending call's resolved size.
    // Every other retained estimate is stable because the source prefix and
    // stored-ID revision were validated before taking this path.
    const appendedResults = new Set<string>();
    for (const m of raw.slice(this.base?.raw.length ?? 0))
      for (const p of m.parts)
        if (isToolPart(p) && p.tool === "result") appendedResults.add(p.callID);
    let estimated = 0;
    this.resolvedTokens = resolved.map((m, i) => {
      const cached = this.base?.resolvedTokens[i];
      if (
        cached !== undefined &&
        !raw[i].parts.some(
          (p) =>
            isToolPart(p) &&
            p.tool !== "result" &&
            appendedResults.has(p.callID),
        )
      )
        return cached;
      estimated++;
      return estimateMessages([m]);
    });
    this.scope.timing.metric("source_estimated_messages", estimated);
    this.ids = ids;
    this.provenance = new Map(provenance);
  }

  /** Called immediately after gradient, before wire/protocol mutations. */
  finish(modelWindow: LoreMessageWithParts[]): void {
    try {
      this.finishWindow(modelWindow);
    } finally {
      this.raw = [];
      this.resolvedTokens = [];
      this.ids = new Map();
      this.provenance = new Map();
    }
  }

  private finishWindow(modelWindow: LoreMessageWithParts[]): void {
    if (this.scope.noStore || !this.raw.length) return;
    const selected = new Set(modelWindow.map((m) => m.info.id));
    const earliest = this.raw.findIndex((m) => selected.has(m.info.id));
    if (earliest < 0) return;
    // Keep a little extra history so ordinary budget drift does not need a full
    // reconciliation. The actual previous model window is always included.
    let cut = Math.max(0, Math.min(earliest - 32, this.raw.length - 256));
    while (
      cut > 0 &&
      (this.raw[cut].info.role !== "assistant" ||
        this.raw[cut].parts.some(isToolPart))
    )
      cut--;
    const retained = this.raw.slice(cut);
    if (
      retained.length > SOURCE_WINDOW_MAX_MESSAGES ||
      modelWindow.length > SOURCE_WINDOW_MAX_MESSAGES + 16
    )
      return;
    const toolIds = new ToolIds(this.base?.toolIds);
    for (const m of this.raw.slice(0, cut))
      for (const p of m.parts) if (isToolPart(p)) toolIds.add(p.callID);
    if (
      retained.some((m) =>
        m.parts.some((p) => isToolPart(p) && toolIds.has(p.callID)),
      )
    )
      return;
    const prefixTokens = this.base ? [...this.base.window.prefixTokens] : [0];
    // New results can complete a retained pending call at an OLD absolute
    // index. Recompute that overlap, not just appended entries, so restart's
    // count-based calibration subtracts the same resolved prefix as the full path.
    if (
      this.offset <= PREFIX_COUNTS &&
      prefixTokens[this.offset] !== undefined
    ) {
      prefixTokens.length = this.offset + 1;
      for (
        let i = 0;
        i < this.resolvedTokens.length && prefixTokens.length <= PREFIX_COUNTS;
        i++
      )
        prefixTokens.push((prefixTokens.at(-1) ?? 0) + this.resolvedTokens[i]);
    }
    const keep = new Set(retained.map((m) => m.info.id));
    this.next = {
      version: this.version,
      protocol: this.scope.protocol,
      sourceCount: this.scope.sourceCount,
      sourceDigest: this.digest,
      raw: retained,
      resolvedTokens: this.resolvedTokens.slice(cut),
      provenance: [...this.provenance].filter(([id]) => keep.has(id)),
      ids: [...this.ids].filter(([id]) => keep.has(id)),
      window: {
        offset: this.offset + cut,
        omittedTokens:
          (this.base?.window.omittedTokens ?? 0) +
          this.resolvedTokens.slice(0, cut).reduce((a, b) => a + b, 0),
        prefixTokens,
        previousWindowIDs: [...selected],
      },
      toolIds: toolIds.bits.toString("base64"),
      ...(this.version === CONTEXT_VERSION
        ? { boundarySafe: this.scope.boundarySafe === true }
        : {}),
    };
    this.scope.timing.metric("source_checkpoint_messages", retained.length);
    this.scope.timing.metric(
      "source_omitted_messages",
      this.next.window.offset,
    );
  }

  claim(): boolean {
    return this.next !== undefined && this.store.claim();
  }
  publish(): void {
    if (this.next)
      this.scope.timing.metric(
        "source_checkpoint_published",
        this.store.publish(this.next) ? 1 : 0,
      );
  }
}
