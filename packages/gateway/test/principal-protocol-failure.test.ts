import { describe, expect, test } from "vitest";
import { parseSSEStream } from "../src/stream/anthropic";
import { trackResponsesReadBoundary } from "../src/principal-protocol-failure";

function readerFrom(text: string): ReadableStreamDefaultReader<Uint8Array> {
  const body = new Response(text).body;
  if (!body) throw new Error("missing test response body");
  return body.getReader();
}

describe("trackResponsesReadBoundary", () => {
  test("attributes a parser failure after a valid frame to the next read", async () => {
    const reader = readerFrom(
      'event: response.created\ndata: {"type":"response.created"}\n\n' +
        'event: response.completed\ndata: {"type":"response.completed"}',
    );
    let phase = "read";
    let eventKind = "none";
    const tracked = trackResponsesReadBoundary(
      parseSSEStream(reader, { requireEventTerminator: true }),
      () => {
        phase = "read";
        eventKind = "none";
      },
    );

    let seen = 0;
    await expect(async () => {
      for await (const event of tracked) {
        expect(event.event).toBe("response.created");
        seen++;
        phase = "accumulate";
        eventKind = "created";
      }
    }).rejects.toThrow("unterminated SSE event at EOF");
    expect(seen).toBe(1);
    expect({ phase, eventKind }).toEqual({ phase: "read", eventKind: "none" });
  });

  test("retains the current event when its validation fails", async () => {
    const reader = readerFrom(
      'event: response.created\ndata: {"type":"response.created"}\n\n',
    );
    let phase = "read";
    let eventKind = "none";
    const tracked = trackResponsesReadBoundary(parseSSEStream(reader), () => {
      phase = "read";
      eventKind = "none";
    });

    await expect(async () => {
      for await (const event of tracked) {
        eventKind = event.event === "response.created" ? "created" : "other";
        phase = "validate_response";
        throw new Error("invalid current event");
      }
    }).rejects.toThrow("invalid current event");
    expect({ phase, eventKind }).toEqual({
      phase: "validate_response",
      eventKind: "created",
    });
  });
});
