import fc from "fast-check";
import { expect, test } from "vitest";
import { digestChain } from "../src/chain-digest";
import { encodeContextBoundary } from "../src/context-boundary";
import {
  parseOpenAIResponsesRequest,
  parseOpenAIResponsesRequestChunks,
} from "../src/translate/openai-responses";

async function* chunks(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += 3) {
    yield bytes.subarray(offset, offset + 3);
  }
}

const text = fc.string({ maxLength: 24 });
const item = fc.oneof(
  text.map((content) => ({ type: "message", role: "user", content })),
  text.map((content) => ({ type: "message", role: "assistant", content })),
  fc.record({
    type: fc.constant("function_call"),
    call_id: fc.string({ minLength: 1, maxLength: 8 }),
    name: fc.string({ minLength: 1, maxLength: 8 }),
    arguments: fc.constant("{}"),
  }),
  fc.record({
    type: fc.constant("function_call_output"),
    call_id: fc.string({ minLength: 1, maxLength: 8 }),
    output: text,
  }),
  text.map((value) => ({
    type: "reasoning",
    summary: [{ type: "summary_text", text: value }],
  })),
  text.map((value) => ({ type: "custom_item", value })),
);

test("every advertised Responses item seam reconstructs the full normalization", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(item, { minLength: 2, maxLength: 12 }),
      async (items) => {
        const full = parseOpenAIResponsesRequest(
          { model: "gpt", input: items },
          {},
        );
        for (let split = 1; split < items.length; split++) {
          const prefix = parseOpenAIResponsesRequest(
            { model: "gpt", input: items.slice(0, split) },
            {},
          );
          const source = prefix.sourceInput;
          if (!source?.boundarySafe) continue;
          const boundary = encodeContextBoundary({
            v: 1,
            protocol: "openai-responses",
            inputItems: source.itemCount,
            inputDigest: source.inputDigest,
            retainedItems: source.retainedItems,
            sourceMessages: prefix.messages.length,
            sourceDigest: digestChain(prefix.messages),
          });
          const suffix = await parseOpenAIResponsesRequestChunks(
            chunks(
              Buffer.from(
                JSON.stringify({
                  model: "gpt",
                  input: items.slice(split),
                }),
              ),
            ),
            { "x-lore-context-boundary": boundary },
          );

          expect([...prefix.messages, ...suffix.messages]).toEqual(
            full.messages,
          );
        }
      },
    ),
    { numRuns: 150 },
  );
});
