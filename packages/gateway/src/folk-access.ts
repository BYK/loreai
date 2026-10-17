import type { SupabaseClient } from "@supabase/supabase-js";
import { isHostedMode, syncData } from "@loreai/core";
import type { GatewayConfig } from "./config";
import { getAuthedClient, loadPersistedSession } from "./supabase";

export type RemoteStatus = "ok" | "anonymous" | "unreachable" | "hosted";

export type Access = {
  remote: RemoteStatus;
  client: SupabaseClient | null;
  me: string | null;
};

export const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function errorResponse(
  status: number,
  type: string,
  message: string,
  fields: Record<string, unknown> = {},
): Response {
  return json({ type: "error", error: { type, message, ...fields } }, status);
}

export function requestIsHosted(config: GatewayConfig): boolean {
  return (
    config.hostedMode ||
    config.remoteGateway ||
    isHostedMode() ||
    !syncData.isLocalSyncContext()
  );
}

export function hostedRefusal(message: string): Response {
  return errorResponse(403, "forbidden", message);
}

export async function accessFor(config: GatewayConfig): Promise<Access> {
  if (requestIsHosted(config)) {
    return { remote: "hosted", client: null, me: null };
  }
  const session = loadPersistedSession();
  if (!session) return { remote: "anonymous", client: null, me: null };
  try {
    const client = await getAuthedClient();
    if (!client) return { remote: "anonymous", client: null, me: null };
    return { remote: "ok", client, me: session.user_id };
  } catch {
    return { remote: "unreachable", client: null, me: session.user_id };
  }
}

export function parseObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function readObjectBody(
  req: Request,
): Promise<Record<string, unknown> | Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "invalid_request", "Invalid JSON body");
  }
  const object = parseObject(body);
  return (
    object ?? errorResponse(400, "invalid_request", "Expected an object body")
  );
}

export function routeId(
  segment: string,
  label = "Promotion id",
): string | Response {
  let id: string;
  try {
    id = decodeURIComponent(segment);
  } catch {
    return errorResponse(400, "invalid_request", `${label} must be a UUID`);
  }
  return UUID.test(id)
    ? id
    : errorResponse(400, "invalid_request", `${label} must be a UUID`);
}

export function localIdentityLabel(userId: string): string | null {
  const session = loadPersistedSession();
  if (!session || session.user_id !== userId) return null;
  if (session.github_login) return `@${session.github_login}`;
  return session.display_name ?? session.email ?? null;
}
