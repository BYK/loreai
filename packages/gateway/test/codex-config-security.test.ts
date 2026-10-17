import { describe, expect, test } from "vitest";
import {
  codexProviderValue,
  getCodexProviderValue,
  setCodexProviderValue,
} from "../src/cli/codex-config";

const BASE_URL = "http://127.0.0.1:3207/v1";
const PROVIDER = '[model_providers.lore_http]\nname = "Lore"\n';
const SECRET = "private-token";

function expectSafeError(operation: () => unknown): void {
  let failure: unknown;
  try {
    operation();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).not.toContain(SECRET);
}

describe("Codex configuration security", () => {
  test.each([
    [
      "prepare provider",
      (content: string) => codexProviderValue(content, BASE_URL),
    ],
    [
      "read provider backup",
      (content: string) => getCodexProviderValue(content),
    ],
    [
      "restore provider",
      (content: string) => setCodexProviderValue(content, null),
    ],
  ])(
    "%s does not expose credentials in malformed TOML errors",
    (_name, operation) => {
      const malformed = `[model_providers.private]\nexperimental_bearer_token = "${SECRET}" trailing\n`;
      expectSafeError(() => operation(malformed));
    },
  );

  test("malformed TOML inside a provider backup does not expose credentials", () => {
    const malformed = `${PROVIDER}experimental_bearer_token = "${SECRET}" trailing\n`;
    expectSafeError(() =>
      setCodexProviderValue(PROVIDER, JSON.stringify(malformed)),
    );
  });

  test("malformed JSON provider backup does not expose credentials", () => {
    expectSafeError(() => setCodexProviderValue(PROVIDER, SECRET));
  });

  test.each([
    "model_providers = []",
    "model_providers = 42",
    "model_providers = true",
    "model_providers = {}",
    "model_providers = { lore_http = [] }",
    "model_providers = { lore_http = 42 }",
    'model_providers = { lore_http = "private" }',
    '[model_providers.other]\nname = "Other"',
    '[mcp_servers.attacker]\ncommand = "unexpected-command"',
    'approval_policy = "never"',
  ])(
    "rejects a tampered provider backup with invalid scope or type: %s",
    (block) => {
      expect(() =>
        setCodexProviderValue(PROVIDER, JSON.stringify(block)),
      ).toThrow();
    },
  );

  test("allows provider removal and exact restoration of a valid provider", () => {
    expect(setCodexProviderValue(PROVIDER, null)).not.toContain("lore_http");
    expect(setCodexProviderValue(PROVIDER, JSON.stringify(PROVIDER))).toBe(
      PROVIDER,
    );
  });
});
