import { describe, expect, test } from "vitest";
import { parse } from "smol-toml";
import {
  CODEX_PROVIDER_BACKUP_KEY,
  codexProviderValue,
} from "../src/cli/codex-config";
import { setTopLevelKey, updateCodexConfig } from "../src/cli/setup";
import {
  buildTomlBackupBlock,
  prependTomlBackupBlock,
  refreshTomlBackupBlock,
  restoreTomlBackup,
} from "../src/cli/setup-backup";

const FIRST_URL = "http://127.0.0.1:3299/v1";
const NEXT_URL = "https://gateway.example/v1";

/** Mirror setup's backup-before-mutation order without touching user files. */
function setup(content: string, baseUrl: string): string {
  const prepared = refreshTomlBackupBlock(content, {
    openai_base_url: JSON.stringify(baseUrl),
    model_provider: '"lore_http"',
    model_auto_compact_token_limit: "999999999",
    [CODEX_PROVIDER_BACKUP_KEY]: codexProviderValue(content, baseUrl),
  });
  return prependTomlBackupBlock(
    updateCodexConfig(prepared.content, baseUrl),
    prepared.block,
  );
}

describe("Codex provider configuration adversarial cases", () => {
  test.each(["before", "after"])(
    "preserves quoted sibling provider ids containing dots %s the target",
    (position) => {
      const sibling =
        '[model_providers."lore_http.private"]\n# Keep private provider\nname = "Private"\nbase_url = "https://private.example/v1"\n';
      const target = '[model_providers.lore_http]\nname = "Lore"\n';
      const original =
        position === "before" ? sibling + target : target + sibling;
      const updated = updateCodexConfig(original, FIRST_URL);
      expect(updated).toContain(sibling);
      expect(parse(updated).model_providers).toMatchObject({
        "lore_http.private": {
          name: "Private",
          base_url: "https://private.example/v1",
        },
        lore_http: { supports_websockets: false },
      });
    },
  );

  test.each(['"""', "'''"])(
    "preserves assignment and table text inside %s multiline strings",
    (delimiter) => {
      const original = [
        `instructions = ${delimiter}`,
        'model_provider = "openai"',
        'openai_base_url = "https://example.invalid"',
        "model_auto_compact_token_limit = 123",
        "[model_providers.lore_http]",
        "supports_websockets = true",
        delimiter,
        "",
      ].join("\n");
      const updated = parse(updateCodexConfig(original, FIRST_URL));
      expect(updated.instructions).toBe(parse(original).instructions);
      expect(updated.model_provider).toBe("lore_http");
      expect(updated.openai_base_url).toBe(FIRST_URL);
      expect(updated.model_auto_compact_token_limit).toBe(999999999);
      expect(updated.model_providers).toMatchObject({
        lore_http: { supports_websockets: false },
      });
    },
  );

  test("upgrades a genuine legacy backup and restores the original after changing endpoints", () => {
    const original =
      '# Personal config\nmodel_provider = "proxy"\nopenai_base_url = "https://api.openai.com/v1"\nmodel_auto_compact_token_limit = 1000\n[model_providers.proxy]\nname = "Private proxy"\n';
    const legacyValues = {
      openai_base_url: JSON.stringify(FIRST_URL),
      model_auto_compact_token_limit: "999999999",
    };
    const block = buildTomlBackupBlock(original, legacyValues);
    expect(block).not.toBeNull();
    let legacy = original;
    for (const [key, value] of Object.entries(legacyValues)) {
      legacy = setTopLevelKey(legacy, key, value);
    }
    legacy = prependTomlBackupBlock(legacy, block!);
    const upgraded = setup(setup(legacy, FIRST_URL), NEXT_URL);
    expect(parse(upgraded).model_providers).toMatchObject({
      lore_http: { base_url: NEXT_URL, supports_websockets: false },
    });
    const restored = restoreTomlBackup(upgraded);
    expect(restored.summary.skipped).toEqual([]);
    expect(parse(restored.content)).toEqual(parse(original));
    expect(restored.content).toContain("# Personal config");
    expect(restored.content).not.toContain("lore setup backup");
  });

  test("repeated setup captures a complete provider edited by the user for undo", () => {
    const first = setup("", FIRST_URL);
    const edited = first.replace(
      'name = "Lore"',
      'name = "My edited provider"\n# User added this\nstream_max_retries = 9',
    );
    const expected = parse(edited).model_providers;
    const reset = setup(edited, NEXT_URL);
    const restored = restoreTomlBackup(reset);
    expect(restored.summary.skipped).toEqual([]);
    expect(parse(restored.content).model_providers).toEqual(expected);
    expect(restored.content).toContain("# User added this");
    expect(restored.content).not.toContain("lore setup backup");
  });

  test("round-trips provider strings containing the backup delimiter", () => {
    const original =
      '[model_providers.lore_http]\nname = "Existing"\n[model_providers.lore_http.http_headers]\nX-Note = "keep # lore-set this"\n';
    const configured = setup(setup(original, FIRST_URL), NEXT_URL);
    const restored = restoreTomlBackup(configured);
    expect(restored.summary.skipped).toEqual([]);
    expect(parse(restored.content)).toEqual(parse(original));
    expect(restored.content).not.toContain("lore setup backup");
  });

  test("supports an explicit model_providers parent table", () => {
    const original =
      '[model_providers]\nproxy = { name = "Private", base_url = "https://private.example/v1" }\n';
    const updated = updateCodexConfig(original, FIRST_URL);
    expect(updated).toContain(original.trimEnd());
    expect(parse(updated).model_providers).toMatchObject({
      proxy: { name: "Private" },
      lore_http: { supports_websockets: false },
    });
  });

  test("supports a quoted target provider table and restores its bytes", () => {
    const original =
      '["model_providers"."lore_http"]\n# Existing provider comment\nname = "Existing"\nbase_url = "https://existing.example/v1"\n';
    const updated = setup(original, FIRST_URL);
    expect(parse(updated).model_providers).toMatchObject({
      lore_http: { supports_websockets: false },
    });
    const restored = restoreTomlBackup(updated);
    expect(parse(restored.content)).toEqual(parse(original));
    expect(restored.content).toContain(original);
  });
});
