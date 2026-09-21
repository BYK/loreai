import { afterEach, describe, expect, test, vi } from "vitest";
import * as core from "@loreai/core";
import { db, ltm, loadSessionTracking, temporal } from "@loreai/core";
import { getSessionCosts } from "../src/cost-tracker";
import {
  buildStreamingResponse,
  handleRequest,
  setRecallPersistenceCommitObserverForTest,
  setUpstreamInterceptor,
} from "../src/pipeline";
import type * as coreConfig from "../../core/src/config";
import {
  prepareProductiveRecallSources,
  TEST_RECALL_EXECUTION_CAP,
  FINAL_RECALL_CALL,
  providerResponse,
  request,
  config,
  knowledge,
  stateFor,
  settled,
  resetRecallBufferedForTest,
} from "./helpers/recall-buffered";

// These tests assert on recall/buffered-transaction behaviour, never on
// vectors; skip the ONNX embedding provider so stored messages bypass the
// embedding worker (cuts ~40% of the file's wall time).
vi.mock("../../core/src/config", async (importOriginal) => {
  const mod = await importOriginal<typeof coreConfig>();
  return {
    ...mod,
    config: () => {
      const c = mod.config();
      c.search.embeddings.enabled = false;
      return c;
    },
  };
});

afterEach(resetRecallBufferedForTest);

