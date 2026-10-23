import { describe, expect, test } from "vitest";
import { TenantBoundExpiringStore } from "../src/recall-detail-ref-store";

describe("TenantBoundExpiringStore", () => {
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
