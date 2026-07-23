/**
 * Codex (OpenAI) on-disk credential reader.
 *
 * Codex stores auth in `~/.codex/auth.json`. Two shapes exist:
 *   - `{ "OPENAI_API_KEY": "sk-..." }`  → a raw OpenAI API key (directly usable)
 *   - `{ "tokens": { access_token, ... } }` → ChatGPT-plan OAuth for the
 *     chatgpt.com backend. That backend serves only the session's own model and
 *     needs Codex's own token-exchange/routing; it is NOT usable as a plain
 *     bearer for `openai` extraction, so v1 skips it (returns nothing for it).
 *
 * Result: a usable credential is returned only when a raw `OPENAI_API_KEY` is
 * present. Otherwise readAuth() returns [] and the import chain falls through.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentAuthProvider, AgentResolvedAuth } from "../types";
import { registerAuthProvider } from "./index";
import { readJsonFile } from "./util";

type CodexAuth = {
  OPENAI_API_KEY?: string | null;
  tokens?: { access_token?: string };
};

function authPath(): string {
  return join(homedir(), ".codex", "auth.json");
}

const codexAuth: AgentAuthProvider = {
  name: "codex",

  readAuth(): AgentResolvedAuth[] {
    const store = readJsonFile<CodexAuth>(authPath());
    if (!store) return [];

    const apiKey = store.OPENAI_API_KEY;
    if (typeof apiKey === "string" && apiKey) {
      return [{ scheme: "api-key", value: apiKey, providerID: "openai" }];
    }
    // ChatGPT-plan OAuth (tokens.access_token) is not usable for plain openai
    // extraction — skip. (Follow-up: openai-codex backend routing.)
    return [];
  },
};

registerAuthProvider(codexAuth);

export { codexAuth };