describe.each([
  ["anthropic", false],
  ["openai", false],
  ["openai-responses", false],
  ["openai-responses", true],
] as const)("buffered recall transaction: %s codex=%s", (protocol, codex) => {
  test.each(["answer", "mixed", "fallback"] as const)(
    "commits %s anchors and real transfers only after downstream EOF",
    async (outcome) => {
      const id = knowledge();
      prepareProductiveRecallSources();
      const alias = crypto.randomUUID();
      let calls = 0;
      setUpstreamInterceptor(async (body) => {
        calls++;
        expect(stateFor(alias).recallStore.size).toBe(0);
        expect(ltm.transferCount(id)).toBe(0);
        if (outcome === "fallback" && calls === 2)
          return new Response("failure", { status: 503 });
        return providerResponse(
          protocol,
          calls,
          outcome === "mixed"
            ? "mixed"
            : calls === FINAL_RECALL_CALL
              ? "answer"
              : "recall",
          (body as Record<string, unknown>).stream === true,
        );
      });
      const response = await handleRequest(
        request(protocol, alias, codex),
        config(),
      );
      const state = stateFor(alias);
      expect(response.status).toBe(200);
      expect(state.recallStore.size).toBe(0);
      expect(ltm.transferCount(id)).toBe(0);
      const body = await response.text();
      await settled();
      expect(calls).toBe(
        outcome === "answer" ? FINAL_RECALL_CALL : outcome === "mixed" ? 1 : 2,
      );
      expect(body).toContain(
        outcome === "answer"
          ? "Completed answer"
          : outcome === "mixed"
            ? "Read"
            : "lore-recall:",
      );
      if (protocol === "openai-responses" && outcome !== "answer") {
        const envelope = JSON.parse(body);
        expect(body).toContain("lore-recall:");
        expect(
          envelope.output.some(
            (item: Record<string, unknown>) =>
              item.type === "function_call" && item.name === "recall",
          ),
        ).toBe(false);
      }
      expect(state.recallStore.size).toBe(
        outcome === "answer" ? TEST_RECALL_EXECUTION_CAP : 1,
      );
      expect(
        JSON.parse(loadSessionTracking(state.sessionID)!.recallStore!).length,
      ).toBe(state.recallStore.size);
      expect(ltm.transferCount(id)).toBeGreaterThan(0);
      expect(getSessionCosts(state.sessionID)?.conversation.turns).toBe(1);
      ltm.remove(id);
    },
  );

  test.each(["cancel", "no-store"] as const)(
    "discards successful recall writes on %s",
    async (mode) => {
      const id = knowledge();
      const alias = crypto.randomUUID();
      let calls = 0;
      setUpstreamInterceptor(async (body) =>
        providerResponse(
          protocol,
          ++calls,
          calls === 2 ? "answer" : "recall",
          (body as Record<string, unknown>).stream === true,
        ),
      );
      const req = request(protocol, alias, codex);
      if (mode === "no-store") req.rawHeaders["x-lore-no-store"] = "true";
      const response = await handleRequest(req, config());
      expect(response.status).toBe(200);
      if (mode === "cancel") await response.body!.cancel();
      else await response.text();
      await settled();
      const state = stateFor(alias);
      expect(calls).toBe(2);
      expect(state.recallStore.size).toBe(0);
      expect(
        loadSessionTracking(state.sessionID)?.recallStore ?? null,
      ).toBeNull();
      expect(ltm.transferCount(id)).toBe(0);
      expect(
        db()
          .query(
            "SELECT COUNT(*) AS count FROM temporal_messages WHERE session_id = ? AND role = 'assistant'",
          )
          .get(state.sessionID),
      ).toEqual({ count: 0 });
      expect(getSessionCosts(state.sessionID)?.conversation).toMatchObject({
        inputTokens: 6,
        outputTokens: 4,
        turns: 1,
      });
      ltm.remove(id);
    },
  );

  test.each(["storage", "commit"] as const)(
    "rolls back partial writes after %s failure",
    async (mode) => {
      const id = knowledge();
      const alias = crypto.randomUUID();
      let calls = 0;
      let commits = 0;
      if (mode === "storage")
        vi.spyOn(temporal, "store").mockImplementation(() => {
          throw new Error("injected storage failure");
        });
      setRecallPersistenceCommitObserverForTest(() => {
        commits++;
        throw new Error("injected commit failure");
      });
      setUpstreamInterceptor(async (body) =>
        providerResponse(
          protocol,
          ++calls,
          calls === 3 ? "answer" : "recall",
          (body as Record<string, unknown>).stream === true,
        ),
      );
      const response = await handleRequest(
        request(protocol, alias, codex),
        config(),
      );
      expect(response.status).toBe(200);
      await response.text();
      await settled();
      const state = stateFor(alias);
      expect(commits).toBe(mode === "commit" ? 1 : 0);
      expect(state.recallStore.size).toBe(0);
      expect(
        loadSessionTracking(state.sessionID)?.recallStore ?? null,
      ).toBeNull();
      expect(ltm.transferCount(id)).toBe(0);
      expect(
        db()
          .query(
            "SELECT COUNT(*) AS count FROM temporal_messages WHERE session_id = ?",
          )
          .get(state.sessionID),
      ).toEqual({ count: 0 });
      ltm.remove(id);
    },
  );

  test.each(["recall", "invalid", "bad-usage", "http"] as const)(
    "discards anchors and real transfers after final %s failure",
    async (outcome) => {
      const id = knowledge();
      prepareProductiveRecallSources();
      const alias = crypto.randomUUID();
      let calls = 0;
      setUpstreamInterceptor(async (body) => {
        calls++;
        if (calls === FINAL_RECALL_CALL && outcome === "http")
          return new Response("failure", { status: 503 });
        return providerResponse(
          protocol,
          calls,
          calls === FINAL_RECALL_CALL && outcome !== "http"
            ? outcome
            : "recall",
          (body as Record<string, unknown>).stream === true,
        );
      });
      const response = await handleRequest(
        request(protocol, alias, codex),
        config(),
      );
      expect(response.status).toBe(502);
      await response.text();
      await settled();
      const state = stateFor(alias);
      expect(calls).toBe(FINAL_RECALL_CALL);
      expect.soft(state.recallStore.size).toBe(0);
      expect
        .soft(
          (loadSessionTracking(state.sessionID)?.recallStore ?? null) === null,
        )
        .toBe(true);
      expect.soft(ltm.transferCount(id)).toBe(0);
      expect(
        db()
          .query(
            "SELECT COUNT(*) AS count FROM temporal_messages WHERE session_id = ? AND role = 'assistant'",
          )
          .get(state.sessionID),
      ).toEqual({ count: 0 });
      ltm.remove(id);
    },
  );

  test.each(["invalid", "bad-usage"] as const)(
    "accounts only validated final %s usage",
    async (outcome) => {
      const alias = crypto.randomUUID();
      prepareProductiveRecallSources();
      let calls = 0;
      setUpstreamInterceptor(async (body) =>
        providerResponse(
          protocol,
          ++calls,
          calls === FINAL_RECALL_CALL ? outcome : "recall",
          (body as Record<string, unknown>).stream === true,
        ),
      );
      const response = await handleRequest(
        request(protocol, alias, codex),
        config(),
      );
      expect(response.status).toBe(502);
      await response.text();
      await settled();
      expect(
        getSessionCosts(stateFor(alias).sessionID)?.conversation,
      ).toMatchObject({
        inputTokens:
          TEST_RECALL_EXECUTION_CAP * 3 + (outcome === "invalid" ? 1000 : 0),
        outputTokens:
          TEST_RECALL_EXECUTION_CAP * 2 + (outcome === "invalid" ? 100 : 0),
        turns: 1,
      });
    },
  );
});

