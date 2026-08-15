import { AsyncLocalStorage } from "node:async_hooks";

/** Empty ownership is the historical, single-user local storage namespace. */
export const LOCAL_TENANT_ID = "";

const tenantStorage = new AsyncLocalStorage<string>();

/** Opaque durable owner of storage touched by the current request/background job. */
export function currentTenantId(): string {
  return tenantStorage.getStore() ?? LOCAL_TENANT_ID;
}

/**
 * Run work under an opaque tenant owner. AsyncLocalStorage propagates the owner
 * through promises and fire-and-forget callbacks created by `fn`; delayed
 * registries must still capture the value and re-enter this scope when invoked.
 */
export function withTenant<T>(tenantId: string, fn: () => T): T {
  return tenantStorage.run(tenantId, fn);
}
