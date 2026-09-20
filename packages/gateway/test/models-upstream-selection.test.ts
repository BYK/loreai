import { afterEach, describe, expect, test, vi } from "vitest";
import { loadConfig } from "../src/config";
import { upstreamFetch } from "../src/fetch";
import {
  handleModelsPassthrough,
  selectModelsUpstream,
} from "../src/routes/models";
import { setUpstreamInterceptor } from "../src/pipeline";

vi.mock("../src/fetch", () => ({ upstreamFetch: vi.fn() }));

const mockedFetch = vi.mocked(upstreamFetch);
const config = {
  ...loadConfig(),
  upstreamAnthropic: "https://a.test",
  upstreamOpenAI: "https://o.test",
};

function fetchUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function modelsRequest(headers?: Record<string, string>): Request {
  return new Request("http://gateway.test/v1/models", { headers });
}

afterEach(() => {
  mockedFetch.mockReset();
  setUpstreamInterceptor(undefined);
});

describe("selectModelsUpstream", () => {
  test.each([
    [
      { "x-api-key": "sk-ant" },
      { provider: "anthropic", url: "https://a.test/v1/models" },
    ],
    [
      { authorization: "Bearer tok", "anthropic-version": "2023-06-01" },
      { provider: "anthropic", url: "https://a.test/v1/models" },
    ],
    [
      { authorization: "Bearer sk-openai" },
      { provider: "openai", url: "https://o.test/v1/models" },
    ],
    [
      { authorization: "Basic abc" },
      { provider: "anthropic", url: "https://a.test/v1/models" },
    ],
    [
      { "x-goog-api-key": "g" },
      {
        provider: "gemini",
        url: "https://generativelanguage.googleapis.com/v1beta/models",
      },
    ],
    [{}, { provider: "anthropic", url: "https://a.test/v1/models" }],
    [
      { "x-api-key": "a", authorization: "Bearer b" },
      { provider: "anthropic", url: "https://a.test/v1/models" },
    ],
  ] satisfies [
    Record<string, string>,
    ReturnType<typeof selectModelsUpstream>,
  ][])("selects %s as %s", (headers, expected) => {
    expect(selectModelsUpstream(headers, config)).toEqual(expected);
  });
});

describe("handleModelsPassthrough", () => {
  test("routes Bearer-only requests to OpenAI without Anthropic headers", async () => {
    mockedFetch.mockResolvedValue(new Response('{"data":[]}'));

    const response = await handleModelsPassthrough(
      modelsRequest({ authorization: "Bearer sk-openai" }),
      config,
    );
    await response.text();

    expect(fetchUrl(mockedFetch.mock.calls[0]?.[0])).toBe(
      "https://o.test/v1/models",
    );
    expect(mockedFetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer sk-openai",
    });
    expect(mockedFetch.mock.calls[0]?.[1]?.headers).not.toHaveProperty(
      "anthropic-version",
    );
    expect(mockedFetch.mock.calls[0]?.[1]?.headers).not.toHaveProperty(
      "x-api-key",
    );
  });

  test("routes x-goog-api-key requests to Gemini", async () => {
    mockedFetch.mockResolvedValue(new Response('{"data":[]}'));

    const response = await handleModelsPassthrough(
      modelsRequest({ "x-goog-api-key": "g" }),
      config,
    );
    await response.text();

    expect(fetchUrl(mockedFetch.mock.calls[0]?.[0])).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models",
    );
    expect(mockedFetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      "x-goog-api-key": "g",
    });
  });

  test("forwards Anthropic credentials and version unchanged", async () => {
    mockedFetch.mockResolvedValue(new Response('{"data":[]}'));

    const response = await handleModelsPassthrough(
      modelsRequest({
        "x-api-key": "sk-ant",
        "anthropic-version": "2023-06-01",
      }),
      config,
    );
    await response.text();

    expect(fetchUrl(mockedFetch.mock.calls[0]?.[0])).toBe(
      "https://a.test/v1/models",
    );
    expect(mockedFetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      "x-api-key": "sk-ant",
      "anthropic-version": "2023-06-01",
    });
  });

  test("routes requests without auth to Anthropic", async () => {
    mockedFetch.mockResolvedValue(new Response('{"data":[]}'));

    const response = await handleModelsPassthrough(modelsRequest(), config);
    await response.text();

    expect(fetchUrl(mockedFetch.mock.calls[0]?.[0])).toBe(
      "https://a.test/v1/models",
    );
  });
});
