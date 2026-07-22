import { describe, test, expect } from "vitest";

import { defaultModelForProvider } from "../src/worker-model";

describe("defaultModelForProvider", () => {
  test("anthropic → claude-sonnet WORKER_DEFAULTS entry", () => {
    const m = defaultModelForProvider("anthropic");
    expect(m.providerID).toBe("anthropic");
    expect(m.modelID).toBe("claude-sonnet-5");
  });

  test("openai → luna WORKER_DEFAULTS entry", () => {
    const m = defaultModelForProvider("openai");
    expect(m.providerID).toBe("openai");
    expect(m.modelID).toBe("gpt-5.6-luna");
  });

  test("openai-codex → codex-mini WORKER_DEFAULTS entry", () => {
    const m = defaultModelForProvider("openai-codex");
    expect(m.providerID).toBe("openai-codex");
    expect(m.modelID).toBe("gpt-5.1-codex-mini");
  });

  test("github-copilot → its WORKER_DEFAULTS entry", () => {
    const m = defaultModelForProvider("github-copilot");
    expect(m.providerID).toBe("github-copilot");
    expect(m.modelID).toBe("gpt-5.4-mini");
  });

  test("google/gemini → gemini fallback (no WORKER_DEFAULTS entry by design)", () => {
    expect(defaultModelForProvider("google")).toEqual({
      providerID: "google",
      modelID: "gemini-2.5-flash",
    });
    expect(defaultModelForProvider("gemini")).toEqual({
      providerID: "gemini",
      modelID: "gemini-2.5-flash",
    });
  });

  test("unknown provider → empty modelID (model resolution fills in)", () => {
    expect(defaultModelForProvider("some-vendor")).toEqual({
      providerID: "some-vendor",
      modelID: "",
    });
  });

  test("undefined provider → anthropic default", () => {
    const m = defaultModelForProvider(undefined);
    expect(m.providerID).toBe("anthropic");
    expect(m.modelID).toBe("claude-sonnet-5");
  });
});
