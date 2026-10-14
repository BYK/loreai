import { describe, expect, test } from "vitest";
import {
  parseOpenAIResponsesRequest,
  parseOpenAIResponsesRequestChunks,
} from "../src/translate/openai-responses";
import { encodeContextBoundary } from "../src/context-boundary";
import { digestChain } from "../src/chain-digest";

const signedIn = {
  authorization: "Bearer fake-chatgpt-token",
  "chatgpt-account-id": "fake-account",
};
const body = {
  model: "gpt-test",
  input: [{ role: "user", content: "hello" }],
  include: ["reasoning.encrypted_content"],
  prompt_cache_key: "fake-cache-key",
  service_tier: "auto",
};

async function* chunks(value: unknown): AsyncGenerator<Uint8Array> {
  const bytes = Buffer.from(JSON.stringify(value));
  for (let offset = 0; offset < bytes.length; offset += 7) {
    yield bytes.subarray(offset, offset + 7);
  }
}

describe("Codex Desktop authentication inference boundaries", () => {
  test.each<{ name: string; headers: Record<string, string> }>([
    {
      name: "account absent",
      headers: { authorization: signedIn.authorization },
    },
    {
      name: "account empty",
      headers: { ...signedIn, "chatgpt-account-id": "" },
    },
    {
      name: "account whitespace",
      headers: { ...signedIn, "chatgpt-account-id": "   " },
    },
    { name: "auth absent", headers: { "chatgpt-account-id": "fake-account" } },
    {
      name: "nonbearer auth",
      headers: { ...signedIn, authorization: "Basic fake-token" },
    },
    {
      name: "empty bearer",
      headers: { ...signedIn, authorization: "Bearer " },
    },
    {
      name: "API-key header",
      headers: {
        "chatgpt-account-id": "fake-account",
        "x-api-key": "fake-api-key",
      },
    },
    {
      name: "conflicting auth",
      headers: { ...signedIn, "x-api-key": "fake-api-key" },
    },
    {
      name: "explicit API provider",
      headers: { ...signedIn, "x-lore-provider": "openai" },
    },
    {
      name: "invalid explicit provider",
      headers: { ...signedIn, "x-lore-provider": "invalid/provider" },
    },
    {
      name: "explicit custom upstream",
      headers: {
        ...signedIn,
        "x-lore-upstream-url": "https://proxy.example/v1",
      },
    },
    {
      name: "invalid explicit upstream",
      headers: { ...signedIn, "x-lore-upstream-url": "file:///private/token" },
    },
  ])(
    "does not infer ChatGPT for $name in either parser",
    async ({ headers }) => {
      const parsed = parseOpenAIResponsesRequest(body, headers);
      expect(parsed.codex).not.toBe(true);
      expect(parsed.extras).not.toHaveProperty("include");
      expect(
        await parseOpenAIResponsesRequestChunks(chunks(body), headers),
      ).toEqual(parsed);
    },
  );

  test("both parsers capture Codex controls for an authenticated account", async () => {
    const parsed = parseOpenAIResponsesRequest(body, signedIn);
    expect(parsed.codex).toBe(true);
    expect(parsed.extras).toMatchObject({
      include: body.include,
      prompt_cache_key: body.prompt_cache_key,
      service_tier: body.service_tier,
    });
    expect(
      await parseOpenAIResponsesRequestChunks(chunks(body), signedIn),
    ).toEqual(parsed);
  });

  test("inferred ChatGPT checkpoints use the same Codex mode in both parsers", async () => {
    const first = parseOpenAIResponsesRequest(body, signedIn);
    const source = first.sourceInput;
    if (!source) throw new Error("Missing source-input checkpoint metadata");
    const fields = {
      v: 1 as const,
      inputItems: source.itemCount,
      inputDigest: source.inputDigest,
      retainedItems: 0,
      sourceMessages: first.messages.length,
      sourceDigest: digestChain(first.messages),
    };
    const headers = {
      ...signedIn,
      "x-lore-context-boundary": encodeContextBoundary({
        ...fields,
        protocol: "openai-codex",
      }),
    };
    const suffix = { ...body, input: [{ role: "user", content: "continue" }] };
    const parsed = parseOpenAIResponsesRequest(suffix, headers);
    expect(parsed.codex).toBe(true);
    expect(parsed.sourceInput?.itemCount).toBe(source.itemCount + 1);
    expect(parsed.sourceInput?.sourcePrefix).toEqual({
      messageCount: first.messages.length,
      sourceDigest: fields.sourceDigest,
    });
    expect(
      await parseOpenAIResponsesRequestChunks(chunks(suffix), headers),
    ).toEqual(parsed);

    const wrongProtocol = {
      ...signedIn,
      "x-lore-context-boundary": encodeContextBoundary({
        ...fields,
        protocol: "openai-responses",
      }),
    };
    expect(() => parseOpenAIResponsesRequest(suffix, wrongProtocol)).toThrow(
      "invalid for this protocol",
    );
    await expect(async () =>
      parseOpenAIResponsesRequestChunks(chunks(suffix), wrongProtocol),
    ).rejects.toThrow("invalid for this protocol");
  });
});
