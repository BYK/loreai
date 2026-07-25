/**
 * End-to-end integration test for the compact-endpoint cancel decision.
 *
 * Closes Finding 12 from the adversarial review on PR #1482: the unit tests
 * for `shouldCancelCompactionFromBudget` and the 4 schema-validation tests
 * in `compact-endpoint.test.ts` do not exercise the call-site plumbing that
 * resolves the session's `lastUpstream` and feeds it into the helper. This
 * file drives a real chat turn through a real gateway, then exercises the
 * full POST /v1/compact path end-to-end to confirm the gateway's cancel
 * decision is wired up correctly.
 *
 * No test-only session setter is used — the session is populated organically
 * via a real chat turn carrying the same `x-lore-session-id` header as the
 * subsequent compact POST, the same way a real production session would be
 * identified. The cancel decision is the same code path the Pi plugin hits
 * via `runCompaction`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./helpers/harness";
import { makeFixtureEntry } from "./helpers/fixtures";

async function postCompact(
  baseURL: string,
  body: string,
  sessionID: string,
): Promise<Response> {
  return fetch(`${baseURL}/v1/compact`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Tier-1 session header: ensures both the chat and the compact POST
      // resolve to the SAME session (otherwise the compact POST, with
      // empty messages, has a different fingerprint and would mint a new
      // session with no lastUpstream).
      "x-lore-session-id": sessionID,
    },
    body,
  });
}

async function chatWithSession(
  harness: Harness,
  body: Record<string, unknown>,
  sessionID: string,
  providerID = "anthropic",
): Promise<Response> {
  return harness.chat(body, "test-key", {
    "x-lore-session-id": sessionID,
    // Real Pi / OpenCode / Claude Code clients send `x-lore-provider` so the
    // gateway can resolve the provider-qualified model entry (which carries
    // the right context/output limits). Without this header the compact
    // endpoint falls back to a flat last-write-wins entry that has a more
    // conservative output reserve (128K vs 64K), which would skew budget
    // assertions. We send it here to mirror production traffic.
    "x-lore-provider": providerID,
  });
}

/**
 * Build a chat body that the gateway will route through the full pipeline
 * (handleConversationTurn) rather than the meta-request passthrough path.
 *
 * `isMetaRequest` (compaction.ts:442) uses a heuristic score: too few tools
 * (≤2), too few messages (≤2), too-short system prompt (<500 chars), and too-
 * low maxTokens (≤300) all push the score over the 8-point meta threshold. A
 * real conversation turn has the opposite profile. This helper builds a body
 * that scores safely under the threshold so the harness actually exercises
 * the real session creation / LTM injection / `lastUpstream` recording path.
 */
function realConversationBody(model: string): Record<string, unknown> {
  return {
    model,
    max_tokens: 1024,
    stream: false,
    // A long system prompt (>500 chars) trips the SCORE_SHORT_SYSTEM check
    // and forces the request into the full conversation pipeline.
    system:
      "You are a helpful coding assistant. Help the user with their software " +
      "engineering tasks. Use best practices, write clean code, and always " +
      "consider edge cases. Prefer to read existing files before making " +
      "changes, and run tests after any modification. The user's project uses " +
      "pure Python stdlib only — never install third-party packages. Be concise " +
      "and explain your reasoning. Use the available tools when appropriate, " +
      "and don't fabricate tool results. When you have completed a task, " +
      "summarize what you did and any follow-up actions. If you're unsure, " +
      "ask clarifying questions rather than guessing.",
    // >2 messages also defeats the SCORE_FEW_MESSAGES heuristic.
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there, how can I help?" },
      { role: "user", content: "tell me about your project structure" },
      { role: "assistant", content: "I don't have a project yet" },
      { role: "user", content: "ok, can you create a hello world in python?" },
    ],
    // A long max_tokens (>300) defeats the SCORE_LOW_MAX_TOKENS heuristic.
  };
}

