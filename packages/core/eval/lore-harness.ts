/**
 * vitest-evals harness for the Lore gateway.
 *
 * The harness wraps the Lore gateway into a `createHarness()` interface.
 * Setup: replay a session through the gateway (builds temporal storage,
 * distillations, embeddings). Each run: send a QA question through the
 * warmed-up gateway which provides LTM injection, recall tool, and
 * distilled context.
 */
import { createHarness } from "vitest-evals";
import type { ScenarioDefinition, ConversationTurn } from "./types";
import type { GatewayHandle } from "./harness";
import { QA_SYSTEM } from "./baselines";

// ---------------------------------------------------------------------------
// Module-level state — set by setup(), consumed by harness runs
// ---------------------------------------------------------------------------

let gateway: GatewayHandle | undefined;
let loreContext: string | undefined;
let activeModel: string = "claude-sonnet-4-6";

// Re-export for eval files
export type { GatewayHandle };

// ---------------------------------------------------------------------------
// Standard tools (ensures requests pass isMetaRequest check)
// ---------------------------------------------------------------------------

const STANDARD_TOOLS = [
  {
    name: "bash",
    description: "Run a shell command",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "read",
    description: "Read a file",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "write",
    description: "Write a file",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
];

// ---------------------------------------------------------------------------
// Gateway lifecycle
// ---------------------------------------------------------------------------

export async function startGateway(): Promise<GatewayHandle> {
  const { unlinkSync, existsSync } = await import("node:fs");

  const dbPath = `/tmp/lore-eval-live-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  process.env.LORE_DB_PATH = dbPath;

  const port = 20000 + Math.floor(Math.random() * 30000);
  process.env.LORE_LISTEN_PORT = String(port);
  process.env.LORE_IDLE_TIMEOUT = process.env.LORE_IDLE_TIMEOUT ?? "5";
  process.env.LORE_BATCH_DISABLED = "1";
  if (!process.env.LORE_DEBUG) process.env.LORE_DEBUG = "false";

  const { startServer } = await import("../../gateway/src/server");
  const { loadConfig } = await import("../../gateway/src/config");
  const { close: closeDB } = await import("@loreai/core");
  const { resetPipelineState } = await import("../../gateway/src/pipeline");

  closeDB();
  await resetPipelineState();

  const config = loadConfig();
  const server = startServer(config);
  const baseURL = `http://127.0.0.1:${server.port}`;

  console.log(`  Gateway started at ${baseURL} (db: ${dbPath})`);

  return {
    baseURL,
    isReal: true,
    async chat(requestBody, headers) {
      return fetch(`${baseURL}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY ?? "eval-key",
          "anthropic-version": "2023-06-01",
          ...headers,
        },
        body: JSON.stringify(requestBody),
      });
    },
    async teardown() {
      server.stop();
      closeDB();
      await resetPipelineState();
      for (const suffix of ["", "-shm", "-wal"]) {
        const file = `${dbPath}${suffix}`;
        try {
          if (existsSync(file)) unlinkSync(file);
        } catch {
          /* best-effort */
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Session replay (reuses existing infrastructure)
// ---------------------------------------------------------------------------

export async function replayAndWarmup(
  scenario: ScenarioDefinition,
  model: string,
): Promise<void> {
  activeModel = model;
  gateway = await startGateway();

  const { setUpstreamInterceptor } = await import("../../gateway/src/pipeline");

  for (const session of scenario.sessions) {
    // Build scripted interceptor
    const assistantTurns = session.turns.filter(
      (t) => t.role === "assistant" && !t.isFiller,
    );
    let counter = 0;

    setUpstreamInterceptor(async () => {
      if (counter >= assistantTurns.length) {
        return new Response(
          JSON.stringify({
            id: `msg_eval_scripted_${counter}`,
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "[end of scripted session]" }],
            model,
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      const turn = assistantTurns[counter++];
      const content = turn.content.map((part) => {
        switch (part.type) {
          case "text":
            return { type: "text" as const, text: part.text };
          case "tool_use":
            return {
              type: "tool_use" as const,
              id: part.id,
              name: part.name,
              input: part.input,
            };
          default:
            return { type: "text" as const, text: `[${part.type}]` };
        }
      });
      const hasToolUse = content.some((b) => b.type === "tool_use");
      return new Response(
        JSON.stringify({
          id: `msg_eval_scripted_${counter}`,
          type: "message",
          role: "assistant",
          content,
          model,
          stop_reason: hasToolUse ? "tool_use" : "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: turn.tokens ?? 100,
            output_tokens: Math.ceil((turn.tokens ?? 100) * 0.3),
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    // Replay turns
    const { replaySession } = await import("./harness");
    await replaySession(session, gateway, { model });

    setUpstreamInterceptor(undefined);

    // Force curation
    await gateway.chat({
      model,
      system: "",
      messages: [{ role: "user", content: "/lore:curate" }],
      tools: [],
      max_tokens: 256,
      stream: false,
    });
  }

  // Backfill embeddings
  try {
    const { embedding } = await import("@loreai/core");
    const kn = await embedding.backfillEmbeddings();
    const dist = await embedding.backfillDistillationEmbeddings();
    if (kn > 0 || dist > 0) {
      console.log(
        `  [embedding] backfill: ${kn} knowledge, ${dist} distillations`,
      );
    }
  } catch {
    /* best-effort */
  }

  // Build lore context for QA preamble
  const { buildLoreContext } = await import("./harness");
  const allTurns = scenario.sessions.flatMap((s) => s.turns);
  loreContext = await buildLoreContext(allTurns);

  console.log(
    `  Warmup complete: context ${Math.round((loreContext?.length ?? 0) / 4)} tok`,
  );
}

export async function teardownGateway(): Promise<void> {
  if (gateway?.teardown) await gateway.teardown();
  gateway = undefined;
  loreContext = undefined;
}

// ---------------------------------------------------------------------------
// vitest-evals harness
// ---------------------------------------------------------------------------

export const loreEvalHarness = createHarness<string, string>({
  name: "lore",
  run: async ({ input }) => {
    if (!gateway)
      throw new Error(
        "Gateway not started — call replayAndWarmup() in beforeAll",
      );

    const contextPreamble = loreContext
      ? `Here are distilled observations and conversation context from previous coding sessions:\n\n${loreContext}\n\n`
      : "";

    const requestBody = {
      model: activeModel,
      system: QA_SYSTEM,
      messages: [
        {
          role: "user",
          content: `${contextPreamble}Answer this question about our previous coding sessions. Be specific and factual. If you don't have enough information, say so.\n\nQuestion: ${input}`,
        },
      ],
      tools: STANDARD_TOOLS,
      max_tokens: 2048,
      stream: false,
    };

    const resp = await gateway.chat(requestBody, {
      "x-lore-no-store": "true",
    });

    const data = (await resp.json()) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
    };

    const text =
      data.content
        ?.filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n")
        .trim() ?? "";

    const recallInvoked = resp.headers.get("x-lore-recall-invoked") === "true";

    return {
      output: text,
      usage: {
        provider: "anthropic",
        model: activeModel,
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
      },
      metadata: { recallInvoked },
    };
  },
});
