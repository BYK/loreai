/** Shared credential-header policy and free-text redaction. */

/** Internal gateway access credential. Never forward, learn, persist, or log. */
export const GATEWAY_AUTH_HEADER = "x-lore-gateway-token";

/**
 * Claude Code sub-agent (Task/Agent tool) correlation headers.
 *
 * A sub-agent request carries its own `x-claude-code-agent-id` (a fresh id per
 * sub-agent invocation) AND the parent's `x-claude-code-session-id`. The main
 * agent emits only the session-id (`x-claude-code-agent-id` is absent).
 * `x-claude-code-parent-agent-id` carries the parent *agent* id (not the parent
 * session id) and is never emitted by the main agent, so it never appears in
 * the header session index.
 */
export const CLAUDE_CODE_AGENT_ID_HEADER = "x-claude-code-agent-id";
export const CLAUDE_CODE_PARENT_AGENT_ID_HEADER =
  "x-claude-code-parent-agent-id";

export const KNOWN_SESSION_HEADERS = [
  "x-lore-session-id",
  // Claude Code sub-agents emit their own id AND the parent's
  // `x-claude-code-session-id`. The agent-id must win priority over the shared
  // session-id so a sub-agent gets its own session rather than merging into the
  // parent (whose message history then makes the sub-agent's short first request
  // look like a structural compaction — see pipeline.ts). Main-agent requests
  // carry only the session-id, so they are unaffected.
  CLAUDE_CODE_AGENT_ID_HEADER,
  "x-claude-code-session-id",
  "x-session-id",
  "x-session-affinity",
] as const;

const KNOWN_SAFE_HEADER_NAMES = new Set<string>([
  ...KNOWN_SESSION_HEADERS,
  "idempotency-key",
  "sec-websocket-key",
  "session-id",
]);

const KNOWN_CREDENTIAL_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "cookie2",
  GATEWAY_AUTH_HEADER,
  "x-api-key",
  "x-goog-api-key",
]);

const CREDENTIAL_HEADER_PATTERN =
  /(?:^|-)(?:(?:api|access|auth|bearer|client|consumer|identity|private|refresh|security|subscription)-?(?:id|key|secret|token)|auth|authenticate|authentication|authorisation|authorization|bearer|cookies?|credentials?|jwt|key|oauth|passphrase|passwd|password|secret|signature|token)(?:-|$)/;

const COLLAPSED_CREDENTIAL_HEADER_PATTERN =
  /^x(?:apikey|(?:auth|oauth|bearer|secret|token|key)sessionid)$/;

