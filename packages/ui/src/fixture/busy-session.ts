/**
 * Deterministic busy-session fixture (UI-06c, plan §16.1): a seeded
 * synthetic session — thousands of mixed prose / code / tool blocks with
 * dynamically sized rows — plus a stream engine that produces the live
 * traffic the plan describes (several concurrent streams of small text
 * deltas, tool status transitions, approval and completion events, bursts,
 * disconnect / reconnect with a stale snapshot) without any harness.
 *
 * Everything is shaped exactly like `GET /api/v1/sessions/:id` data so it
 * flows through the same block model and reader as real history. The
 * engine is pure (no timers, no DOM): the fixture route drives it from the
 * browser clock, tests drive it directly.
 */
import type { DistillationSummary, TemporalMessage } from "~/contracts";
import { CHUNK_SEPARATOR } from "~/reader/blocks";

export const BUSY_SESSION_ID = "busy-fixture";
export const BUSY_PROJECT_ID = "fixture";
/** Default retained history size (plan §16.1). */
export const BUSY_DEFAULT_BLOCKS = 10_000;
export const BUSY_DEFAULT_SEED = 7;
/** Concurrent simulated streams and their delta rate (plan §16.1). */
export const BUSY_STREAMS = 4;
export const BUSY_DELTAS_PER_SECOND = 50;
/** Delta payload bounds, in characters; every payload size is recorded. */
export const BUSY_DELTA_MIN_CHARS = 6;
export const BUSY_DELTA_MAX_CHARS = 42;

const T0 = Date.UTC(2026, 4, 3, 8, 0, 0);
const STEP_MS = 4_000;

/** mulberry32: small, fast, seedable; the same seed yields the same session. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS =
  "the reader keeps selection logical so virtualised rows can unmount without losing the passage anchor content hash offsets survive reload while distillations stay labelled compressed context never original speech older history prepends shift the scroll offset by the size the new rows added tool output stays collapsed until expanded storage remains sqlite with wal and fts5 portability is a requirement the gateway serves the spa from embedded assets".split(
    " ",
  );

const TOOLS = ["bash", "read", "grep", "edit", "test"] as const;
const LANGS = ["ts", "py", "bash", "json"] as const;

type Rand = () => number;

function pick<T>(rand: Rand, items: readonly T[]): T {
  const item = items[Math.floor(rand() * items.length)];
  if (item === undefined) throw new Error("pick from empty list");
  return item;
}

function int(rand: Rand, min: number, max: number): number {
  return min + Math.floor(rand() * (max - min + 1));
}

export function sentence(rand: Rand, words = int(rand, 6, 18)): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) out.push(pick(rand, WORDS));
  const text = out.join(" ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

function paragraph(rand: Rand): string {
  const n = int(rand, 1, 5);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(sentence(rand));
  return parts.join(" ");
}

function prose(rand: Rand, index: number): string {
  const paragraphs = int(rand, 1, 4);
  const out: string[] = [];
  if (rand() < 0.15) out.push(`### Step ${index}`);
  for (let i = 0; i < paragraphs; i++) out.push(paragraph(rand));
  if (rand() < 0.2) {
    out.push(
      `- ${sentence(rand, 5)}\n- ${sentence(rand, 7)}\n- Keep \`block ${index}\` addressable.`,
    );
  }
  return out.join("\n\n");
}

function code(rand: Rand, index: number): string {
  const lang = pick(rand, LANGS);
  const lines = int(rand, 3, 24);
  const body: string[] = [];
  for (let i = 0; i < lines; i++) {
    body.push(
      lang === "json"
        ? `  "key_${index}_${i}": ${int(rand, 0, 9999)},`
        : `const value_${i} = anchor(${index}, ${int(rand, 0, 999)}); // ${pick(rand, WORDS)}`,
    );
  }
  return `${sentence(rand, 8)}\n\n\`\`\`${lang}\n${body.join("\n")}\n\`\`\``;
}

function toolOutput(rand: Rand, index: number): string {
  const lines = int(rand, 2, 40);
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    out.push(`${index}:${i} ${sentence(rand, int(rand, 3, 10))}`);
  }
  return out.join("\n");
}

function meta(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

export function busyMessageId(index: number): string {
  return `busy-${String(index).padStart(6, "0")}`;
}

export type BusyBlockKind = "system" | "lore" | "text" | "code" | "tool";

export interface BusySession {
  messages: TemporalMessage[];
  distillations: DistillationSummary[];
  /** How many blocks of each kind the generator produced. */
  kinds: Record<BusyBlockKind, number>;
  /** Total content characters (the retained payload size). */
  chars: number;
  seed: number;
}

