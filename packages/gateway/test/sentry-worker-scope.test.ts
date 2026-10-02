import { afterEach, describe, expect, test } from "vitest";
import * as Sentry from "@sentry/bun";
import { buildSentryOptions } from "../instrument";
import { emitCacheBustMetric, setSentryRequestContext } from "../src/sentry";
import {
  _resetForTest,
  _setNowForTest,
  recordWorkerFailure,
  type WorkerResponseDiagnostic,
} from "../src/worker-health";

describe("worker telemetry request scope", () => {
  afterEach(async () => {
    await Sentry.getClient()?.close();
    _resetForTest();
  });

  test("a rejected worker response never exports the request model or session ID", async () => {
    const privateModel = "private-model-sentinel";
    const privateSession = "private-session-sentinel";
    const privateAmbient = "private-ambient-sentinel";
    const sent: unknown[] = [];
    Sentry.init({
      ...buildSentryOptions(() => ({
        send(envelope) {
          sent.push(envelope);
          return Promise.resolve({ statusCode: 200 });
        },
        flush: () => Promise.resolve(true),
      })),
      integrations: () => [],
    });

    const diagnostic: WorkerResponseDiagnostic = {
      protocol: "anthropic",
      stage: "decode",
      content: "json",
      category: "malformed JSON body",
      finishReason: "n/a",
      httpStatus: 200,
    };
    await Sentry.withIsolationScope(async () => {
      setSentryRequestContext({
        authFingerprint: null,
        sessionID: privateSession,
        model: privateModel,
        upstreamUrl: "https://example.invalid/v1/messages",
        port: 3210,
        projectPath: "/private/project",
      });
      Sentry.setTag("caller_owned_marker", privateAmbient);
      expect(
        JSON.stringify(Sentry.getIsolationScope().getScopeData()),
      ).not.toContain(privateSession);
      recordWorkerFailure(
        privateSession,
        "lore-distill",
        "upstream-error",
        diagnostic,
      );
      recordWorkerFailure(privateSession, "lore-distill", "upstream-error");
      recordWorkerFailure(privateSession, "lore-distill", "upstream-error");
      await Sentry.flush(1000);
    });

    expect(JSON.stringify(sent)).toContain("Worker response rejected");
    expect(JSON.stringify(sent)).toContain("Worker health degraded");
    expect(JSON.stringify(sent)).not.toContain(privateModel);
    expect(JSON.stringify(sent)).not.toContain(privateSession);
    expect(JSON.stringify(sent)).not.toContain(privateAmbient);
  });

  test("a rejected worker response never inherits global-scope tags", async () => {
    const privateGlobal = "private-global-sentinel";
    const sent: unknown[] = [];
    const clock = { now: 1_000_000 };
    _setNowForTest(() => clock.now);
    Sentry.init({
      ...buildSentryOptions(() => ({
        send(envelope) {
          sent.push(envelope);
          return Promise.resolve({ statusCode: 200 });
        },
        flush: () => Promise.resolve(true),
      })),
      integrations: () => [],
    });
    Sentry.getGlobalScope().setTag("caller_owned_marker", privateGlobal);
    Sentry.getGlobalScope().setContext("caller_owned_scope", {
      marker: privateGlobal,
    });

    try {
      recordWorkerFailure("private-session", "lore-distill", "upstream-error", {
        protocol: "anthropic",
        stage: "decode",
        content: "json",
        category: "malformed JSON body",
        finishReason: "n/a",
        httpStatus: 200,
      });
      recordWorkerFailure("private-session", "lore-distill", "upstream-error");
      recordWorkerFailure("private-session", "lore-distill", "upstream-error");
      clock.now += 60 * 60_000;
      recordWorkerFailure("private-session", "lore-distill", "upstream-error");
      recordWorkerFailure("private-session", "lore-distill", "upstream-error");
      recordWorkerFailure("private-session", "lore-distill", "upstream-error");
      await Sentry.flush(1000);

      const outbound = JSON.stringify(sent);
      expect(outbound).toContain("Worker response rejected");
      expect(outbound).toContain("Worker health degraded");
      expect(outbound).toContain(
        "Worker health critical: sustained worker failure",
      );
      expect(outbound).toContain("malformed JSON body");
      expect(outbound).toContain('"httpStatus":200');
      expect(outbound).toContain('"response_stage":"decode"');
      expect(outbound).not.toContain(privateGlobal);
      expect(outbound).not.toContain("private-session");
    } finally {
      Sentry.getGlobalScope().setTag("caller_owned_marker", "");
      Sentry.getGlobalScope().setContext("caller_owned_scope", {});
    }
  });

  test("a gen-AI worker span never exports the request conversation ID", async () => {
    const privateSession = "private-conversation-sentinel";
    const privateModel = "private-worker-model-sentinel";
    const sent: unknown[] = [];
    Sentry.init({
      ...buildSentryOptions(() => ({
        send(envelope) {
          sent.push(envelope);
          return Promise.resolve({ statusCode: 200 });
        },
        flush: () => Promise.resolve(true),
      })),
      integrations: (defaults) =>
        defaults.filter((integration) => integration.name === "ConversationId"),
    });

    await Sentry.withIsolationScope(async () => {
      setSentryRequestContext({
        authFingerprint: null,
        sessionID: privateSession,
        model: privateModel,
        upstreamUrl: "https://example.invalid/v1/messages",
        port: 3210,
        projectPath: "/private/project",
      });
      await Sentry.startSpan(
        {
          name: `chat ${privateModel}`,
          op: "gen_ai.chat",
          attributes: { "gen_ai.operation.name": "chat" },
        },
        async () => {},
      );
      await Sentry.flush(1000);
    });

    expect(JSON.stringify(sent)).toContain("gen_ai.chat");
    expect(JSON.stringify(sent)).not.toContain(privateSession);
    expect(JSON.stringify(sent)).not.toContain(privateModel);
  });

  test("cache-bust metrics never export a caller-selected model", async () => {
    const privateModel = "private-metric-model-sentinel";
    const sent: unknown[] = [];
    Sentry.init({
      ...buildSentryOptions(() => ({
        send(envelope) {
          sent.push(envelope);
          return Promise.resolve({ statusCode: 200 });
        },
        flush: () => Promise.resolve(true),
      })),
      integrations: () => [],
    });

    emitCacheBustMetric("prefix-rewrite", 500, privateModel);
    await Sentry.flush(1000);

    expect(JSON.stringify(sent)).toContain("lore.cache_bust");
    expect(JSON.stringify(sent)).not.toContain(privateModel);
  });
});
