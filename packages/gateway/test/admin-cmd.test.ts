/**
 * Unit coverage for the operator-only `lore admin grant` CLI (service-role tier flips).
 * The service-role client (../supabase) is mocked; we assert the target-type routing
 * (email → profiles, UUID → orgs), tier validation, the missing-key guard, and the
 * not-found / ambiguous-email paths.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockClient: unknown = null;
vi.mock("../src/supabase", () => ({
  getServiceRoleClient: () => mockClient,
}));

import { commandAdmin } from "../src/cli/admin-cmd";

let logs: string[];
let errs: string[];
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logs = [];
  errs = [];
  process.exitCode = 0;
  logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  errSpy = vi
    .spyOn(console, "error")
    .mockImplementation((...a: unknown[]) => void errs.push(a.join(" ")));
});
afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  mockClient = null;
  process.exitCode = 0;
});

/**
 * A tiny chainable Supabase mock. `profilesRows` feeds the email→profiles lookup;
 * `orgUpdateRows` feeds the org update .select(); update calls are recorded.
 */
function makeClient(
  opts: {
    profilesRows?: { id: string; email: string }[];
    orgUpdateRows?: { id: string; kind: string; tier: string }[];
    profileUpdateRows?: { id: string }[];
    updateErr?: string;
  } = {},
) {
  const updates: { table: string; patch: Record<string, unknown> }[] = [];
  const client = {
    updates,
    from(table: string) {
      return {
        // profiles email lookup: .select().eq()  → awaited
        select(_cols: string) {
          return {
            eq: (_c: string, _v: string) =>
              Promise.resolve({ data: opts.profilesRows ?? [], error: null }),
          };
        },
        // update path: .update().eq().select()  (orgs) or .update().eq() (profiles)
        update(patch: Record<string, unknown>) {
          updates.push({ table, patch });
          return {
            eq: (_c: string, _v: string) => {
              const err = opts.updateErr ? { message: opts.updateErr } : null;
              // A real Promise with a `.select()` attached — both the orgs and profiles update paths
              // await `.eq().select()`. Object.assign on a genuine Promise avoids a hand-rolled
              // thenable (no-thenable lint). orgs → orgUpdateRows; profiles → profileUpdateRows
              // (defaults to one row so a successful tier flip is confirmed).
              const rows =
                table === "orgs"
                  ? (opts.orgUpdateRows ?? [])
                  : (opts.profileUpdateRows ?? [{ id: "u-1" }]);
              const p = Promise.resolve({ data: null, error: err });
              return Object.assign(p, {
                select: (_s: string) =>
                  Promise.resolve({ data: err ? null : rows, error: err }),
              });
            },
          };
        },
      };
    },
  };
  return client;
}

