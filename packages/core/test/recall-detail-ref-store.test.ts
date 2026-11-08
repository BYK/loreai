import { describe, expect, test } from "vitest";
import { TenantBoundExpiringStore } from "../src/recall-detail-ref-store";

describe("TenantBoundExpiringStore", () => {
  test("larger local quota preserves hosted quotas and the shared hard bound", () => {
    const limits = new Map([["", 3]]);
    const store = new TenantBoundExpiringStore<{
      tenantId: string;
      expiresAt: number;
    }>(4, 1, limits);
    // Caller mutation cannot silently change an established resource limit.
    limits.set("", 1);
    store.set("hosted-1", { tenantId: "hosted", expiresAt: 100 }, 0);
    for (let index = 1; index <= 3; index++) {
      expect(
        store.set(`local-${index}`, { tenantId: "", expiresAt: 100 }, 0),
      ).toBe(true);
    }
    expect(
      store.set("new-tenant", { tenantId: "new", expiresAt: 100 }, 0),
    ).toBe(false);
    expect(store.set("local-4", { tenantId: "", expiresAt: 100 }, 0)).toBe(
      true,
    );
    expect(store.get("local-1", 0)).toBeUndefined();
    expect(store.get("hosted-1", 0)).toBeDefined();
    expect(
      store.set("hosted-2", { tenantId: "hosted", expiresAt: 100 }, 0),
    ).toBe(true);
    expect(store.get("hosted-1", 0)).toBeUndefined();
    expect(store.get("hosted-2", 0)).toBeDefined();
    for (let index = 2; index <= 4; index++) {
      expect(store.get(`local-${index}`, 0)).toBeDefined();
    }
    expect(
      store.set("new-tenant", { tenantId: "new", expiresAt: 100 }, 0),
    ).toBe(false);
  });

  test("bounds each tenant without letting churn evict another tenant", () => {
    const store = new TenantBoundExpiringStore<{
      tenantId: string;
      expiresAt: number;
    }>(4, 2);
    expect(store.set("a-1", { tenantId: "a", expiresAt: 100 }, 0)).toBe(true);
    expect(store.set("b-1", { tenantId: "b", expiresAt: 100 }, 0)).toBe(true);
    expect(store.set("a-2", { tenantId: "a", expiresAt: 100 }, 0)).toBe(true);
    expect(store.set("a-3", { tenantId: "a", expiresAt: 100 }, 0)).toBe(true);

    expect(store.get("a-1", 0)).toBeUndefined();
    expect(store.get("b-1", 0)).toEqual({ tenantId: "b", expiresAt: 100 });
    expect(store.get("a-2", 0)).toBeDefined();
    expect(store.get("a-3", 0)).toBeDefined();
  });

  test("a read refreshes recency before the tenant limit evicts a handle", () => {
    const store = new TenantBoundExpiringStore<{
      tenantId: string;
      expiresAt: number;
    }>(2, 2);
    store.set("a-1", { tenantId: "a", expiresAt: 100 }, 0);
    store.set("a-2", { tenantId: "a", expiresAt: 100 }, 0);

    expect(store.get("a-1", 1)).toEqual({ tenantId: "a", expiresAt: 100 });
    store.set("a-3", { tenantId: "a", expiresAt: 100 }, 2);

    expect(store.get("a-1", 2)).toBeDefined();
    expect(store.get("a-2", 2)).toBeUndefined();
    expect(store.get("a-3", 2)).toBeDefined();
  });

  test("rejects new tenants at global capacity and expires stale entries", () => {
    const store = new TenantBoundExpiringStore<{
      tenantId: string;
      expiresAt: number;
    }>(2, 2);
    expect(store.set("a-1", { tenantId: "a", expiresAt: 5 }, 0)).toBe(true);
    expect(store.set("b-1", { tenantId: "b", expiresAt: 10 }, 0)).toBe(true);
    expect(store.set("c-1", { tenantId: "c", expiresAt: 20 }, 0)).toBe(false);
    expect(store.get("a-1", 5)).toBeUndefined();
    expect(store.set("c-1", { tenantId: "c", expiresAt: 20 }, 5)).toBe(true);
    expect(store.get("b-1", 5)).toBeDefined();
    expect(store.get("c-1", 5)).toBeDefined();
  });
});
