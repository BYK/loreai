import type { Event } from "@sentry/bun";
import {
  isCredentialHeaderName,
  redactCredentialHeaderAssignments,
} from "./credential-headers";
import { RECALL_CONTINUATION_FAILURE_CATEGORIES } from "./recall-continuation-failure";

export const SENTRY_DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: { request: false, response: false },
  httpBodies: [],
  queryParams: false,
  genAI: { inputs: false, outputs: false },
  stackFrameVariables: false,
  frameContextLines: 0,
};

const FILTERED = "[Filtered]";
const QUERY_VALUE_KEY =
  /(?:^|[._-])(?:query[._-]?string|http[._-]?query|url[._-]?query|request[._-]?query)(?:$|[._-])/i;
const URL_KEY = /(?:^|[._-])(?:url|uri|href)(?:$|[._-])/i;
const SENSITIVE_TEXT_KEY = String.raw`(?:proxy[\s._-]*authorization|authorization|x[\s._-]*api[\s._-]*key|api[\s._-]*key|(?:api|access|auth|bearer|client|consumer|identity|private|refresh|security|subscription)[\s._-]*(?:id|key|secret|token)|ocp[\s._-]*apim[\s._-]*subscription[\s._-]*key|cf[\s._-]*access[\s._-]*client[\s._-]*id|set[\s._-]*cookie|(?:[a-z0-9]+[\s._-]+)*signatures?|token|secret|password|passwd|passphrase|credentials?|cookies?)`;
const PRIVATE_CONTENT_KEYS = new Set([
  "alias",
  "body",
  "bodysnippet",
  "command",
  "cwd",
  "detail",
  "entityalias",
  "entityname",
  "error",
  "errorbody",
  "errormessage",
  "filepath",
  "path",
  "projectpath",
  "prompt",
  "prompttitle",
  "rawbody",
  "requestbody",
  "responsebody",
  "slashcommand",
  "snippet",
  "title",
  "upstreambody",
]);
const SAFE_ERROR_TELEMETRY_MESSAGES = [
  /^Batch item failed$/,
  /^Cache bust spiral past cold-start grace — investigate caching bug$/,
  /^Client abort under host pressure$/,
  /^Empty completion returned to client \(no content blocks\)$/,
  /^Embedding worker OOM:/,
  /^Recall continuation failed$/,
  /^Worker health critical: sustained worker failure$/,
  /^Worker health degraded$/,
  /^Worker upstream auth error: HTTP \d+$/,
  /^Worker upstream exhausted \d+ retries: HTTP \d+(?: embedded \d+)?$/,
  /^cch: multiple billing-header sentinels in request body/,
  /^tool-pairing 400 \(tool_use\/tool_result concurrency\)$/,
];

export function isolateRecallContinuationEvent<T extends Event>(
  event: T,
): T | null {
  if (event.message !== "Recall continuation failed") return null;
  const category = event.contexts?.recall_continuation_failure?.category;
  if (
    typeof category !== "string" ||
    !RECALL_CONTINUATION_FAILURE_CATEGORIES.includes(
      category as (typeof RECALL_CONTINUATION_FAILURE_CATEGORIES)[number],
    )
  ) {
    return null;
  }
  return {
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: event.platform,
    level: "warning",
    message: "Recall continuation failed",
    fingerprint: ["recall-continuation-failure", category],
    contexts: { recall_continuation_failure: { category } },
  } as unknown as T;
}

function canonicalKey(key: string): { words: string[]; canonical: string } {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return { words, canonical: words.join("") };
}

/**
 * Classify structured keys after splitting camelCase/PascalCase and separators.
 * Telemetry is intentionally conservative: a false positive loses one
 * diagnostic attribute, while a false negative can disclose a credential.
 */
export function isSensitiveTelemetryKey(key: string): boolean {
  const { words, canonical } = canonicalKey(key);

  if (isCredentialHeaderName(key)) return true;

  if (
    [
      "authorization",
      "proxyauthorization",
      "apikey",
      "xapikey",
      "clientsecret",
      "accesstoken",
      "refreshtoken",
      "sessiontoken",
      "securitytoken",
      "idtoken",
      "authtoken",
      "bearertoken",
      "privatekey",
      "setcookie",
      "token",
      "secret",
      "password",
      "passwd",
      "passphrase",
      "credential",
      "credentials",
      "cookie",
      "cookies",
      "signature",
      "signatures",
    ].some((name) => canonical.endsWith(name))
  ) {
    return true;
  }

  return words.some((word) =>
    [
      "authorization",
      "token",
      "secret",
      "password",
      "passwd",
      "passphrase",
      "credential",
      "credentials",
      "cookie",
      "cookies",
      "signature",
      "signatures",
    ].includes(word),
  );
}

function isPrivateContentKey(key: string): boolean {
  const { words, canonical } = canonicalKey(key);
  return (
    PRIVATE_CONTENT_KEYS.has(canonical) ||
    words.includes("snippet") ||
    canonical.endsWith("snippet")
  );
}

