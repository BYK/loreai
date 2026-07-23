/**
 * Claude Code on-disk credential reader.
 *
 * Claude Code stores its subscription OAuth token in `~/.claude/.credentials.json`
 * under `claudeAiOauth`:
 *   { claudeAiOauth: { accessToken, refreshToken, expiresAt, ... } }
 *
 * The access token is an `anthropic` bearer credential. (On macOS the token may
 * live in the Keychain instead of this file; that path is not handled in v1 —
 * readAuth() simply returns [] when the file is absent.)
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentAuthProvider, AgentResolvedAuth } from "../types";
import { registerAuthProvider } from "./index";
import { readJsonFile } from "./util";

type ClaudeCredentials = {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
  };
};

function credentialsPath(): string {
  return join(homedir(), ".claude", ".credentials.json");
}

const claudeCodeAuth: AgentAuthProvider = {
  name: "claude-code",

  readAuth(): AgentResolvedAuth[] {
    const store = readJsonFile<ClaudeCredentials>(credentialsPath());
    const oauth = store?.claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== "string" || !oauth.accessToken) {
      return [];
    }
    return [
      {
        scheme: "bearer",
        value: oauth.accessToken,
        providerID: "anthropic",
        expiresAt:
          typeof oauth.expiresAt === "number" ? oauth.expiresAt : undefined,
      },
    ];
  },
};

registerAuthProvider(claudeCodeAuth);

export { claudeCodeAuth };
