import { describe, it, expect } from "vitest";
import {
  getPath,
  setPath,
  deletePath,
  captureJsonBackup,
  attachJsonBackup,
  restoreJsonBackup,
  LORE_BACKUP_KEY,
  getTomlTopLevelValue,
  deleteTomlTopLevelKey,
  buildTomlBackupBlock,
  prependTomlBackupBlock,
  restoreTomlBackup,
  getEnvValue,
  setEnvValueRaw,
  deleteEnvKey,
  buildEnvBackupBlock,
  prependEnvBackupBlock,
  restoreEnvBackup,
} from "../src/cli/setup-backup";

// ---------------------------------------------------------------------------
// JSON dot-path helpers
// ---------------------------------------------------------------------------

describe("dot-path helpers", () => {
  it("getPath reads nested values and returns undefined for missing", () => {
    const o = { env: { A: "1" } };
    expect(getPath(o, "env.A")).toBe("1");
    expect(getPath(o, "env.B")).toBeUndefined();
    expect(getPath(o, "x.y.z")).toBeUndefined();
  });

  it("setPath creates intermediate objects", () => {
    const o: Record<string, unknown> = {};
    setPath(o, "a.b.c", 42);
    expect(o).toEqual({ a: { b: { c: 42 } } });
  });

  it("deletePath removes the leaf and prunes emptied ancestors", () => {
    const o: Record<string, unknown> = { env: { A: "1" } };
    deletePath(o, "env.A");
    expect(o).toEqual({}); // env pruned because it became empty
  });

  it("deletePath keeps ancestors that still have other keys", () => {
    const o: Record<string, unknown> = { env: { A: "1", B: "2" } };
    deletePath(o, "env.A");
    expect(o).toEqual({ env: { B: "2" } });
  });
});

// ---------------------------------------------------------------------------
// JSON backup capture / attach / restore
// ---------------------------------------------------------------------------

const CLAUDE_LORE_VALUES = {
  "env.ANTHROPIC_BASE_URL": "http://127.0.0.1:3207",
  "env.DISABLE_AUTO_COMPACT": "1",
};

describe("captureJsonBackup", () => {
  it("records prior values and absence per managed path", () => {
    const existing = {
      env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
    };
    const backup = captureJsonBackup(existing, CLAUDE_LORE_VALUES, {
      now: () => new Date("2026-06-21T00:00:00Z"),
    });
    expect(backup.savedAt).toBe("2026-06-21T00:00:00.000Z");
    const byPath = Object.fromEntries(backup.entries.map((e) => [e.path, e]));
    expect(byPath["env.ANTHROPIC_BASE_URL"]).toEqual({
      path: "env.ANTHROPIC_BASE_URL",
      loreValue: "http://127.0.0.1:3207",
      hadPrior: true,
      priorValue: "https://api.anthropic.com",
    });
    expect(byPath["env.DISABLE_AUTO_COMPACT"]).toEqual({
      path: "env.DISABLE_AUTO_COMPACT",
      loreValue: "1",
      hadPrior: false,
    });
  });
});

