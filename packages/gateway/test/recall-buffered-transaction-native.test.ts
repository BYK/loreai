import { afterEach, describe, expect, test, vi } from "vitest";
import { db, ltm, loadSessionTracking, temporal } from "@loreai/core";
import { getSessionCosts } from "../src/cost-tracker";
import {
  handleRequest,
  setRecallPersistenceCommitObserverForTest,
  setUpstreamInterceptor,
  streamingPostResponsePendingForTest,
} from "../src/pipeline";
import type * as coreConfig from "../../core/src/config";
import {
  prepareProductiveRecallSources,
  TEST_RECALL_EXECUTION_CAP,
  FINAL_RECALL_CALL,
  providerResponse,
  responsesStream,
  anthropicStream,
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

describe.each(["anthropic", "openai", "openai-responses", "gemini"] as const)(
  "native Anthropic recall transaction for %s client",
  (client) => {
    test.each([false, true])(
      "mixed handoff waits for EOF (cancel=%s)",
      async (cancel) => {
        const id = knowledge();
        const alias = crypto.randomUUID();
        const req = request(client, alias);
        req.stream = true;
        req.rawHeaders["x-lore-provider"] = "anthropic";
        req.rawHeaders["x-lore-upstream-url"] = "https://api.anthropic.com";
        req.rawHeaders["x-api-key"] = "test-key";
        delete req.rawHeaders.authorization;
        setUpstreamInterceptor(async () =>
          providerResponse("anthropic", 1, "mixed", true),
        );
        const response = await handleRequest(req, config());
        const reader = response.body!.getReader();
        let wire = "";
        for (;;) {
          const { done, value } = await reader.read();
          expect(done).toBe(false);
          wire += new TextDecoder().decode(value);
          if (
            client === "anthropic"
              ? (wire.match(/^event: message_stop$/gm)?.length ?? 0) === 2
              : client === "openai"
                ? wire.includes("data: [DONE]")
                : client === "openai-responses"
                  ? wire.includes("event: response.completed")
                  : wire.includes('"finishReason":')
          )
            break;
        }
        await vi.waitFor(() =>
          expect(streamingPostResponsePendingForTest()).toBe(1),
        );
        const state = stateFor(alias);
        expect.soft(state.recallStore.size).toBe(0);
        expect
          .soft(loadSessionTracking(state.sessionID)?.recallStore ?? null)
          .toBeNull();
        expect.soft(ltm.transferCount(id)).toBe(0);
        if (cancel) await reader.cancel();
        else expect((await reader.read()).done).toBe(true);
        reader.releaseLock();
        await settled();
        expect(state.recallStore.size).toBe(cancel ? 0 : 1);
        expect(ltm.transferCount(id)).toBe(cancel ? 0 : 1);
        expect(getSessionCosts(state.sessionID)?.conversation).toMatchObject({
          inputTokens: 3,
          outputTokens: 2,
          turns: 1,
        });
      },
    );
    test.each([
      "answer",
      "mixed",
      "fallback",
      "exhausted",
      "cancel",
      "abort",
      "storage",
      "commit",
    ] as const)("stages effects through %s", async (mode) => {
      const id = knowledge();
      if (mode === "exhausted") prepareProductiveRecallSources();
      const alias = crypto.randomUUID();
      const req = request(client, alias);
      req.stream = true;
      req.rawHeaders["x-lore-provider"] = "anthropic";
      req.rawHeaders["x-lore-upstream-url"] = "https://api.anthropic.com";
      req.rawHeaders["x-api-key"] = "test-key";
      delete req.rawHeaders.authorization;
      const caller = new AbortController();
      req.signal = caller.signal;
      const continuationStarted = Promise.withResolvers<void>();
      const releaseContinuation = Promise.withResolvers<void>();
      const snapshots: Array<{
        anchors: number;
        tracking: string | null;
        transfers: number;
      }> = [];
      let calls = 0;
      let commits = 0;
      if (mode === "storage")
        vi.spyOn(temporal, "store").mockImplementation(() => {
          throw new Error("injected storage failure");
        });
      setRecallPersistenceCommitObserverForTest(() => {
        commits++;
        if (mode === "commit") throw new Error("injected commit failure");
      });
      setUpstreamInterceptor(async () => {
        calls++;
        const state = stateFor(alias);
        snapshots.push({
          anchors: state.recallStore.size,
          tracking: loadSessionTracking(state.sessionID)?.recallStore ?? null,
          transfers: ltm.transferCount(id),
        });
        if (calls === 2 && (mode === "cancel" || mode === "abort")) {
          continuationStarted.resolve();
          await releaseContinuation.promise;
        }
        if (mode === "fallback" && calls === 2)
          return new Response("failure", { status: 503 });
        return providerResponse(
          "anthropic",
          calls,
          mode === "mixed"
            ? "mixed"
            : mode !== "exhausted" && calls === 3
              ? "answer"
              : "recall",
          true,
        );
      });
      const response = await handleRequest(req, config());
      const reader = response.body!.getReader();
      let wire = "";
      let failure: unknown;
      const read = (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            wire += new TextDecoder().decode(value);
          }
        } catch (error) {
          failure = error;
        }
      })();
      try {
        if (mode === "cancel" || mode === "abort") {
          await continuationStarted.promise;
          if (mode === "cancel") await reader.cancel();
          else caller.abort(new DOMException("client cancelled", "AbortError"));
        }
      } finally {
        releaseContinuation.resolve();
      }
      await read;
      reader.releaseLock();
      await settled();
      const state = stateFor(alias);
      const successful =
        mode === "answer" || mode === "mixed" || mode === "fallback";
      expect(calls).toBe(
        mode === "exhausted"
          ? FINAL_RECALL_CALL
          : mode === "mixed"
            ? 1
            : ["cancel", "abort", "fallback"].includes(mode)
              ? 2
              : 3,
      );
      expect(snapshots).toEqual(
        snapshots.map(() => ({ anchors: 0, tracking: null, transfers: 0 })),
      );
      expect(state.recallStore.size).toBe(
        successful ? (mode === "answer" ? 2 : 1) : 0,
      );
      expect(ltm.transferCount(id)).toBe(successful ? 1 : 0);
      if (!successful)
        expect(
          loadSessionTracking(state.sessionID)?.recallStore ?? null,
        ).toBeNull();
      if (mode === "exhausted") {
        if (client === "openai-responses")
          expect(wire).toContain("event: response.failed");
        else expect(failure).toBeInstanceOf(Error);
      } else if (successful) {
        expect(failure).toBeUndefined();
        expect(wire).toContain(
          mode === "answer" ? "Completed answer" : "lore-recall:",
        );
        expect(
          JSON.parse(loadSessionTracking(state.sessionID)!.recallStore!).length,
        ).toBe(state.recallStore.size);
      }
      if (mode === "commit") expect(commits).toBe(1);
      if (mode === "storage") expect(commits).toBe(0);
      if (!successful)
        expect(
          db()
            .query(
              "SELECT COUNT(*) AS count FROM temporal_messages WHERE session_id = ? AND role = 'assistant'",
            )
            .get(state.sessionID),
        ).toEqual({ count: 0 });
    });
  },
);