const CREDENTIAL_ASSIGNMENT_PATTERN =
  /(?:(['"])([A-Za-z][A-Za-z0-9._-]*)\1|([A-Za-z][A-Za-z0-9._-]*))(\s*[:=]\s*)/g;

const FOLLOWING_ASSIGNMENT_PATTERN =
  /\s+(?=(?:(?:['"])[A-Za-z][A-Za-z0-9._-]*(?:['"])|[A-Za-z][A-Za-z0-9._-]*)\s*[:=])/g;

function normalizeHeaderName(name: string): string {
  return name
    .trim()
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[._-]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function isCredentialHeaderName(name: string): boolean {
  const normalized = normalizeHeaderName(name);
  if (KNOWN_SAFE_HEADER_NAMES.has(normalized)) return false;
  if (KNOWN_CREDENTIAL_HEADER_NAMES.has(normalized)) return true;
  if (COLLAPSED_CREDENTIAL_HEADER_PATTERN.test(normalized.replaceAll("-", "")))
    return true;
  return CREDENTIAL_HEADER_PATTERN.test(normalized);
}

function quotedValueEnd(value: string, start: number): number {
  const quote = value[start];
  for (let index = start + 1; index < value.length; index++) {
    if (value[index] === "\\") {
      index++;
    } else if (value[index] === quote) {
      return index + 1;
    }
  }
  return value.length;
}

function structuredValueEnd(value: string, start: number): number {
  const closing: string[] = [value[start] === "{" ? "}" : "]"];
  let quote = "";

  for (let index = start + 1; index < value.length; index++) {
    const character = value[index];
    if (quote) {
      if (character === "\\") index++;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "{") {
      closing.push("}");
    } else if (character === "[") {
      closing.push("]");
    } else if (character === closing.at(-1)) {
      closing.pop();
      if (closing.length === 0) return index + 1;
    }
  }
  return value.length;
}

function unquotedValueEnd(
  value: string,
  start: number,
  compound: boolean,
): number {
  let compoundAssignment = false;
  FOLLOWING_ASSIGNMENT_PATTERN.lastIndex = start;
  for (
    let match = FOLLOWING_ASSIGNMENT_PATTERN.exec(value);
    match;
    match = FOLLOWING_ASSIGNMENT_PATTERN.exec(value)
  ) {
    const beforeAssignment = value.slice(start, match.index);
    const lineBreak = beforeAssignment.search(/[\r\n]/);
    if (lineBreak !== -1) return start + lineBreak;

    const trimmed = beforeAssignment.trimEnd();

    if (trimmed.endsWith(";") || trimmed.endsWith(",")) {
      compoundAssignment = true;
      continue;
    }
    return start + trimmed.length;
  }

  for (let index = start; index < value.length; index++) {
    if (value[index] === "\r" || value[index] === "\n") return index;
    if (value[index] === "}" || value[index] === "]") return index;
    if (!compound && !compoundAssignment && value[index] === ",") {
      const remainder = value.slice(index + 1);
      if (
        /^\s*(?:(?:['"])[A-Za-z][A-Za-z0-9._-]*(?:['"])|[A-Za-z][A-Za-z0-9._-]*)\s*:/.test(
          remainder,
        )
      ) {
        return index;
      }
    }
  }
  return value.length;
}

function credentialValueEnd(value: string, start: number, key: string): number {
  if (value[start] === '"' || value[start] === "'") {
    return quotedValueEnd(value, start);
  }
  if (value[start] === "{" || value[start] === "[") {
    return structuredValueEnd(value, start);
  }
  const compound = /(?:^|-)cookies?2?(?:-|$)/.test(normalizeHeaderName(key));
  return unquotedValueEnd(value, start, compound);
}

/** Redact assignments whose key is classified as a credential header. */
export function redactCredentialHeaderAssignments(
  value: string,
  replacement = "[Filtered]",
): string {
  let redacted = "";
  let copiedThrough = 0;
  CREDENTIAL_ASSIGNMENT_PATTERN.lastIndex = 0;

  for (let match = CREDENTIAL_ASSIGNMENT_PATTERN.exec(value); match;) {
    const key = match[2] ?? match[3];
    if (!isCredentialHeaderName(key)) {
      match = CREDENTIAL_ASSIGNMENT_PATTERN.exec(value);
      continue;
    }

    const valueStart = CREDENTIAL_ASSIGNMENT_PATTERN.lastIndex;
    const valueEnd = credentialValueEnd(value, valueStart, key);
    const valueQuote =
      (value[valueStart] === '"' || value[valueStart] === "'") &&
      value[valueEnd - 1] === value[valueStart]
        ? value[valueStart]
        : "";

    redacted += value.slice(copiedThrough, valueStart);
    redacted += `${valueQuote}${replacement}${valueQuote}`;
    copiedThrough = valueEnd;
    CREDENTIAL_ASSIGNMENT_PATTERN.lastIndex = valueEnd;
    match = CREDENTIAL_ASSIGNMENT_PATTERN.exec(value);
  }

  CREDENTIAL_ASSIGNMENT_PATTERN.lastIndex = 0;
  return copiedThrough === 0 ? value : redacted + value.slice(copiedThrough);
}