function message(
  index: number,
  role: string,
  content: string,
  metadata: string,
  createdAt: number,
): TemporalMessage {
  return {
    id: busyMessageId(index),
    source_id: `src-${index}`,
    project_id: BUSY_PROJECT_ID,
    session_id: BUSY_SESSION_ID,
    role,
    content,
    tokens: Math.ceil(content.length / 4),
    distilled: 0,
    created_at: createdAt,
    metadata,
  };
}

/** Timestamps are strictly increasing so row order is unambiguous. */
export function busyCreatedAt(index: number, rand: Rand): number {
  return T0 + index * STEP_MS + int(rand, 0, STEP_MS - 1);
}

export function generateBusySession(
  options: { blocks?: number; seed?: number } = {},
): BusySession {
  const blocks = Math.max(1, Math.floor(options.blocks ?? BUSY_DEFAULT_BLOCKS));
  const seed = options.seed ?? BUSY_DEFAULT_SEED;
  const rand = mulberry32(seed);
  const kinds: Record<BusyBlockKind, number> = {
    system: 0,
    lore: 0,
    text: 0,
    code: 0,
    tool: 0,
  };
  const messages: TemporalMessage[] = [];
  let chars = 0;
  for (let i = 0; i < blocks; i++) {
    const createdAt = busyCreatedAt(i, rand);
    let m: TemporalMessage;
    if (i === 0) {
      kinds.system++;
      m = message(
        i,
        "system",
        `You are a coding agent working in the Lore repository (busy fixture, seed ${seed}). Prefer small, reviewable changes.`,
        meta({}),
        createdAt,
      );
    } else if (i % 97 === 1) {
      kinds.lore++;
      m = message(
        i,
        "user",
        `## Project knowledge\n\n- **Storage**: ${sentence(rand, 8)}\n- **Gotcha**: ${sentence(rand, 9)}`,
        meta({ agent: "lore", synthetic: true }),
        createdAt,
      );
    } else if (i % 2 === 1) {
      kinds.text++;
      m = message(
        i,
        "user",
        prose(rand, i),
        meta({
          agent: "build",
          model: { providerID: "anthropic", modelID: "m" },
        }),
        createdAt,
      );
    } else {
      const r = rand();
      const tool = pick(rand, TOOLS);
      if (r < 0.45) {
        kinds.text++;
        m = message(
          i,
          "assistant",
          prose(rand, i),
          meta({ modelID: "claude", providerID: "anthropic", mode: "build" }),
          createdAt,
        );
      } else if (r < 0.7) {
        kinds.code++;
        m = message(
          i,
          "assistant",
          code(rand, i),
          meta({ modelID: "claude", providerID: "anthropic", mode: "build" }),
          createdAt,
        );
      } else {
        kinds.tool++;
        const chunks = [sentence(rand, 10)];
        if (rand() < 0.3) chunks.push(`[reasoning] ${paragraph(rand)}`);
        chunks.push(`[tool:${tool}] ${toolOutput(rand, i)}`);
        m = message(
          i,
          "assistant",
          chunks.join(CHUNK_SEPARATOR),
          meta({
            modelID: "claude",
            providerID: "anthropic",
            mode: "build",
            tools: [tool],
          }),
          createdAt,
        );
      }
    }
    chars += m.content.length;
    messages.push(m);
  }
  const distillations: DistillationSummary[] = [];
  for (let i = 500; i < blocks; i += 500) {
    const at = messages[i]?.created_at ?? T0;
    distillations.push({
      id: `busy-d-${distillations.length}`,
      session_id: BUSY_SESSION_ID,
      generation: 0,
      token_count: int(rand, 400, 1800),
      r_compression: 0.3 + rand() * 0.4,
      c_norm: 0.7 + rand() * 0.25,
      archived: 0,
      created_at: at + 1,
      call_type: "batch",
    });
  }
  return { messages, distillations, kinds, chars, seed };
}

// ---------------------------------------------------------------------------
// Stream engine
// ---------------------------------------------------------------------------

export type StreamPhase =
  | "text"
  | "tool-running"
  | "tool-done"
  | "approval-pending"
  | "approved"
  | "complete";

export interface StreamStatus {
  /** Message id the stream is writing into. */
  messageId: string;
  phase: StreamPhase;
  /** Deltas emitted into the current message so far. */
  deltas: number;
}

/** One live change: a message replaced (by id) or appended. */
export interface BusyEvent {
  kind: "replace" | "append";
  message: TemporalMessage;
  /** Characters this event added. */
  payload: number;
}

