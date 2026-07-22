/**
 * Agent auth registry — maintains a list of all known harness credential
 * readers. Auth readers register themselves at import time. The import command
 * resolves an extraction credential from the harness the user is importing.
 */
import type { AgentAuthProvider, AgentResolvedAuth } from "../types";
import { isUnexpired } from "./util";

const authProviders: AgentAuthProvider[] = [];

/** Register an auth reader. Called at module load time by each reader module. */
export function registerAuthProvider(provider: AgentAuthProvider): void {
  authProviders.push(provider);
}

/** Get all registered auth readers. */
export function getAuthProviders(): readonly AgentAuthProvider[] {
  return authProviders;
}

/** Get an auth reader by internal name (matches the history provider name). */
export function getAuthProvider(name: string): AgentAuthProvider | undefined {
  return authProviders.find((p) => p.name === name);
}

/**
 * Clear all registered auth readers.
 * Test-only — allows resetting the registry between test runs.
 */
export function clearAuthProviders(): void {
  authProviders.length = 0;
}

/**
 * Read a harness's credentials and drop any that cannot currently be used:
 * expired OAuth tokens (v1 does not refresh). API keys (no expiry) always pass.
 * Routability (is the provider proxied by the gateway?) is filtered separately
 * by the gateway-side chain, which owns the PROVIDER_ROUTES table.
 *
 * @param name  Harness name (matches the history provider name).
 * @param now   Injectable clock for tests.
 * @returns Usable credentials, best-first. Empty when none/unusable.
 */
export function readUsableAuth(
  name: string,
  now = Date.now(),
): AgentResolvedAuth[] {
  const provider = getAuthProvider(name);
  if (!provider) return [];
  return provider.readAuth().filter((c) => isUnexpired(c.expiresAt, now));
}