describe("attachJsonBackup", () => {
  it("attaches when absent", () => {
    const cfg: Record<string, unknown> = {};
    attachJsonBackup(cfg, captureJsonBackup({}, CLAUDE_LORE_VALUES));
    expect(cfg[LORE_BACKUP_KEY]).toBeDefined();
  });

  it("does NOT overwrite an existing backup (preserves the true original)", () => {
    const original = captureJsonBackup(
      { env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" } },
      CLAUDE_LORE_VALUES,
    );
    const cfg: Record<string, unknown> = {};
    attachJsonBackup(cfg, original);
    // Second setup run: prior now looks like lore's own value — must be ignored.
    const second = captureJsonBackup(
      { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:3207" } },
      CLAUDE_LORE_VALUES,
    );
    attachJsonBackup(cfg, second);
    expect(cfg[LORE_BACKUP_KEY]).toBe(original);
  });
});

describe("restoreJsonBackup", () => {
  it("restores prior values and deletes keys that were originally unset", () => {
    // Simulate the post-setup config.
    const cfg: Record<string, unknown> = {
      env: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:3207",
        DISABLE_AUTO_COMPACT: "1",
      },
    };
    attachJsonBackup(
      cfg,
      captureJsonBackup(
        { env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" } },
        CLAUDE_LORE_VALUES,
      ),
    );
    const summary = restoreJsonBackup(cfg);
    expect(summary.hadBackup).toBe(true);
    expect(summary.restored.sort()).toEqual([
      "env.ANTHROPIC_BASE_URL",
      "env.DISABLE_AUTO_COMPACT",
    ]);
    expect(cfg).toEqual({
      env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
    });
  });

  it("does NOT revert a value the user changed after setup (revert-only-if-unchanged)", () => {
    const cfg: Record<string, unknown> = {
      env: {
        ANTHROPIC_BASE_URL: "http://user-changed:9999", // user edited this
        DISABLE_AUTO_COMPACT: "1",
      },
    };
    attachJsonBackup(
      cfg,
      captureJsonBackup(
        { env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" } },
        CLAUDE_LORE_VALUES,
      ),
    );
    const summary = restoreJsonBackup(cfg);
    expect(summary.skipped).toContain("env.ANTHROPIC_BASE_URL");
    expect(summary.restored).toContain("env.DISABLE_AUTO_COMPACT");
    // The user's value is preserved.
    expect(getPath(cfg, "env.ANTHROPIC_BASE_URL")).toBe(
      "http://user-changed:9999",
    );
    // A key was skipped → the sidecar is KEPT so its prior value stays
    // recoverable (Seer #876 — no metadata loss).
    expect(LORE_BACKUP_KEY in cfg).toBe(true);
  });

  it("reports no backup when the sidecar is missing", () => {
    expect(restoreJsonBackup({ env: {} }).hadBackup).toBe(false);
  });

  it("removes a plugin lore appended (OpenCode)", () => {
    const cfg: Record<string, unknown> = {
      plugin: ["@other/plugin", "@loreai/opencode"],
    };
    attachJsonBackup(cfg, captureJsonBackup({}, {}, { pluginAdded: true }));
    const summary = restoreJsonBackup(cfg);
    expect(summary.restored).toContain("plugin[@loreai/opencode]");
    expect(cfg.plugin).toEqual(["@other/plugin"]);
  });

  it("leaves a plugin the user already had (pluginAdded=false)", () => {
    const cfg: Record<string, unknown> = {
      plugin: ["@loreai/opencode"],
    };
    attachJsonBackup(cfg, captureJsonBackup({}, {}, { pluginAdded: false }));
    restoreJsonBackup(cfg);
    expect(cfg.plugin).toEqual(["@loreai/opencode"]);
  });

  it("survives a full round-trip and leaves no _loreBackup key", () => {
    const cfg: Record<string, unknown> = {
      env: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:3207",
        DISABLE_AUTO_COMPACT: "1",
      },
    };
    attachJsonBackup(cfg, captureJsonBackup({}, CLAUDE_LORE_VALUES));
    restoreJsonBackup(cfg);
    expect(LORE_BACKUP_KEY in cfg).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TOML backup (Codex)
// ---------------------------------------------------------------------------

describe("getTomlTopLevelValue", () => {
  it("reads a top-level value", () => {
    expect(
      getTomlTopLevelValue('openai_base_url = "x"\n', "openai_base_url"),
    ).toBe('"x"');
  });

  it("returns null for an absent key", () => {
    expect(
      getTomlTopLevelValue('model = "gpt"\n', "openai_base_url"),
    ).toBeNull();
  });

  it("ignores a key nested inside a section", () => {
    const c = '[tui]\nopenai_base_url = "nested"\n';
    expect(getTomlTopLevelValue(c, "openai_base_url")).toBeNull();
  });
});

describe("TOML backup block round-trip", () => {
  // key → raw TOML value lore writes
  const LORE_VALUES = {
    openai_base_url: '"http://127.0.0.1:3299/v1"',
    model_auto_compact_token_limit: "999999999",
  };

  it("captures prior values, unset markers, and the lore-set value", () => {
    const original = 'openai_base_url = "https://api.openai.com/v1"\n';
    const block = buildTomlBackupBlock(original, LORE_VALUES);
    expect(block).not.toBeNull();
    expect(block).toContain(
      '#   openai_base_url = "https://api.openai.com/v1" # lore-set "http://127.0.0.1:3299/v1"',
    );
    expect(block).toContain(
      "#   model_auto_compact_token_limit (was unset) # lore-set 999999999",
    );
  });

  it("does not build a second block when one already exists", () => {
    const original = 'openai_base_url = "https://api.openai.com/v1"\n';
    const block = buildTomlBackupBlock(original, LORE_VALUES) as string;
    const withBlock = prependTomlBackupBlock(original, block);
    expect(buildTomlBackupBlock(withBlock, LORE_VALUES)).toBeNull();
  });

  it("restores prior value and deletes originally-unset keys", () => {
    const original = 'openai_base_url = "https://api.openai.com/v1"\n';
    // Real setup order: capture the block from the ORIGINAL, apply lore's
    // writes to the original, then prepend the block to the updated content.
    const block = buildTomlBackupBlock(original, LORE_VALUES) as string;
    const updated =
      'openai_base_url = "http://127.0.0.1:3299/v1"\nmodel_auto_compact_token_limit = 999999999\n';
    const content = prependTomlBackupBlock(updated, block);

    const { content: restored, summary } = restoreTomlBackup(content);
    expect(summary.hadBackup).toBe(true);
    expect(summary.restored.sort()).toEqual([
      "model_auto_compact_token_limit",
      "openai_base_url",
    ]);
    expect(restored).toContain('openai_base_url = "https://api.openai.com/v1"');
    expect(restored).not.toContain("http://127.0.0.1:3299/v1");
    // Originally-unset key is removed entirely.
    expect(restored).not.toContain("model_auto_compact_token_limit");
    // Backup block removed.
    expect(restored).not.toContain("lore setup backup");
  });

  it("skips a value the user changed after setup (revert-only-if-unchanged)", () => {
    const original = 'openai_base_url = "https://api.openai.com/v1"\n';
    const block = buildTomlBackupBlock(original, LORE_VALUES) as string;
    // The user later changed openai_base_url away from lore's value; the limit
    // still holds lore's value.
    const updated =
      'openai_base_url = "http://user-changed:9999/v1"\nmodel_auto_compact_token_limit = 999999999\n';
    const content = prependTomlBackupBlock(updated, block);

    const { content: restored, summary } = restoreTomlBackup(content);
    expect(summary.skipped).toContain("openai_base_url");
    expect(summary.restored).toContain("model_auto_compact_token_limit");
    // The user's value is preserved.
    expect(restored).toContain(
      'openai_base_url = "http://user-changed:9999/v1"',
    );
    // Because a key was skipped, the backup block is KEPT so the skipped key's
    // original value stays recoverable (Seer #876 — no metadata loss).
    expect(restored).toContain("lore setup backup");
    expect(restored).toContain(
      '#   openai_base_url = "https://api.openai.com/v1"',
    );
  });

  it("reports no backup when the block is absent", () => {
    expect(restoreTomlBackup('model = "gpt"\n').summary.hadBackup).toBe(false);
  });

  it("leaves the file untouched when the footer is missing (no data loss)", () => {
    // A hand-edited/corrupted block with a header but no footer must NOT cause
    // the rest of the file to be truncated (Seer #876 HIGH).
    const block = buildTomlBackupBlock(
      'openai_base_url = "https://api.openai.com/v1"\n',
      LORE_VALUES,
    ) as string;
    const headerOnly = block.split("\n").slice(0, -1).join("\n"); // drop footer
    const content = `${headerOnly}\nmodel = "gpt-5"\nopenai_base_url = "http://127.0.0.1:3299/v1"\n`;
    const { content: result, summary } = restoreTomlBackup(content);
    expect(summary.hadBackup).toBe(false);
    expect(result).toBe(content); // byte-identical — nothing deleted
  });
});

describe("deleteTomlTopLevelKey", () => {
  it("removes only the top-level occurrence", () => {
    const c = 'openai_base_url = "x"\n[tui]\nopenai_base_url = "nested"\n';
    const out = deleteTomlTopLevelKey(c, "openai_base_url");
    expect(out).not.toContain('openai_base_url = "x"');
    expect(out).toContain('openai_base_url = "nested"');
  });
});

// ---------------------------------------------------------------------------
// dotenv primitives (Hermes)
// ---------------------------------------------------------------------------

describe("getEnvValue", () => {
  it("reads a bare value and ignores commented lines", () => {
    const c =
      "# OPENAI_BASE_URL=commented\nOPENAI_BASE_URL=http://x/v1\nFOO=bar\n";
    expect(getEnvValue(c, "OPENAI_BASE_URL")).toBe("http://x/v1");
    expect(getEnvValue(c, "FOO")).toBe("bar");
  });

  it("handles an `export` prefix and surrounding whitespace", () => {
    expect(
      getEnvValue("export OPENAI_BASE_URL = http://x/v1 \n", "OPENAI_BASE_URL"),
    ).toBe("http://x/v1");
  });

  it("returns null when the key is absent or only commented", () => {
    expect(getEnvValue("FOO=bar\n", "OPENAI_BASE_URL")).toBeNull();
    expect(getEnvValue("# OPENAI_BASE_URL=x\n", "OPENAI_BASE_URL")).toBeNull();
  });
});

describe("setEnvValueRaw", () => {
  it("replaces the first live occurrence in place", () => {
    const c = "FOO=1\nOPENAI_BASE_URL=old\nBAR=2\n";
    expect(setEnvValueRaw(c, "OPENAI_BASE_URL", "new")).toBe(
      "FOO=1\nOPENAI_BASE_URL=new\nBAR=2\n",
    );
  });

  it("appends when absent, with exactly one trailing newline", () => {
    expect(setEnvValueRaw("FOO=1\n", "OPENAI_BASE_URL", "new")).toBe(
      "FOO=1\nOPENAI_BASE_URL=new\n",
    );
    expect(setEnvValueRaw("", "OPENAI_BASE_URL", "new")).toBe(
      "OPENAI_BASE_URL=new\n",
    );
  });

  it("does not touch a commented-out key (appends instead)", () => {
    expect(
      setEnvValueRaw("# OPENAI_BASE_URL=old\n", "OPENAI_BASE_URL", "new"),
    ).toBe("# OPENAI_BASE_URL=old\nOPENAI_BASE_URL=new\n");
  });
});

describe("deleteEnvKey", () => {
  it("removes live assignments but keeps comments", () => {
    const c = "# OPENAI_BASE_URL=keepme\nOPENAI_BASE_URL=live\nFOO=1\n";
    expect(deleteEnvKey(c, "OPENAI_BASE_URL")).toBe(
      "# OPENAI_BASE_URL=keepme\nFOO=1\n",
    );
  });
});

describe("dotenv backup block round-trip", () => {
  const lore = {
    OPENAI_BASE_URL: "http://127.0.0.1:3207/v1",
    HERMES_INFERENCE_PROVIDER: "custom",
  };

  it("records prior values (or '(was unset)') and restores them", () => {
    const original =
      "OPENAI_BASE_URL=https://inference-api.nousresearch.com/v1\nMY_TOKEN=secret\n";
    const block = buildEnvBackupBlock(original, lore);
    expect(block).not.toBeNull();
    // Prior OPENAI_BASE_URL captured; HERMES_INFERENCE_PROVIDER was unset.
    expect(block).toContain(
      "OPENAI_BASE_URL=https://inference-api.nousresearch.com/v1 # lore-set http://127.0.0.1:3207/v1",
    );
    expect(block).toContain("HERMES_INFERENCE_PROVIDER (was unset)");

    // Apply lore's values under the block (what updateHermesEnv does).
    let content = original;
    for (const [k, v] of Object.entries(lore))
      content = setEnvValueRaw(content, k, v);
    content = prependEnvBackupBlock(content, block as string);
    expect(getEnvValue(content, "OPENAI_BASE_URL")).toBe(
      "http://127.0.0.1:3207/v1",
    );

    // Undo: prior URL restored, the unset provider key removed, unrelated var kept.
    const { content: restored, summary } = restoreEnvBackup(content);
    expect(summary.hadBackup).toBe(true);
    expect(summary.restored.sort()).toEqual([
      "HERMES_INFERENCE_PROVIDER",
      "OPENAI_BASE_URL",
    ]);
    expect(getEnvValue(restored, "OPENAI_BASE_URL")).toBe(
      "https://inference-api.nousresearch.com/v1",
    );
    expect(getEnvValue(restored, "HERMES_INFERENCE_PROVIDER")).toBeNull();
    expect(restored).toContain("MY_TOKEN=secret");
    expect(restored).not.toContain("lore setup backup");
  });

  it("skips a value the user changed after setup and keeps the block", () => {
    const block = buildEnvBackupBlock("", lore) as string;
    let content = "";
    for (const [k, v] of Object.entries(lore))
      content = setEnvValueRaw(content, k, v);
    content = prependEnvBackupBlock(content, block);
    // User edits OPENAI_BASE_URL after setup.
    content = setEnvValueRaw(
      content,
      "OPENAI_BASE_URL",
      "http://user-changed/v1",
    );

    const { content: restored, summary } = restoreEnvBackup(content);
    expect(summary.skipped).toContain("OPENAI_BASE_URL");
    expect(summary.restored).toContain("HERMES_INFERENCE_PROVIDER");
    // User's change is preserved; block retained (not everything reverted).
    expect(getEnvValue(restored, "OPENAI_BASE_URL")).toBe(
      "http://user-changed/v1",
    );
    expect(restored).toContain("lore setup backup");
  });

  it("returns null when a block already exists (preserve the true original)", () => {
    const withBlock = prependEnvBackupBlock(
      "OPENAI_BASE_URL=http://x/v1\n",
      buildEnvBackupBlock("", lore) as string,
    );
    expect(buildEnvBackupBlock(withBlock, lore)).toBeNull();
  });

  it("refuses to restore a corrupted block (missing footer)", () => {
    const content =
      "# lore setup backup — original values (run `lore setup undo hermes` to restore):\n#   FOO (was unset) # lore-set x\nOPENAI_BASE_URL=x\n";
    const { content: result, summary } = restoreEnvBackup(content);
    expect(summary.hadBackup).toBe(false);
    expect(result).toBe(content); // byte-identical — nothing touched
  });
});