describe("lore admin grant", () => {
  it("prints usage for a non-grant subcommand", async () => {
    await commandAdmin(["bogus"], {});
    expect(errs.join("\n")).toMatch(/Usage: lore admin/);
    expect(process.exitCode).toBe(1);
  });

  it("requires target + tier", async () => {
    await commandAdmin(["grant", "a@b.dev"], {});
    expect(errs.join("\n")).toMatch(/Usage: lore admin/);
    expect(process.exitCode).toBe(1);
  });

  it("rejects an unknown tier", async () => {
    mockClient = makeClient();
    await commandAdmin(["grant", "a@b.dev", "platinum"], {});
    expect(errs.join("\n")).toMatch(/free\|pro/);
    expect(process.exitCode).toBe(1);
  });

  it("rejects a team tier for a personal (email) target", async () => {
    mockClient = makeClient();
    await commandAdmin(["grant", "dev@acme.dev", "team"], {});
    expect(errs.join("\n")).toMatch(/Personal accounts accept free\|pro/);
    expect(process.exitCode).toBe(1);
  });

  it("rejects a pro tier for a team (UUID) target", async () => {
    mockClient = makeClient();
    await commandAdmin(
      ["grant", "0192f0aa-1111-7000-8000-000000000000", "pro"],
      {},
    );
    expect(errs.join("\n")).toMatch(/Team orgs accept free\|team/);
    expect(process.exitCode).toBe(1);
  });

  it("refuses without a service-role key (operator-only)", async () => {
    mockClient = null; // getServiceRoleClient returns null when the env var is unset
    await commandAdmin(["grant", "a@b.dev", "pro"], {});
    expect(errs.join("\n")).toMatch(/operator-only|SUPABASE_SERVICE_ROLE_KEY/);
    expect(process.exitCode).toBe(1);
  });

  it("promotes a personal account by email (profiles.tier)", async () => {
    mockClient = makeClient({
      profilesRows: [{ id: "u-1", email: "dev@acme.dev" }],
    });
    await commandAdmin(["grant", "dev@acme.dev", "pro"], {});
    const c = mockClient as ReturnType<typeof makeClient>;
    expect(c.updates).toEqual([{ table: "profiles", patch: { tier: "pro" } }]);
    expect(logs.join("\n")).toMatch(/dev@acme.dev \(personal\) tier → pro/);
    expect(process.exitCode).toBe(0);
  });

  it("errors when no account matches the email", async () => {
    mockClient = makeClient({ profilesRows: [] });
    await commandAdmin(["grant", "ghost@acme.dev", "pro"], {});
    expect(errs.join("\n")).toMatch(/No account found/);
    expect(process.exitCode).toBe(1);
  });

  it("refuses an ambiguous email (multiple matches)", async () => {
    mockClient = makeClient({
      profilesRows: [
        { id: "u-1", email: "dev@acme.dev" },
        { id: "u-2", email: "dev@acme.dev" },
      ],
    });
    await commandAdmin(["grant", "dev@acme.dev", "pro"], {});
    expect(errs.join("\n")).toMatch(/Multiple accounts match/);
    expect(process.exitCode).toBe(1);
  });

  it("promotes a team org by UUID (orgs.tier)", async () => {
    mockClient = makeClient({
      orgUpdateRows: [
        {
          id: "0192f0aa-1111-7000-8000-000000000000",
          kind: "team",
          tier: "team",
        },
      ],
    });
    await commandAdmin(
      ["grant", "0192f0aa-1111-7000-8000-000000000000", "team"],
      {},
    );
    const c = mockClient as ReturnType<typeof makeClient>;
    expect(c.updates).toEqual([{ table: "orgs", patch: { tier: "team" } }]);
    expect(logs.join("\n")).toMatch(/Set org .* \(team\) tier → team/);
    expect(process.exitCode).toBe(0);
  });

  it("errors when no org matches the UUID", async () => {
    mockClient = makeClient({ orgUpdateRows: [] });
    await commandAdmin(
      ["grant", "0192f0aa-2222-7000-8000-000000000000", "team"],
      {},
    );
    expect(errs.join("\n")).toMatch(/No org found/);
    expect(process.exitCode).toBe(1);
  });

  it("routes an email containing an embedded UUID to the personal (profiles) path", async () => {
    // Anchoring regression: UUID_RE must be ^...$ so an email that merely CONTAINS a uuid
    // substring is NOT misrouted to the orgs path.
    mockClient = makeClient({
      profilesRows: [
        {
          id: "u-9",
          email: "user+0192f0aa-1111-7000-8000-000000000000@acme.dev",
        },
      ],
    });
    await commandAdmin(
      ["grant", "user+0192f0aa-1111-7000-8000-000000000000@acme.dev", "pro"],
      {},
    );
    const c = mockClient as ReturnType<typeof makeClient>;
    expect(c.updates).toEqual([{ table: "profiles", patch: { tier: "pro" } }]);
    expect(process.exitCode).toBe(0);
  });

  it("surfaces a service-role update error", async () => {
    mockClient = makeClient({
      profilesRows: [{ id: "u-1", email: "dev@acme.dev" }],
      updateErr: "permission denied",
    });
    await commandAdmin(["grant", "dev@acme.dev", "pro"], {});
    expect(errs.join("\n")).toMatch(/lore admin: permission denied/);
    expect(process.exitCode).toBe(1);
  });

  it("errors (not misleading success) when the profile update hits no row", async () => {
    // Lookup finds the account, but the update returns no row (deleted in between) → must NOT
    // print success. Guards the silent-no-op case (Seer LOW).
    mockClient = makeClient({
      profilesRows: [{ id: "u-1", email: "dev@acme.dev" }],
      profileUpdateRows: [], // update matched nothing
    });
    await commandAdmin(["grant", "dev@acme.dev", "pro"], {});
    expect(logs.join("\n")).not.toMatch(/tier →/);
    expect(errs.join("\n")).toMatch(/No account found/);
    expect(process.exitCode).toBe(1);
  });
});
