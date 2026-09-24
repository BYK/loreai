/**
 * Contract tests: every recorded fixture in `test/fixtures/**` must parse
 * against the matching contract and deep-equal the input (ArkType objects
 * preserve unknown keys), plus a per-contract violation battery.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Type } from "arktype";

import {
  accountStatus,
  apiErrorBody,
  ContractError,
  cursorPage,
  distillationDetail,
  distillationList,
  entityDetail,
  entityListPage,
  entityRebuildStatus,
  isApiError,
  isContractError,
  knowledgeEntry,
  knowledgeList,
  knowledgeVersionHistory,
  parseContract,
  projectList,
  recallResponse,
  safeParseContract,
  sessionDetail,
  sessionList,
  sessionPage,
  sessionSearchPage,
  sharingStatus,
  syncStatus,
  teamList,
} from "~/contracts";

// Vitest rewrites import.meta.url to a non-file URL; resolve from cwd.
const FIXTURES = join(process.cwd(), "test", "fixtures");

/** Vitest file snapshots are pretty-printed with trailing commas. */
function readFixture(name: string): unknown {
  const raw = readFileSync(`${FIXTURES}/${name}`, "utf8");
  return JSON.parse(raw.replace(/,(\s*[}\]])/g, "$1"));
}

const ROUTES: Record<string, { route: string; schema: Type }> = {
  "projects.json": { route: "/projects", schema: projectList },
  "knowledge-list.json": {
    route: "/projects/p/knowledge",
    schema: knowledgeList,
  },
  "knowledge-entry.json": { route: "/knowledge/k", schema: knowledgeEntry },
  "recall.json": { route: "/recall", schema: recallResponse },
  "sessions-list.json": { route: "/projects/p/sessions", schema: sessionList },
  "session-detail.json": { route: "/sessions/s", schema: sessionDetail },
  "session-page.json": {
    route: "/sessions/s?page=cursor",
    schema: sessionPage,
  },
  "session-search.json": {
    route: "/sessions/s/search?q=",
    schema: sessionSearchPage,
  },
  "distillations-list.json": {
    route: "/projects/p/distillations",
    schema: distillationList,
  },
  "distillation-detail.json": {
    route: "/distillations/d",
    schema: distillationDetail,
  },
  "folk-account.json": { route: "/account", schema: accountStatus },
  "folk-teams.json": { route: "/teams", schema: teamList },
  "folk-sync-status.json": { route: "/sync/status", schema: syncStatus },
  "folk-sharing.json": {
    route: "/projects/p/sharing",
    schema: sharingStatus,
  },
  "entities-list.json": { route: "/entities", schema: entityListPage },
  "entity-detail.json": { route: "/entities/e", schema: entityDetail },
  "entity-rebuild-status.json": {
    route: "/entities/rebuild",
    schema: entityRebuildStatus,
  },
  "api-error.json": { route: "/knowledge/x", schema: apiErrorBody },
  "cursor/knowledge-page.json": {
    route: "/projects/p/knowledge",
    schema: cursorPage(knowledgeEntry),
  },
  "cursor/knowledge-page-last.json": {
    route: "/projects/p/knowledge",
    schema: cursorPage(knowledgeEntry),
  },
  "cursor/knowledge-versions.json": {
    route: "/knowledge/k/versions",
    schema: knowledgeVersionHistory,
  },
};

describe("fixtures parse against their contract and round-trip", () => {
  const names = Object.keys(ROUTES);
  // Every fixture on disk is covered by a route entry.
  it("covers every fixture file", () => {
    const onDisk: string[] = [];
    for (const f of readdirSync(FIXTURES)) {
      if (f.endsWith(".json")) onDisk.push(f);
    }
    for (const f of readdirSync(`${FIXTURES}/cursor`)) {
      onDisk.push(`cursor/${f}`);
    }
    expect([...onDisk].sort()).toEqual([...names].sort());
  });

  it.each(names)("%s parses and deep-equals the input", (name) => {
    const { route, schema } = ROUTES[name]!;
    const input = readFixture(name);
    const parsed = safeParseContract(route, schema, input);
    if (!parsed.ok) console.error(name, parsed.error.issues);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual(input);
  });
});