describe.each([
  ["anthropic", false, "anthropic"],
  ["openai", false, "openai"],
  ["openai-responses", false, "openai-responses"],
  ["anthropic", true, "anthropic"],
  ["openai", true, "anthropic"],
  ["openai-responses", true, "anthropic"],
  ["gemini", true, "anthropic"],
  ["openai-responses", true, "openai-responses"],
] as const)(
  "blank final tool name: %s stream=%s upstream=%s",
  (client, stream, upstreamProtocol) => {
    test.each(["", " \t\n"])(
      "rejects name %j alone or with valid text",
      async (name) => {
        for (const withText of [false, true]) {
          const alias = crypto.randomUUID();
          prepareProductiveRecallSources();
          const req = request(client, alias);
          req.stream = stream;
          if (upstreamProtocol === "anthropic") {
            req.rawHeaders["x-lore-provider"] = "anthropic";
            req.rawHeaders["x-lore-upstream-url"] = "https://api.anthropic.com";
            req.rawHeaders["x-api-key"] = "test-key";
            delete req.rawHeaders.authorization;
          }
          let calls = 0;
          setUpstreamInterceptor(async (body) => {
            calls++;
            const upstreamStream =
              (body as Record<string, unknown>).stream === true;
            if (calls < FINAL_RECALL_CALL)
              return providerResponse(
                upstreamProtocol,
                calls,
                "recall",
                upstreamStream,
              );
            const json = await providerResponse(
              upstreamProtocol,
              calls,
              "mixed",
            ).json();
            if (upstreamProtocol === "anthropic") {
              json.content = [
                { ...json.content[0], name },
                ...(withText
                  ? [{ type: "text", text: "Completed answer" }]
                  : []),
              ];
            } else if (upstreamProtocol === "openai") {
              const message = json.choices[0].message;
              message.tool_calls = [
                {
                  ...message.tool_calls[0],
                  function: { ...message.tool_calls[0].function, name },
                },
              ];
              message.content = withText ? "Completed answer" : null;
            } else {
              json.output = [
                { ...json.output[0], name },
                ...(withText
                  ? [
                      {
                        type: "message",
                        id: "msg_final_text",
                        role: "assistant",
                        status: "completed",
                        content: [
                          { type: "output_text", text: "Completed answer" },
                        ],
                      },
                    ]
                  : []),
              ];
            }
            return upstreamStream
              ? upstreamProtocol === "anthropic"
                ? anthropicStream(json)
                : responsesStream(json)
              : Response.json(json);
          });
          const response = await handleRequest(req, config());
          if (stream) {
            const reader = response.body!.getReader();
            let received = "";
            let failure: unknown;
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                received += new TextDecoder().decode(value);
              }
            } catch (error) {
              failure = error;
            } finally {
              reader.releaseLock();
            }
            // Responses may represent failure on the wire; neither failure
            // form may deliver a successful terminal to an incremental reader.
            if (
              client === "openai-responses" &&
              received.includes("event: response.failed")
            ) {
              expect(received.match(/^event: response.failed$/gm)).toHaveLength(
                1,
              );
            } else expect(failure).toBeInstanceOf(Error);
            if (client === "anthropic") {
              expect(received.match(/^event: message_stop$/gm)).toHaveLength(
                TEST_RECALL_EXECUTION_CAP * 2,
              );
            } else {
              expect(received).not.toContain("data: [DONE]");
              expect(received).not.toContain("event: response.completed");
              expect(received).not.toMatch(/"finish_reason":"|"finishReason":/);
            }
          } else {
            expect(response.status).toBe(502);
            await response.text();
          }
          await settled();
          expect(calls).toBe(FINAL_RECALL_CALL);
          expect(
            db()
              .query(
                "SELECT COUNT(*) AS count FROM temporal_messages WHERE session_id = ? AND role = 'assistant'",
              )
              .get(stateFor(alias).sessionID),
          ).toEqual({ count: 0 });
        }
      },
    );
  },
);
