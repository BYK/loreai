/**
 * Pi (coding agent) on-disk credential reader.
 *
 * Pi stores auth in `~/.pi/agent/auth.json`. Observed shape is an object keyed
 * by provider ID whose value is either a raw API-key string or an object with
 * an `apiKey`/`key` field. The store is frequently empty (`{}`) when Pi relies
 * on environment variables instead — in that case readAuth() returns [].
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentAuthProvider, AgentResolvedAuth } from "../types";
import { registerAuthProvider } from "./index";
import { readJsonFile } from "./util";

type PiAuthValue = string | { apiKey?: string; key?: string };

function authPath(): string {
  return join(homedir(), ".pi", "agent", "auth.json");
}

const piAuth: AgentAuthProvider = {
  name: "pi",

  readAuth(): AgentResolvedAuth[] {
    const store = readJsonFile<Record<string, PiAuthValue>>(authPath());
    if (!store || typeof store !== "object") return [];

    const out: AgentResolvedAuth[] = [];
    for (const [providerID, value] of Object.entries(store)) {
      let key: string | undefined;
      if (typeof value === "string") key = value;
      else if (value && typeof value === "object")
        key = value.apiKey ?? value.key;

      if (typeof key === "string" && key) {
        out.push({ scheme: "api-key", value: key, providerID });
      }
    }
    return out;
  },
};

registerAuthProvider(piAuth);

export { piAuth };