export interface EngineSnapshot {
  /** Messages by id as the "server" knows them now — the reconcile source. */
  messages: TemporalMessage[];
}

const TEXT_DELTAS_PER_TURN = 40;
const TOOL_TICKS = 10;
const APPROVAL_EVERY_TURNS = 3;

/**
 * Deterministic producer of live events for `BUSY_STREAMS` concurrent
 * streams. `tick()` emits one delta per stream — 50 ticks per second is the
 * plan's rate — and each stream cycles text deltas → tool call (status
 * transitions) → completion (a new message appended; every few turns an
 * approval request that is later approved). `snapshot()` is what a
 * reconnect fetch would return; `reconcile()` merges it by id so a stale
 * client converges without duplicates.
 */
export class BusyStreamEngine {
  private readonly rand: Rand;
  private nextIndex: number;
  private lastCreatedAt: number;
  private readonly live = new Map<string, TemporalMessage>();
  private readonly streams: Array<{
    messageId: string;
    phase: StreamPhase;
    deltas: number;
    ticks: number;
    turns: number;
    tool: (typeof TOOLS)[number];
    approvalId: string | null;
  }> = [];
  /** Every delta payload size, for the record. */
  readonly payloadSizes: number[] = [];
  /** Approval transitions, in order (pending → approved), for the record. */
  readonly approvals: Array<{ id: string; phase: "pending" | "approved" }> = [];
  private appended = 0;

  constructor(
    private readonly base: readonly TemporalMessage[],
    seed = BUSY_DEFAULT_SEED,
    streams = BUSY_STREAMS,
  ) {
    this.rand = mulberry32(seed ^ 0x9e3779b9);
    this.nextIndex = base.length;
    this.lastCreatedAt = base[base.length - 1]?.created_at ?? T0;
    for (let s = 0; s < streams; s++) this.streams.push(this.openStream());
  }

  private nextCreatedAt(): number {
    this.lastCreatedAt += int(this.rand, 1, 900);
    return this.lastCreatedAt;
  }

  private appendMessage(role: string, content: string, metadata: string) {
    const m = message(
      this.nextIndex++,
      role,
      content,
      metadata,
      this.nextCreatedAt(),
    );
    this.live.set(m.id, m);
    this.appended++;
    return m;
  }

  private openStream() {
    const m = this.appendMessage(
      "assistant",
      "",
      meta({ modelID: "claude", providerID: "anthropic", mode: "build" }),
    );
    return {
      messageId: m.id,
      phase: "text" as StreamPhase,
      deltas: 0,
      ticks: 0,
      turns: 0,
      tool: pick(this.rand, TOOLS),
      approvalId: null,
    };
  }

  /** Current status of every stream. */
  status(): StreamStatus[] {
    return this.streams.map((s) => ({
      messageId: s.messageId,
      phase: s.phase,
      deltas: s.deltas,
    }));
  }

  /** Messages appended since construction. */
  get appendedCount(): number {
    return this.appended;
  }

  private replace(id: string, content: string, payload: number): BusyEvent {
    const prev = this.live.get(id);
    if (!prev) throw new Error(`unknown live message ${id}`);
    const next: TemporalMessage = {
      ...prev,
      content,
      tokens: Math.ceil(content.length / 4),
    };
    this.live.set(id, next);
    return { kind: "replace", message: next, payload };
  }