test.each(["success", "cancel", "late-recall"] as const)(
  "standalone native recall delivery: %s",
  async (mode) => {
    const id = knowledge();
    const alias = crypto.randomUUID();
    const req = request("anthropic", alias);
    setUpstreamInterceptor(async () =>
      providerResponse("anthropic", 1, "answer"),
    );
    await (await handleRequest(req, config())).text();
    await settled();
    const state = stateFor(alias);
    const beforeTracking =
      loadSessionTracking(state.sessionID)?.recallStore ?? null;
    const recallStarted = Promise.withResolvers<void>();
    const releaseRecall = Promise.withResolvers<void>();
    const recallFinished = Promise.withResolvers<void>();
    if (mode === "late-recall") {
      const realRecall = core.runRecallWithMetadata;
      vi.spyOn(core, "runRecallWithMetadata").mockImplementationOnce(
        async (input) => {
          recallStarted.resolve();
          await releaseRecall.promise;
          try {
            // Model a non-cooperative in-flight search returning its real transfer
            // callback after cancellation; the gateway must discard it.
            return await realRecall({ ...input, signal: undefined });
          } finally {
            recallFinished.resolve();
          }
        },
      );
    }
    setUpstreamInterceptor(async () =>
      providerResponse("anthropic", 2, "answer", true),
    );
    const completed = vi.fn();
    const response = buildStreamingResponse(
      providerResponse("anthropic", 1, "recall", true),
      completed,
      {
        clientMessages: req.messages,
        modifiedReq: req,
        config: config(),
        sessionState: state,
        cacheOptions: {},
        clientSpeaksAnthropic: true,
      },
    );
    const reader = response.body!.getReader();
    if (mode === "late-recall") {
      const drain = (async () => {
        while (!(await reader.read()).done) {
          /* drive source */
        }
      })();
      await recallStarted.promise;
      await reader.cancel();
      releaseRecall.resolve();
      await recallFinished.promise;
      await drain;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(completed).not.toHaveBeenCalled();
    } else {
      let wire = "";
      do {
        const { done, value } = await reader.read();
        expect(done).toBe(false);
        wire += new TextDecoder().decode(value);
      } while ((wire.match(/^event: message_stop$/gm)?.length ?? 0) < 3);
      await vi.waitFor(() => expect(completed).toHaveBeenCalledTimes(1));
      expect(state.recallStore.size).toBe(0);
      expect(ltm.transferCount(id)).toBe(0);
      if (mode === "cancel") await reader.cancel();
      else expect((await reader.read()).done).toBe(true);
    }
    reader.releaseLock();
    expect(state.recallStore.size).toBe(mode === "success" ? 1 : 0);
    expect(ltm.transferCount(id)).toBe(mode === "success" ? 1 : 0);
    if (mode !== "success")
      expect(loadSessionTracking(state.sessionID)?.recallStore ?? null).toBe(
        beforeTracking,
      );
  },
);

describe.each(["anthropic", "openai", "openai-responses", "gemini"] as const)(
  "Anthropic streaming transfer retention for %s client",
  (client) => {
    test.each([true, false])("no-store=%s", async (noStore) => {
      const id = knowledge();
      const alias = crypto.randomUUID();
      const req = request(client, alias);
      req.stream = true;
      req.rawHeaders["x-lore-provider"] = "anthropic";
      req.rawHeaders["x-lore-upstream-url"] = "https://api.anthropic.com";
      req.rawHeaders["x-api-key"] = "test-key";
      delete req.rawHeaders.authorization;
      if (noStore) req.rawHeaders["x-lore-no-store"] = "true";
      let calls = 0;
      setUpstreamInterceptor(async () =>
        providerResponse(
          "anthropic",
          ++calls,
          calls === 1 ? "recall" : "answer",
          true,
        ),
      );
      const response = await handleRequest(req, config());
      expect(await response.text()).toContain("Completed answer");
      await settled();
      expect(calls).toBe(2);
      expect(ltm.transferCount(id)).toBe(noStore ? 0 : 1);
      expect(stateFor(alias).recallStore.size).toBe(noStore ? 0 : 1);
    });
  },
);
