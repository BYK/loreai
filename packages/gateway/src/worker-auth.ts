import { resolveAuth } from "./auth";
import {
  workerProviderAliasIDs,
  workerProviderSupportsProtocol,
  type WorkerProtocol,
} from "./llm-adapter";

/**
 * Mirror the worker adapter's provider-alias credential lookup for scheduling
 * guards. A guard must not reject `bedrock` merely because the owning session
 * stored the same credential under `amazon-bedrock`, but unrelated providers
 * remain fail-closed.
 */
export function hasWorkerSessionAuth(
  sessionID: string,
  providerID: string,
  protocol?: WorkerProtocol,
): boolean {
  for (const aliasID of workerProviderAliasIDs(providerID)) {
    if (protocol && !workerProviderSupportsProtocol(aliasID, protocol))
      continue;
    if (resolveAuth(sessionID, aliasID)) return true;
  }
  return false;
}
