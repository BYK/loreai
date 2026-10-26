import {
  parseRecallToolArguments,
  type RecallToolExecutor,
} from "./recall-tool";
import { NATIVE_RECALL_TURN_HEADER } from "./recall-turn";
export { NATIVE_RECALL_TURN_HEADER } from "./recall-turn";

const AUTH_HEADERS = ["x-api-key", "x-goog-api-key", "authorization"] as const;
const AUTH_TTL_MS = 30 * 60 * 1000;
const MAX_AUTH_ENTRIES = 256;
const UNAVAILABLE = "Recall is unavailable for this authenticated session.";

/**
 * Native tools execute in the gateway that owns session identity, configuration,
 * and opaque detail handles. Never fall back to a different local database.
 */
export function createGatewayRecallClient(gatewayBase: string): {
  execute: RecallToolExecutor;
  observeRequestHeaders: (headers: Headers) => void;
} {
  const credentials = new Map<
    string,
    {
      projectPath: string;
      sessionID: string;
      providerID: string;
      turnID: string;
      auth: Record<string, string> | null;
      expiresAt: number;
    }
  >();
  const keyFor = (
    projectPath: string,
    sessionID: string,
    providerID = "",
    turnID = "",
  ) => JSON.stringify([projectPath, sessionID, providerID, turnID]);
  const endpoint = `${gatewayBase.replace(/\/+$/, "")}/v1/recall`;

  return {
    observeRequestHeaders(headers) {
      const project = headers.get("x-lore-project");
      const session = headers.get("x-lore-session-id");
      if (!project || !session) return;
      const now = Date.now();
      for (const [key, entry] of credentials) {
        if (entry.expiresAt <= now) credentials.delete(key);
      }
      // Only provider credentials establish recall ownership. Retired gateway
      // tokens must never change that identity or be forwarded to the gateway.
      const auth = Object.fromEntries(
        AUTH_HEADERS.flatMap((name) => {
          const value = headers.get(name);
          return value ? [[name, value]] : [];
        }),
      );
      const providerID = headers.get("x-lore-provider") ?? "";
      const turnID = headers.get(NATIVE_RECALL_TURN_HEADER) ?? "";
      const key = keyFor(project, session, providerID, turnID);
      const previous = credentials.get(key);
      // If one provider in the same assistant turn is used by multiple
      // credentials, guessing the most recent one could
      // read another authenticated session's memory. Fail closed instead.
      const unambiguous =
        AUTH_HEADERS.filter((name) => headers.has(name)).length <= 1 &&
        (!previous || JSON.stringify(previous.auth) === JSON.stringify(auth));
      credentials.delete(key);
      credentials.set(key, {
        projectPath: project,
        sessionID: session,
        providerID,
        turnID,
        auth: unambiguous ? auth : null,
        expiresAt: now + AUTH_TTL_MS,
      });
      if (credentials.size > MAX_AUTH_ENTRIES) {
        const oldest = credentials.keys().next().value;
        if (oldest !== undefined) credentials.delete(oldest);
      }
    },
    async execute(input, context) {
      if (context.signal?.aborted) return "Recall was cancelled.";
      try {
        const parsed = parseRecallToolArguments(input);
        if (!parsed.valid) return parsed.error;
        if (!context.sessionID) return UNAVAILABLE;
        let candidates = context.providerID
          ? [
              credentials.get(
                keyFor(
                  context.projectPath,
                  context.sessionID,
                  context.providerID,
                  context.turnID,
                ),
              ),
            ]
          : [...credentials.values()].filter(
              (candidate) =>
                candidate.projectPath === context.projectPath &&
                candidate.sessionID === context.sessionID &&
                candidate.turnID === (context.turnID ?? "") &&
                candidate.expiresAt > Date.now(),
            );
        if (context.providerID && context.turnID && !candidates[0]) {
          const exactTurn = [...credentials.values()].filter(
            (candidate) =>
              candidate.projectPath === context.projectPath &&
              candidate.sessionID === context.sessionID &&
              candidate.turnID === context.turnID &&
              candidate.expiresAt > Date.now(),
          );
          // An intercepted custom provider may omit its name. The verified
          // nonce still proves origin, but only a sole nameless observation
          // can substitute for the exact named provider.
          if (exactTurn.length === 1 && exactTurn[0]?.providerID === "")
            candidates = exactTurn;
        }
        const entry = candidates.length === 1 ? candidates[0] : undefined;
        if (!entry?.auth || entry.expiresAt <= Date.now()) return UNAVAILABLE;
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            ...entry.auth,
            "content-type": "application/json",
            "x-lore-project": context.projectPath,
            "x-lore-session-id": context.sessionID,
            ...(entry.providerID
              ? { "x-lore-provider": entry.providerID }
              : {}),
            ...(entry.turnID
              ? { [NATIVE_RECALL_TURN_HEADER]: entry.turnID }
              : {}),
          },
          body: JSON.stringify(parsed.value),
          signal: context.signal,
          // A gateway redirect must never forward provider credentials.
          redirect: "error",
        });
        if (!response.ok) return UNAVAILABLE;
        const body: unknown = await response.json();
        if (context.signal?.aborted) return "Recall was cancelled.";
        return body &&
          typeof body === "object" &&
          "result" in body &&
          typeof body.result === "string"
          ? body.result
          : UNAVAILABLE;
      } catch {
        return context.signal?.aborted ? "Recall was cancelled." : UNAVAILABLE;
      }
    },
  };
}
