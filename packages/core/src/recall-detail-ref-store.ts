type TenantBoundExpiringEntry = {
  tenantId: string;
  expiresAt: number;
};

/** A bounded expiring store that never evicts one tenant for another. */
export class TenantBoundExpiringStore<T extends TenantBoundExpiringEntry> {
  private readonly entries = new Map<string, T>();

  constructor(
    private readonly maxEntries: number,
    private readonly maxEntriesPerTenant: number,
  ) {
    if (
      !Number.isSafeInteger(maxEntries) ||
      maxEntries < 1 ||
      !Number.isSafeInteger(maxEntriesPerTenant) ||
      maxEntriesPerTenant < 1
    ) {
      throw new RangeError(
        "Recall detail-ref store limits must be positive integers",
      );
    }
  }

  set(key: string, value: T, now = Date.now()): boolean {
    this.pruneExpired(now);
    this.entries.delete(key);

    const tenantKeys: string[] = [];
    for (const [entryKey, entry] of this.entries) {
      if (entry.tenantId === value.tenantId) tenantKeys.push(entryKey);
    }
    if (tenantKeys.length >= this.maxEntriesPerTenant) {
      const oldestTenantKey = tenantKeys[0];
      if (oldestTenantKey !== undefined) this.entries.delete(oldestTenantKey);
    }

    // Load-bearing: a full shared store rejects new refs instead of evicting
    // another tenant's still-live capability under cross-tenant churn.
    if (this.entries.size >= this.maxEntries) return false;
    this.entries.set(key, value);
    return true;
  }

  get(key: string, now = Date.now()): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    // Live reads refresh the per-tenant LRU order; only unread handles are
    // eligible for eviction when that tenant reaches its cap.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  private pruneExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}
