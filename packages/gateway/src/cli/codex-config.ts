/** Codex's built-in OpenAI provider always enables WebSockets. Use a named
 * Responses provider so Lore's HTTP-only endpoint never incurs WS retries. */
import { parse as parseToml, stringify, type TomlTable } from "smol-toml";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Parser diagnostics include source lines, which can contain credentials. */
export function parseCodexToml(content: string): TomlTable {
  try {
    return parseToml(content);
  } catch {
    throw new Error(
      "Invalid Codex TOML configuration; check its syntax before running Lore setup.",
    );
  }
}

function isTable(value: unknown): value is TomlTable {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeProviderBackup(value: string): string {
  try {
    const decoded: unknown = JSON.parse(value);
    if (typeof decoded === "string") return decoded;
  } catch {
    /* Never include a backup's contents in diagnostics. */
  }
  throw new Error("Invalid Codex provider backup.");
}

export const CODEX_HTTP_PROVIDER = "lore_http";
export const CODEX_PROVIDER_BACKUP_KEY = "model_providers.lore_http";

export function codexHttpProvider(baseUrl: string): TomlTable {
  return {
    name: "Lore",
    base_url: baseUrl,
    wire_api: "responses",
    requires_openai_auth: true,
    supports_websockets: false,
    // Match Codex's built-in OpenAI provider: values name environment
    // variables that Codex resolves at request time, preserving account scoping.
    env_http_headers: {
      "OpenAI-Organization": "OPENAI_ORGANIZATION",
      "OpenAI-Project": "OPENAI_PROJECT",
    },
  };
}

/** Only count actual table headers, never header-looking lines inside strings. */
export function tomlHeaders(
  lines: string[],
): { index: number; path: string[] }[] {
  const headers: { index: number; path: string[] }[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (!/^\s*\[/.test(lines[index])) continue;
    try {
      // Restore the line terminator removed by split/slice. In CRLF files
      // the last line retains its CR, which must be followed by LF to parse.
      parseCodexToml(`${lines.slice(0, index + 1).join("\n")}\n`);
      let value: unknown = parseCodexToml(`${lines[index]}\n`);
      const path: string[] = [];
      while (value && typeof value === "object" && !Array.isArray(value)) {
        const entries = Object.entries(value);
        if (entries.length !== 1) break;
        path.push(entries[0][0]);
        value = entries[0][1];
      }
      headers.push({ index, path });
    } catch {
      // A prefix ending inside a multiline string is not a table declaration.
    }
  }
  return headers;
}

export function isTomlTopLevelLine(lines: string[], index: number): boolean {
  try {
    parseCodexToml(`${lines.slice(0, index).join("\n")}\n`);
    return !tomlHeaders(lines.slice(0, index)).length;
  } catch {
    return false;
  }
}

function providerRange(content: string): { start: number; end: number } | null {
  const config = parseCodexToml(content);
  const providers = config.model_providers;
  if (providers !== undefined && !isTable(providers))
    throw new Error("Invalid Codex model_providers configuration.");
  if (!providers || !Object.hasOwn(providers, CODEX_HTTP_PROVIDER)) return null;
  const lines = content.split("\n");
  const headers = tomlHeaders(lines);
  const isProvider = (path: string[]) =>
    path[0] === "model_providers" && path[1] === CODEX_HTTP_PROVIDER;
  const start = headers.findIndex(
    (header) => isProvider(header.path) && header.path.length === 2,
  );
  const end = headers.findIndex(
    (header, index) => index > start && !isProvider(header.path),
  );
  if (
    start === -1 ||
    headers.some(
      (header, index) => end !== -1 && index >= end && isProvider(header.path),
    )
  ) {
    throw new Error(
      "Codex model_providers.lore_http must use a contiguous [model_providers.lore_http] table; config was not changed.",
    );
  }
  return {
    start: headers[start].index,
    end: end === -1 ? lines.length : headers[end].index,
  };
}

/** Encode the whole provider block as one backup value. Restoring individual
 * fields could leave an edited provider without the name Codex requires. */
export function getCodexProviderValue(content: string): string | null {
  const range = providerRange(content);
  if (!range) return null;
  return JSON.stringify(
    content.split("\n").slice(range.start, range.end).join("\n"),
  );
}

export function setCodexProviderValue(
  content: string,
  value: string | null,
): string {
  const range = providerRange(content);
  const block = value === null ? "" : decodeProviderBackup(value);
  // A backup may restore only this provider, never arbitrary config or tables.
  // A block sliced before the next table can end in the CR of its CRLF.
  // Complete that terminator for validation while retaining the original bytes.
  const restored = parseCodexToml(`${block}\n`);
  if (
    block &&
    (Object.keys(restored).length !== 1 ||
      !isTable(restored.model_providers) ||
      Object.keys(restored.model_providers).length !== 1 ||
      !isTable(restored.model_providers[CODEX_HTTP_PROVIDER]))
  ) {
    throw new Error("Invalid Codex provider backup.");
  }
  let result: string;
  if (range) {
    const lines = content.split("\n");
    result = [
      ...lines.slice(0, range.start),
      ...(block ? block.split("\n") : []),
      ...lines.slice(range.end),
    ].join("\n");
  } else {
    result = block
      ? `${content.trimEnd()}${content.trim() ? "\n\n" : ""}${block}`
      : content;
  }
  parseCodexToml(result);
  return result;
}

export function codexProviderValue(content: string, baseUrl: string): string {
  const config = parseCodexToml(content);
  const profiles = config.profiles;
  const active =
    typeof config.profile === "string" && isTable(profiles)
      ? profiles[config.profile]
      : undefined;
  if (
    isTable(active) &&
    active.model_provider !== undefined &&
    active.model_provider !== CODEX_HTTP_PROVIDER
  ) {
    throw new Error(
      "Codex's default profile overrides model_provider; remove that override or set it to lore_http before running Lore setup.",
    );
  }
  const existing = (config.model_providers as TomlTable | undefined)?.[
    CODEX_HTTP_PROVIDER
  ] as TomlTable | undefined;
  assertCodexHttpProviderCompatible(content);
  const defaults = codexHttpProvider(baseUrl);
  const provider = {
    ...existing,
    ...defaults,
    env_http_headers: {
      ...(defaults.env_http_headers as TomlTable),
      ...(existing?.env_http_headers as TomlTable),
    },
    http_headers: {
      ...(config.openai_provider_headers as TomlTable),
      ...(existing?.http_headers as TomlTable),
    },
  };
  if (!Object.keys(provider.http_headers).length)
    delete (provider as Partial<typeof provider>).http_headers;
  return JSON.stringify(
    stringify({ model_providers: { [CODEX_HTTP_PROVIDER]: provider } }),
  );
}

export function assertCodexHttpProviderCompatible(content: string): void {
  const config = parseCodexToml(content);
  const providers = config.model_providers;
  if (providers !== undefined && !isTable(providers))
    throw new Error("Invalid Codex model_providers configuration.");
  const existing = isTable(providers)
    ? providers[CODEX_HTTP_PROVIDER]
    : undefined;
  if (existing !== undefined && !isTable(existing))
    throw new Error("Invalid Codex model_providers.lore_http configuration.");
  if (
    existing &&
    [
      "auth",
      "aws",
      "env_key",
      "experimental_bearer_token",
      "gateway_oauth",
    ].some((key) => Object.hasOwn(existing, key))
  ) {
    throw new Error(
      "Codex model_providers.lore_http contains custom authentication; rename that provider before running Lore setup.",
    );
  }
}

/** Run before acquiring gateway resources. Codex merges CLI tables, so an
 * existing reserved provider's auth fields cannot be cleared with -c. */
export function validateCodexHttpLaunch(): string {
  const configDir = process.env.CODEX_HOME || join(homedir(), ".codex");
  let content: string;
  try {
    content = readFileSync(join(configDir, "config.toml"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw new Error(
      "Cannot read Codex configuration before launching Lore's HTTP provider.",
    );
  }
  assertCodexHttpProviderCompatible(content);
  return content;
}

/** Preserve the built-in provider's persisted headers without exposing their
 * values in -c arguments or the launch log. Both builders receive one snapshot. */
export function codexPersistedHeaderEnv(
  content: string,
  overriddenNames: string[] = [],
): {
  env: Record<string, string>;
  mappings: Record<string, string>;
} {
  const config = parseCodexToml(content);
  const headers = config.openai_provider_headers;
  if (headers !== undefined && !isTable(headers))
    throw new Error("Invalid Codex openai_provider_headers configuration.");
  const env: Record<string, string> = {};
  const mappings: Record<string, string> = {};
  for (const [index, [name, value]] of Object.entries(
    headers ?? {},
  ).entries()) {
    if (typeof value !== "string")
      throw new Error("Invalid Codex openai_provider_headers configuration.");
    if (
      overriddenNames.some(
        (candidate) => candidate.toLowerCase() === name.toLowerCase(),
      )
    )
      continue;
    const variable = `LORE_CODEX_HEADER_${index}`;
    env[variable] = value;
    mappings[name] = variable;
  }
  return { env, mappings };
}