describe("POST /v1/compact — integration (real session populated via chat turn)", () => {
  let harness: Harness;
  // Project path bound to the chat() call. The compact POST must use the
  // SAME project_path in its body so both calls resolve to the same session.
  // The harness defaults projectPath to process.cwd() but does not expose it
  // on the public Harness interface; we mirror it here.
  const PROJECT_PATH = process.cwd();

  afterEach(async () => {
    await harness?.teardown();
  });

  it("returns { cancel: true } when tokensBefore fits the session's lastUpstream budget", async () => {
    harness = await createHarness({
      fixtures: [
        makeFixtureEntry({
          seq: 0,
          requestMessages: [{ role: "user", content: "hello" }],
          responseText: "hi",
          model: "claude-sonnet-4-6",
        }),
      ],
      projectPath: PROJECT_PATH,
    });

    const sessionID = "test-session-cancel-1";
    const chatResp = await chatWithSession(
      harness,
      realConversationBody("claude-sonnet-4-6"),
      sessionID,
    );
    expect(chatResp.status).toBe(200);

    // 50_000 tokens fits in claude-sonnet-4-6's 872K budget (1M context
    // minus 128K output) — the gateway should cancel and skip the summary.
    const compactResp = await postCompact(
      harness.baseURL,
      JSON.stringify({
        project_path: PROJECT_PATH,
        tokens_before: 50_000,
      }),
      sessionID,
    );
    expect(compactResp.status).toBe(200);
    const body = (await compactResp.json()) as { cancel?: boolean; summary?: string };
    expect(body.cancel).toBe(true);
    expect(body.summary).toBeUndefined();
  });

  it("cancels at the exact budget boundary (872K for Sonnet 1M / 128K output)", async () => {
    // models.dev: claude-sonnet-4-6 (anthropic) has limit { context: 1_000_000,
    // output: 128_000 } — verified via direct getModelEntrySyncForProvider call
    // in this test file's development history. Earlier unit tests that
    // asserted output=64K were hitting a stale or differently-keyed entry.
    // The current production spec is 128K output; the cancel boundary is at
    // 1_000_000 - 128_000 = 872_000.
    harness = await createHarness({
      fixtures: [
        makeFixtureEntry({
          seq: 0,
          requestMessages: [{ role: "user", content: "hello" }],
          responseText: "hi",
          model: "claude-sonnet-4-6",
        }),
      ],
      projectPath: PROJECT_PATH,
    });

    const sessionID = "test-session-cancel-boundary";
    const chatResp = await chatWithSession(
      harness,
      realConversationBody("claude-sonnet-4-6"),
      sessionID,
    );
    expect(chatResp.status).toBe(200);

    // Exactly at the budget: budget = 1_000_000 - 128_000 = 872_000. The
    // boundary is INCLUSIVE — see shouldCancelCompactionFromBudget docstring.
    const compactResp = await postCompact(
      harness.baseURL,
      JSON.stringify({
        project_path: PROJECT_PATH,
        tokens_before: 872_000,
      }),
      sessionID,
    );
    expect(compactResp.status).toBe(200);
    const body = (await compactResp.json()) as { cancel?: boolean; summary?: string };
    expect(body.cancel).toBe(true);
  });

  it("returns a summary path (cancel:false) when tokensBefore exceeds the budget", async () => {
    harness = await createHarness({
      fixtures: [
        makeFixtureEntry({
          seq: 0,
          requestMessages: [{ role: "user", content: "hello" }],
          responseText: "hi",
          model: "claude-sonnet-4-6",
        }),
      ],
      projectPath: PROJECT_PATH,
    });

    const sessionID = "test-session-cancel-overflow";
    const chatResp = await chatWithSession(
      harness,
      realConversationBody("claude-sonnet-4-6"),
      sessionID,
    );
    expect(chatResp.status).toBe(200);

    // 873_000 tokens exceeds the 872K budget by 1. The gateway should fall
    // through to the summary path. The summary itself may be null (worker
    // model unavailable in tests) — what we care about is that the CANCEL
    // signal is absent and the gateway attempted (or attempted to attempt)
    // a summary rather than silently canceling.
    const compactResp = await postCompact(
      harness.baseURL,
      JSON.stringify({
        project_path: PROJECT_PATH,
        tokens_before: 873_000,
      }),
      sessionID,
    );
    expect(compactResp.status).toBe(200);
    const body = (await compactResp.json()) as { cancel?: boolean; summary?: string };
    expect(body.cancel).toBeFalsy();
  });

  it("uses a smaller-context model's budget (GPT-4o-mini 128K / 16K → 112K budget)", async () => {
    // models.dev: gpt-4o-mini (openai) has limit { context: 128_000,
    // output: 16_384 } — verified via direct getModelEntrySyncForProvider call
    // in this test file's development history. Earlier unit tests that
    // asserted context=200K/output=8K were hitting a stale or differently-
    // keyed entry. The current production spec is 128K / 16K; the cancel
    // boundary is at 128_000 - 16_384 = 111_616.
    //
    // The model-aware design: 100K input on a 111K budget cancels; 130K input
    // on a 111K budget must compact. This is the test that proves we are
    // NOT hardcoded to 200K (the bug the prior client-side design had).
    harness = await createHarness({
      fixtures: [
        makeFixtureEntry({
          seq: 0,
          requestMessages: [{ role: "user", content: "hello" }],
          responseText: "hi",
          model: "gpt-4o-mini",
        }),
      ],
      projectPath: PROJECT_PATH,
    });

    const sessionID = "test-session-cancel-gpt-mini";
    const chatResp = await chatWithSession(
      harness,
      realConversationBody("gpt-4o-mini"),
      sessionID,
      "openai",
    );
    expect(chatResp.status).toBe(200);

    // 100K fits in 111_616 budget → cancel.
    const cancelResp = await postCompact(
      harness.baseURL,
      JSON.stringify({
        project_path: PROJECT_PATH,
        tokens_before: 100_000,
      }),
      sessionID,
    );
    expect(cancelResp.status).toBe(200);
    const cancelBody = (await cancelResp.json()) as { cancel?: boolean; summary?: string };
    expect(cancelBody.cancel).toBe(true);

    // 130K exceeds 111_616 budget → must compact (cancel:false).
    const compactResp = await postCompact(
      harness.baseURL,
      JSON.stringify({
        project_path: PROJECT_PATH,
        tokens_before: 130_000,
      }),
      sessionID,
    );
    expect(compactResp.status).toBe(200);
    const compactBody = (await compactResp.json()) as { cancel?: boolean; summary?: string };
    expect(compactBody.cancel).toBeFalsy();
  });
});
