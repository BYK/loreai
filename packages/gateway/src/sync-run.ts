import { keystore, syncData } from "@loreai/core";
import type { GatewayConfig } from "./config";
import {
  accessFor,
  errorResponse,
  hostedRefusal,
  json,
  readObjectBody,
  requestIsHosted,
} from "./folk-access";
import { syncOnce } from "./sync";

export async function handleSyncRunRequest(
  req: Request,
  pathname: string,
  config: GatewayConfig,
): Promise<Response | null> {
  if (pathname !== "/api/v1/sync/run" || req.method !== "POST") return null;
  if (requestIsHosted(config)) {
    return hostedRefusal("Sync is not available in hosted mode.");
  }
  const body = await readObjectBody(req);
  if (body instanceof Response) return body;
  if (Object.keys(body).length !== 0) {
    return errorResponse(
      400,
      "invalid_request",
      "Sync run accepts an empty object",
    );
  }
  if (!syncData.isSyncEnabled()) {
    return errorResponse(
      409,
      "sync_disabled",
      "Enable sync before running it.",
    );
  }
  if (keystore.encryptionState() !== "on") {
    return errorResponse(
      409,
      "encryption_locked",
      "Unlock encryption before syncing.",
    );
  }
  const access = await accessFor(config);
  if (access.remote === "anonymous") {
    return errorResponse(401, "unauthorized", "Sign in before syncing.");
  }
  if (access.remote !== "ok") {
    return errorResponse(
      503,
      "unreachable",
      "The sync service is unavailable.",
    );
  }
  const result = await syncOnce();
  if (result.notAuthed) {
    return errorResponse(401, "unauthorized", "Sign in before syncing.");
  }
  return json(result);
}
