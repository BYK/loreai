import { describe, expect, test } from "vitest";
import fc from "fast-check";
import {
  accumulateResponsesSSEStream,
  ResponsesTerminalError,
  streamResponsesPassthrough,
} from "../src/stream/openai-responses";
import { buildOpenAIResponsesResponse } from "../src/translate/openai-responses";

const limits = {
  type: "codex.rate_limits",
  plan_type: "pro",
  rate_limits: {
    primary: { used_percent: 12.5, window_minutes: 300, reset_at: 2000000000 },
    secondary: {
      used_percent: 75,
      window_minutes: 10080,
      reset_at: 2000100000,
    },
  },
  credits: { has_credits: true, unlimited: false, balance: "12.34" },
};

function upstream(
  events: Record<string, unknown>[],
  incomplete = false,
): Response {
  const status = incomplete ? "incomplete" : "completed";
  return new Response(
    [
      ...events,
      {
        type: `response.${status}`,
        response: {
          id: "resp_quota",
          model: "gpt-5",
          status,
          output: [],
          usage: { input_tokens: 600000, output_tokens: 1 },
          ...(incomplete
            ? { incomplete_details: { reason: "max_output_tokens" } }
            : {}),
        },
      },
    ]
      .map(
        (data) =>
          `event: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function quotaEvents(body: string): unknown[] {
  return body
    .split("\n\n")
    .filter((frame) => frame.startsWith("event: codex.rate_limits\n"))
    .map((frame) => JSON.parse(frame.split("\ndata: ")[1]));
}

describe("Codex subscription metadata", () => {
  test("preserves every metered bucket through buffered stream rebuilding", async () => {
    const events = [limits, { ...limits, metered_limit_name: "codex_spark" }];
    const response = await accumulateResponsesSSEStream(upstream(events), {
      validation: "codex",
      stopAtTerminal: true,
      requireCompletedTerminal: true,
    });
    const body = await buildOpenAIResponsesResponse(response, true).text();
    expect(quotaEvents(body)).toEqual(events);
    expect(body.indexOf("codex.rate_limits")).toBeLessThan(
      body.indexOf("event: response.completed"),
    );
  });

  test("preserves metadata on incomplete buffered terminals", async () => {
    let failure: ResponsesTerminalError | undefined;
    try {
      await accumulateResponsesSSEStream(upstream([limits], true), {
        validation: "codex",
        stopAtTerminal: true,
        requireCompletedTerminal: true,
      });
    } catch (error) {
      if (!(error instanceof ResponsesTerminalError)) throw error;
      failure = error;
    }
    expect(failure).toBeInstanceOf(ResponsesTerminalError);
    const body = await buildOpenAIResponsesResponse(
      failure!.response,
      true,
    ).text();
    expect(quotaEvents(body)).toEqual([limits]);
  });

  test("does not retain unrelated event fields or arbitrary events", async () => {
    const response = await accumulateResponsesSSEStream(
      upstream([
        {
          ...limits,
          authorization: "private-credential",
          debug: { secret: "private" },
        },
        { type: "codex.private_metadata", secret: "private" },
      ]),
      { validation: "codex", stopAtTerminal: true },
    );
    const body = await buildOpenAIResponsesResponse(response, true).text();
    expect(quotaEvents(body)).toEqual([limits]);
    expect(body).not.toContain("private");
  });

  test("does not retain metadata across responses or after the terminal", async () => {
    const first = await accumulateResponsesSSEStream(upstream([limits]), {
      validation: "codex",
      stopAtTerminal: true,
    });
    expect(
      quotaEvents(await buildOpenAIResponsesResponse(first, true).text()),
    ).toEqual([limits]);
    const second = await accumulateResponsesSSEStream(upstream([]), {
      validation: "codex",
      stopAtTerminal: true,
    });
    expect(
      quotaEvents(await buildOpenAIResponsesResponse(second, true).text()),
    ).toEqual([]);
    const terminalThenQuota = new Response(
      `${await upstream([]).text()}event: codex.rate_limits\ndata: ${JSON.stringify(limits)}\n\n`,
    );
    const afterTerminal = await accumulateResponsesSSEStream(
      terminalThenQuota,
      { validation: "codex", stopAtTerminal: true },
    );
    expect(
      quotaEvents(
        await buildOpenAIResponsesResponse(afterTerminal, true).text(),
      ),
    ).toEqual([]);
  });

  test("true streaming forwards quota events without duplication", async () => {
    const response = streamResponsesPassthrough(
      upstream([limits]),
      () => {},
      undefined,
      "codex",
    );
    expect(quotaEvents(await response.text())).toEqual([limits]);
  });

  test.each(Array.from({ length: 10 }, (_, seed) => seed))(
    "preserves ordered quota updates without changing consumption (seed %i)",
    async (seed) => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              metered_limit_name: fc.string({ maxLength: 30 }),
              used_percent: fc.double({ min: 0, max: 100, noNaN: true }),
              reset_at: fc.integer({ min: 1, max: 2147483647 }),
            }),
            { minLength: 1, maxLength: 20 },
          ),
          async (updates) => {
            const events = updates.map(
              ({ metered_limit_name, ...primary }) => ({
                type: "codex.rate_limits",
                metered_limit_name,
                rate_limits: { primary },
              }),
            );
            const accumulated = await accumulateResponsesSSEStream(
              upstream(events),
              {
                validation: "codex",
                stopAtTerminal: true,
              },
            );
            expect(accumulated.usage?.inputTokens).toBe(600000);
            const body = await buildOpenAIResponsesResponse(
              accumulated,
              true,
            ).text();
            expect(quotaEvents(body)).toEqual(events);
          },
        ),
        { seed, numRuns: 25 },
      );
    },
  );
});