  /** Advance every stream by one step; returns the events it produced. */
  tick(): BusyEvent[] {
    const events: BusyEvent[] = [];
    for (const s of this.streams) {
      const current = this.live.get(s.messageId);
      if (!current) continue;
      switch (s.phase) {
        case "text": {
          const words = int(this.rand, 1, 6);
          let delta = "";
          for (let i = 0; i < words || delta.length < BUSY_DELTA_MIN_CHARS; i++)
            delta += `${pick(this.rand, WORDS)} `;
          delta =
            this.rand() < 0.08
              ? `${delta.slice(0, BUSY_DELTA_MAX_CHARS - 2).trimEnd()}\n\n`
              : delta.slice(0, BUSY_DELTA_MAX_CHARS);
          this.payloadSizes.push(delta.length);
          s.deltas++;
          events.push(
            this.replace(s.messageId, current.content + delta, delta.length),
          );
          if (s.deltas >= TEXT_DELTAS_PER_TURN) {
            s.phase = "tool-running";
            s.ticks = 0;
            const call = `${current.content}${delta}${CHUNK_SEPARATOR}[tool:${s.tool}] $ ${s.tool} … running`;
            events.push(
              this.replace(
                s.messageId,
                call,
                call.length - current.content.length - delta.length,
              ),
            );
          }
          break;
        }
        case "tool-running": {
          s.ticks++;
          if (s.ticks >= TOOL_TICKS) {
            const output = toolOutput(this.rand, this.nextIndex);
            const done = current.content.replace(
              /\$ \w+ … running$/,
              `$ ${s.tool}\n${output}\n[exit 0]`,
            );
            events.push(this.replace(s.messageId, done, output.length));
            s.phase = "tool-done";
          }
          break;
        }
        case "tool-done": {
          s.turns++;
          if (s.turns % APPROVAL_EVERY_TURNS === 0) {
            const approval = this.appendMessage(
              "user",
              `**Approval requested** — run \`${s.tool}\` with side effects? _pending_`,
              meta({ agent: "lore", synthetic: true }),
            );
            this.approvals.push({ id: approval.id, phase: "pending" });
            s.approvalId = approval.id;
            s.phase = "approval-pending";
            s.ticks = 0;
            events.push({
              kind: "append",
              message: approval,
              payload: approval.content.length,
            });
          } else {
            s.phase = "complete";
          }
          break;
        }
        case "approval-pending": {
          s.ticks++;
          if (s.ticks >= TOOL_TICKS && s.approvalId) {
            const approved = `**Approval requested** — run \`${s.tool}\` with side effects? **approved**`;
            events.push(this.replace(s.approvalId, approved, 8));
            this.approvals.push({ id: s.approvalId, phase: "approved" });
            s.phase = "approved";
          }
          break;
        }
        case "approved":
        case "complete": {
          // The turn is complete: the next user message and a fresh
          // assistant message start a new turn on this stream.
          const user = this.appendMessage(
            "user",
            prose(this.rand, this.nextIndex),
            meta({
              agent: "build",
              model: { providerID: "anthropic", modelID: "m" },
            }),
          );
          events.push({
            kind: "append",
            message: user,
            payload: user.content.length,
          });
          const fresh = this.openStream();
          const opened = this.live.get(fresh.messageId);
          if (opened)
            events.push({ kind: "append", message: opened, payload: 0 });
          s.messageId = fresh.messageId;
          s.phase = "text";
          s.deltas = 0;
          s.ticks = 0;
          s.tool = fresh.tool;
          s.approvalId = null;
          break;
        }
      }
    }
    return events;
  }

  /**
   * At least `count` events delivered at once — the burst scenario. Ticks
   * until the count is reached (some phases spend ticks without emitting).
   */
  burst(count: number): BusyEvent[] {
    const events: BusyEvent[] = [];
    while (events.length < count) events.push(...this.tick());
    return events;
  }

  /** What a refetch after reconnect returns: every live message, in order. */
  snapshot(): EngineSnapshot {
    return {
      messages: [...this.live.values()].sort(
        (a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1),
      ),
    };
  }

  /** Expected final content of every message the engine has touched. */
  expected(): ReadonlyMap<string, TemporalMessage> {
    return this.live;
  }
}

/**
 * Apply live events to a message list: an event whose id is already present
 * swaps that object in place (row order is unaffected); a new id goes to the
 * end. Live events arrive in creation order, so appending keeps the list
 * sorted; `reconcile` re-sorts because a snapshot can fill gaps.
 */
export function applyEvents(
  messages: readonly TemporalMessage[],
  events: readonly BusyEvent[],
): TemporalMessage[] {
  if (events.length === 0) return [...messages];
  const index = new Map<string, number>();
  messages.forEach((m, i) => index.set(m.id, i));
  const next = [...messages];
  for (const event of events) {
    const at = index.get(event.message.id);
    if (at === undefined) {
      index.set(event.message.id, next.length);
      next.push(event.message);
    } else {
      next[at] = event.message;
    }
  }
  return next;
}

/**
 * Reconcile a (possibly stale) client list with a server snapshot: every
 * snapshot message replaces its client twin by id or is inserted at its
 * `(created_at, id)` position; client-only messages are kept. No id
 * appears twice and the result is in server order.
 */
export function reconcile(
  client: readonly TemporalMessage[],
  snapshot: EngineSnapshot,
): TemporalMessage[] {
  const merged = applyEvents(
    client,
    snapshot.messages.map((m) => ({ kind: "replace", message: m, payload: 0 })),
  );
  return merged.sort(
    (a, b) =>
      a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** Mutate one block's first text part — the "source changed" scenario. */
export function mutateMessage(
  messages: readonly TemporalMessage[],
  messageId: string,
): TemporalMessage[] {
  return messages.map((m) =>
    m.id === messageId
      ? { ...m, content: `${m.content}\n\nEdited after the link was made.` }
      : m,
  );
}