function scrubErrorTelemetryMessage(value: string): string {
  const scrubbed = scrubTelemetryText(value);
  return SAFE_ERROR_TELEMETRY_MESSAGES.some((pattern) => pattern.test(scrubbed))
    ? scrubbed
    : "Application error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Remove userinfo, query values, and fragments from an HTTP(S) URL. */
export function scrubTelemetryUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return value;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

/** Redact credentials and query-bearing URLs embedded in free-form text. */
export function scrubTelemetryText(value: string): string {
  return redactCredentialHeaderAssignments(value, FILTERED)
    .replace(
      /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
      (match, scheme: string, offset: number, source: string) =>
        /(?:^|[\s._-])scheme\s*=\s*$/i.test(
          source.slice(Math.max(0, offset - 32), offset),
        )
          ? match
          : `${scheme} ${FILTERED}`,
    )
    .replace(
      new RegExp(
        String.raw`(^|[\r\n])([\t ]*(?:${SENSITIVE_TEXT_KEY})[\t ]*:[\t ]*)[^\r\n]*`,
        "gi",
      ),
      `$1$2${FILTERED}`,
    )
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => scrubTelemetryUrl(url))
    .replace(/\bfile:\/\/\/[^\s"'<>]+/gi, FILTERED)
    .replace(/\b[A-Za-z]:[\\/][^\s"'<>]+/g, FILTERED)
    .replace(
      /(^|[\s"'(=])(?:~?\/[^\s"'<>]+)/g,
      (_match, prefix: string) => `${prefix}${FILTERED}`,
    )
    .replace(/([?&][^\s=&#]+)=([^\s&#]*)/g, `$1=${FILTERED}`);
}

function scrubRequest(value: Record<string, unknown>): Record<string, unknown> {
  const request: Record<string, unknown> = {};
  if (typeof value.method === "string") request.method = value.method;
  if (typeof value.url === "string") {
    request.url = scrubTelemetryUrl(value.url);
  }
  return request;
}

function scrubValue(
  value: unknown,
  seen: WeakMap<object, unknown>,
  parentKey?: string,
): unknown {
  if (typeof value === "string") {
    return URL_KEY.test(parentKey ?? "")
      ? scrubTelemetryUrl(scrubTelemetryText(value))
      : scrubTelemetryText(value);
  }
  if (
    value === null ||
    typeof value !== "object" ||
    value instanceof Date ||
    ArrayBuffer.isView(value)
  ) {
    return value;
  }

  const existing = seen.get(value);
  if (existing !== undefined) return existing;

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(scrubValue(item, seen));
    return copy;
  }

  const record = value as Record<string, unknown>;
  if (parentKey?.toLowerCase() === "request") {
    return scrubRequest(record);
  }

  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, child] of Object.entries(record)) {
    if (
      isSensitiveTelemetryKey(key) ||
      isPrivateContentKey(key) ||
      QUERY_VALUE_KEY.test(key)
    ) {
      copy[key] = FILTERED;
    } else if (key.toLowerCase() === "breadcrumbs") {
      copy[key] = [];
    } else if (key.toLowerCase() === "request" && isRecord(child)) {
      copy[key] = scrubRequest(child);
    } else {
      copy[key] = scrubValue(child, seen, key);
    }
  }
  return copy;
}

/** Deep-copy and redact an arbitrary telemetry payload or envelope. */
export function scrubTelemetryValue<T>(value: T): T {
  return scrubValue(value, new WeakMap()) as T;
}

/** Apply event-specific privacy rules while retaining non-sensitive diagnostics. */
export function scrubTelemetryEvent<T extends Event>(event: T): T {
  if (event.message === "Recall continuation failed") {
    return isolateRecallContinuationEvent(event) ?? ({} as T);
  }
  const originalMessage = event.message;
  const originalExceptions = event.exception?.values;
  const scrubbed = scrubTelemetryValue(event);
  if (typeof originalMessage === "string") {
    scrubbed.message = scrubErrorTelemetryMessage(originalMessage);
  }
  for (const [index, exception] of (
    scrubbed.exception?.values ?? []
  ).entries()) {
    const originalValue = originalExceptions?.[index]?.value;
    if (typeof originalValue === "string") {
      exception.value = scrubErrorTelemetryMessage(originalValue);
    }
  }
  scrubbed.breadcrumbs = undefined;
  if (scrubbed.user) {
    scrubbed.user = scrubbed.user.id ? { id: scrubbed.user.id } : undefined;
  }
  return scrubbed;
}

/** Add a final privacy boundary around a Sentry-compatible transport. */
export function wrapTelemetryTransport<Envelope, Response>(transport: {
  send(envelope: Envelope): PromiseLike<Response>;
  flush(timeout?: number): PromiseLike<boolean>;
}): {
  send(envelope: Envelope): PromiseLike<Response>;
  flush(timeout?: number): PromiseLike<boolean>;
} {
  return {
    send: (envelope) => transport.send(scrubEnvelope(envelope)),
    flush: (timeout) => transport.flush(timeout),
  };
}

/** Scrub a complete Sentry envelope and drop disabled item types. */
export function scrubTelemetryEnvelope<T>(envelope: T): T {
  return scrubEnvelope(envelope);
}

function scrubEnvelope<T>(envelope: T): T {
  return scrubTelemetryValue(scrubEnvelopeEvents(envelope));
}

/** Drop Sentry log envelope items at the final transport boundary. */
function scrubEnvelopeEvents<T>(envelope: T): T {
  if (!Array.isArray(envelope) || !Array.isArray(envelope[1])) return envelope;
  const copy = [...envelope];
  copy[1] = envelope[1]
    .filter((item) => {
      if (!Array.isArray(item) || !isRecord(item[0])) return true;
      return item[0].type !== "log";
    })
    .map((item) => {
      if (
        !Array.isArray(item) ||
        !isRecord(item[0]) ||
        !isRecord(item[1]) ||
        (item[0].type !== "event" && item[0].type !== "transaction")
      ) {
        return item;
      }
      return [item[0], scrubTelemetryEvent(item[1] as Event)];
    });
  return copy as T;
}