describe("contract violations", () => {
  const OBJECT_CONTRACTS: Array<{
    name: string;
    fixture: string;
    route: string;
    schema: Type;
    /** path to the object to mutate ("" = root; arrays take element 0) */
    pick: (input: unknown) => Record<string, unknown>;
  }> = [
    {
      name: "projectSummary",
      fixture: "projects.json",
      route: "/projects",
      schema: projectList,
      pick: (i) => (i as Record<string, unknown>[])[0]!,
    },
    {
      name: "knowledgeEntry",
      fixture: "knowledge-entry.json",
      route: "/knowledge/k",
      schema: knowledgeEntry,
      pick: (i) => i as Record<string, unknown>,
    },
    {
      name: "sessionSummary",
      fixture: "sessions-list.json",
      route: "/projects/p/sessions",
      schema: sessionList,
      pick: (i) => (i as Record<string, unknown>[])[0]!,
    },
    {
      name: "distillationSummary",
      fixture: "distillations-list.json",
      route: "/projects/p/distillations",
      schema: distillationList,
      pick: (i) => (i as Record<string, unknown>[])[0]!,
    },
    {
      name: "sharingStatus",
      fixture: "folk-sharing.json",
      route: "/projects/p/sharing",
      schema: sharingStatus,
      pick: (i) => i as Record<string, unknown>,
    },
  ];

  for (const c of OBJECT_CONTRACTS) {
    describe(c.name, () => {
      const input = readFixture(c.fixture);
      const required = Object.keys(c.pick(input)).filter((key) => {
        const probe = structuredClone(input);
        // A field is "required" if deleting it makes the contract fail.
        delete c.pick(probe)[key];
        return !safeParseContract("/x", c.schema, probe).ok;
      });

      it.each(required)("missing required field %s is a ContractError", (f) => {
        const broken = structuredClone(input);
        delete c.pick(broken)[f];
        try {
          parseContract(c.route, c.schema, broken);
          expect.unreachable(`expected ${f} to be required`);
        } catch (error) {
          expect(isContractError(error)).toBe(true);
          expect(isApiError(error)).toBe(true);
          if (error instanceof ContractError) {
            expect(error.kind).toBe("invalid");
            expect(error.route).toBe(c.route);
            expect(error.issues.length).toBeGreaterThan(0);
            expect(error.issues.some((i) => i.path.endsWith(f))).toBe(true);
          }
        }
      });

      it("preserves unknown keys at root and inside array items", () => {
        const extra = structuredClone(input);
        const isList = Array.isArray(extra);
        if (!isList) {
          (extra as Record<string, unknown>).__future = { nested: true };
        } else if (extra.length > 0) {
          (extra[0] as Record<string, unknown>).__future = { nested: true };
        }
        const parsed = safeParseContract("/x", c.schema, extra);
        expect(parsed.ok).toBe(true);
        if (parsed.ok) {
          if (Array.isArray(parsed.value)) {
            expect(
              (parsed.value[0] as Record<string, unknown>).__future,
            ).toEqual({ nested: true });
          } else {
            expect((parsed.value as Record<string, unknown>).__future).toEqual({
              nested: true,
            });
          }
        }
      });
    });
  }

  it("mistyped fields are errors, never coerced", () => {
    const cases: Array<readonly [Type, unknown, Record<string, unknown>]> = [
      [projectList, readFixture("projects.json"), { created_at: "yesterday" }],
      [
        knowledgeEntry,
        readFixture("knowledge-entry.json"),
        { confidence: 1.5 },
      ],
      [
        cursorPage(knowledgeEntry),
        readFixture("cursor/knowledge-page.json"),
        { next_cursor: 1 },
      ],
    ];
    for (const [schema, input, patch] of cases) {
      const broken = structuredClone(input);
      const target = Array.isArray(broken) ? broken[0] : broken;
      Object.assign(target as Record<string, unknown>, patch);
      const parsed = safeParseContract("/route", schema, broken);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(isContractError(parsed.error)).toBe(true);
        expect(parsed.error.issues.length).toBeGreaterThan(0);
      }
    }
  });

  it("apiErrorBody accepts the gateway error envelope", () => {
    const parsed = safeParseContract("/x", apiErrorBody, {
      type: "error",
      error: { type: "not_found", message: "Knowledge entry not found: x" },
    });
    expect(parsed.ok).toBe(true);
  });

  it("recallResponse preserves the recall response shape", () => {
    const parsed = safeParseContract("/recall", recallResponse, {
      query: "SQLite",
      scope: "all",
      projectPath: "/tmp/project",
      result: "## Recall Results",
    });
    expect(parsed.ok).toBe(true);
  });

  it("contracts run jitless (CSP-compatible)", () => {
    // `resolvedConfig` exists at runtime but is missing from arktype's
    // public .d.ts — narrow structurally rather than to `any`.
    const scope = knowledgeEntry.$ as {
      resolvedConfig?: { jitless?: boolean };
    };
    expect(scope.resolvedConfig?.jitless).toBe(true);
  });
});
