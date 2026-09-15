/** Deterministic, bounded companion-context retrieval for large semantic-lint PRs. */
import type { DiffHunk } from "./check";

export interface ConnectedCompanion {
  hunkIndex: number;
  reason: "same-file" | "shared-symbol" | "import-relationship" | "test-pair";
  score: number;
}

export const MAX_CONTEXT_CANDIDATES_PER_SEED = 64;
export const MAX_CONTEXT_RELATION_CHECKS = 64_000;
export const MAX_CONTEXT_BYTES = 12 * 1024;

const MAX_COMPANIONS = 3;
const MAX_TOKEN_FANOUT = 64;
const MAX_SAME_FILE_CANDIDATES = 16;
const MAX_DIRECT_CANDIDATES = 32;
const TOKEN_RE = /\b[A-Za-z_$][\w$]{2,}\b/g;
const IMPORT_RE =
  /^\s*(?:import(?:[^;\r\n]*?\sfrom\s+|\s*)|export[^;\r\n]*?\sfrom\s+|(?:const|let|var)[^;\r\n]*?=\s*require\()\s*['"]([^'"]+)['"]/gm;
const STRING_RE = /(["'\x60])(?:\\.|(?!\1)[^\r\n])*\1/g;
const TEST_RE = /(?:^|[./_-])(test|spec|tests?)(?:[./_-]|$)/i;
const CONTEXT_TRUNCATION_MARKER = "\n... [seed hunk truncated by Lore] ...\n";

const IGNORED_TOKENS = new Set([
  "any",
  "as",
  "async",
  "await",
  "boolean",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "config",
  "context",
  "data",
  "default",
  "delete",
  "do",
  "else",
  "error",
  "export",
  "extends",
  "false",
  "finally",
  "file",
  "for",
  "from",
  "function",
  "get",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "input",
  "interface",
  "let",
  "name",
  "module",
  "new",
  "null",
  "of",
  "options",
  "output",
  "path",
  "private",
  "protected",
  "public",
  "readonly",
  "require",
  "request",
  "response",
  "return",
  "result",
  "set",
  "static",
  "string",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "typeof",
  "undefined",
  "unknown",
  "var",
  "void",
  "while",
  "with",
  "value",
  "yield",
  "assert",
  "describe",
  "expect",
  "it",
  "mock",
  "setup",
  "status",
  "test",
  "url",
]);

interface HunkMetadata {
  file: string;
  module: string;
  tokens: Set<string>;
  imports: Set<string>;
  lineStart: number | null;
  isTest: boolean;
}

interface HunkIndex {
  metadata: HunkMetadata[];
  byFile: Map<string, number[]>;
  byModule: Map<string, number[]>;
  byToken: Map<string, number[]>;
  byImportTarget: Map<string, number[]>;
}

function changedLines(hunk: DiffHunk): string {
  return hunk.text
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

function codeText(hunk: DiffHunk): string {
  return changedLines(hunk)
    .replace(STRING_RE, " ")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

function tokens(hunk: DiffHunk): Set<string> {
  const result = new Set<string>();
  for (const token of codeText(hunk).match(TOKEN_RE) ?? []) {
    if (!IGNORED_TOKENS.has(token)) result.add(token);
  }
  return result;
}

function imports(hunk: DiffHunk): Set<string> {
  const result = new Set<string>();
  for (const match of changedLines(hunk).matchAll(IMPORT_RE)) {
    if (match[1]) result.add(match[1]);
  }
  return result;
}

function basename(file: string): string {
  return file.split("/").pop() ?? file;
}

function normalizePath(file: string): string {
  const parts: string[] = [];
  for (const part of file.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}

function modulePath(file: string): string {
  return normalizePath(file)
    .replace(/\.(tsx?|jsx?|mjs|cjs|py|rs|go|java)$/i, "")
    .replace(/\/index$/i, "");
}

function moduleLookupKeys(module: string): string[] {
  const normalized = normalizePath(module);
  const parts = normalized.split("/").filter(Boolean);
  const keys: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    keys.push(parts.slice(i).join("/"));
  }
  return keys;
}

function stem(file: string): string {
  return basename(file)
    .replace(/\.(tsx?|jsx?|mjs|cjs|py|rs|go|java)$/i, "")
    .replace(/(?:[._](?:test|spec)|_test)$/i, "")
    .replace(/^test_/i, "");
}

function lineStart(hunk: DiffHunk): number | null {
  const match = hunk.text.match(/^@@ -\d+(?:,\d+)? \+(\d+)/m);
  return match ? Number(match[1]) : null;
}

function metadata(hunk: DiffHunk): HunkMetadata {
  return {
    file: hunk.file,
    module: modulePath(hunk.file),
    tokens: tokens(hunk),
    imports: imports(hunk),
    lineStart: lineStart(hunk),
    isTest: TEST_RE.test(hunk.file),
  };
}

function addIndex(
  index: Map<string, number[]>,
  key: string,
  value: number,
): void {
  if (!key) return;
  const values = index.get(key);
  if (values) {
    values.push(value);
  } else {
    index.set(key, [value]);
  }
}

function importTarget(importer: HunkMetadata, specifier: string): string {
  if (!specifier.startsWith(".")) return modulePath(specifier);
  const directory = importer.file.split("/").slice(0, -1).join("/");
  return modulePath(normalizePath(directory + "/" + specifier));
}

function buildIndex(hunks: DiffHunk[]): HunkIndex {
  const metadataList = hunks.map(metadata);
  const index: HunkIndex = {
    metadata: metadataList,
    byFile: new Map(),
    byModule: new Map(),
    byToken: new Map(),
    byImportTarget: new Map(),
  };

  for (let i = 0; i < metadataList.length; i++) {
    const item = metadataList[i];
    addIndex(index.byFile, item.file, i);
    for (const key of moduleLookupKeys(item.module)) {
      addIndex(index.byModule, key, i);
    }
    for (const token of item.tokens) {
      addIndex(index.byToken, token, i);
    }
    for (const specifier of item.imports) {
      addIndex(index.byImportTarget, importTarget(item, specifier), i);
    }
  }
  return index;
}

function appendCandidates(
  target: Set<number>,
  candidates: number[] | undefined,
  seedIndex: number,
  limit: number,
): void {
  if (!candidates) return;
  for (const candidate of candidates) {
    if (candidate !== seedIndex) target.add(candidate);
    if (target.size >= limit) return;
  }
}

function candidateIndexes(seedIndex: number, index: HunkIndex): number[] {
  const seed = index.metadata[seedIndex];
  const candidates = new Set<number>();
  const direct = new Set<number>();

  for (const specifier of seed.imports) {
    for (const key of moduleLookupKeys(importTarget(seed, specifier))) {
      appendCandidates(
        direct,
        index.byModule.get(key),
        seedIndex,
        MAX_DIRECT_CANDIDATES,
      );
    }
  }
  for (const key of moduleLookupKeys(seed.module)) {
    appendCandidates(
      direct,
      index.byImportTarget.get(key),
      seedIndex,
      MAX_DIRECT_CANDIDATES,
    );
  }
  appendCandidates(
    candidates,
    [...direct],
    seedIndex,
    MAX_CONTEXT_CANDIDATES_PER_SEED,
  );

  const sameFile = [...(index.byFile.get(seed.file) ?? [])].filter(
    (candidate) => candidate !== seedIndex,
  );
  sameFile.sort((a, b) => {
    const aLine = index.metadata[a].lineStart;
    const bLine = index.metadata[b].lineStart;
    const seedLine = seed.lineStart;
    if (seedLine === null || aLine === null || bLine === null) {
      return a - b;
    }
    return Math.abs(aLine - seedLine) - Math.abs(bLine - seedLine) || a - b;
  });
  appendCandidates(
    candidates,
    sameFile.slice(0, MAX_SAME_FILE_CANDIDATES),
    seedIndex,
    MAX_CONTEXT_CANDIDATES_PER_SEED,
  );

  for (const token of seed.tokens) {
    const matches = index.byToken.get(token);
    if (!matches || matches.length > MAX_TOKEN_FANOUT) continue;
    appendCandidates(
      candidates,
      matches,
      seedIndex,
      MAX_CONTEXT_CANDIDATES_PER_SEED,
    );
    if (candidates.size >= MAX_CONTEXT_CANDIDATES_PER_SEED) break;
  }

  return [...candidates];
}

function relativeImportMatches(
  importer: string,
  specifier: string,
  candidate: string,
): boolean {
  if (!specifier.startsWith(".")) return false;
  const importerDirectory = importer.split("/").slice(0, -1).join("/");
  return (
    modulePath(normalizePath(importerDirectory + "/" + specifier)) ===
    modulePath(candidate)
  );
}

function importMatches(
  importer: string,
  specifier: string,
  candidate: string,
): boolean {
  if (specifier.startsWith(".")) {
    return relativeImportMatches(importer, specifier, candidate);
  }
  const normalizedSpecifier = normalizePath(specifier);
  const normalizedCandidate = modulePath(candidate);
  return (
    normalizedCandidate === normalizedSpecifier ||
    normalizedCandidate.endsWith("/" + normalizedSpecifier)
  );
}

function related(
  seed: HunkMetadata,
  candidate: HunkMetadata,
): { reason: ConnectedCompanion["reason"]; score: number } | null {
  if (seed.file === candidate.file) {
    const distance =
      seed.lineStart === null || candidate.lineStart === null
        ? 1000
        : Math.abs(seed.lineStart - candidate.lineStart);
    return { reason: "same-file", score: 100_000 - distance };
  }
  if (
    [...seed.imports].some((value) =>
      importMatches(seed.file, value, candidate.file),
    )
  ) {
    return { reason: "import-relationship", score: 80_000 };
  }
  if (
    [...candidate.imports].some((value) =>
      importMatches(candidate.file, value, seed.file),
    )
  ) {
    return { reason: "import-relationship", score: 80_000 };
  }
  if (
    stem(seed.file) === stem(candidate.file) &&
    seed.isTest !== candidate.isTest
  ) {
    return { reason: "test-pair", score: 70_000 };
  }
  const shared = [...seed.tokens].filter((token) =>
    candidate.tokens.has(token),
  );
  if (shared.length >= 2) {
    return {
      reason: "shared-symbol",
      score: 40_000 + Math.min(shared.length, 10),
    };
  }
  return null;
}

export function buildConnectedContext(
  hunks: DiffHunk[],
): Map<number, ConnectedCompanion[]> {
  const index = buildIndex(hunks);
  const result = new Map<number, ConnectedCompanion[]>();
  let relationChecks = 0;

  for (let seedIndex = 0; seedIndex < hunks.length; seedIndex++) {
    if (relationChecks >= MAX_CONTEXT_RELATION_CHECKS) break;
    const companions: ConnectedCompanion[] = [];
    for (const candidateIndex of candidateIndexes(seedIndex, index)) {
      if (relationChecks >= MAX_CONTEXT_RELATION_CHECKS) break;
      relationChecks++;
      const relation = related(
        index.metadata[seedIndex],
        index.metadata[candidateIndex],
      );
      if (relation) {
        companions.push({ hunkIndex: candidateIndex, ...relation });
      }
    }
    companions.sort((a, b) => b.score - a.score || a.hunkIndex - b.hunkIndex);
    result.set(seedIndex, companions.slice(0, MAX_COMPANIONS));
  }
  return result;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return value;
  const markerBytes = Buffer.byteLength(CONTEXT_TRUNCATION_MARKER);
  const available = maxBytes - markerBytes;
  const headBudget = Math.ceil(available / 2);
  const tailBudget = Math.floor(available / 2);
  let headEnd = headBudget;
  while (headEnd > 0 && (bytes[headEnd] & 0xc0) === 0x80) headEnd--;
  let tailStart = bytes.length - tailBudget;
  while (tailStart < bytes.length && (bytes[tailStart] & 0xc0) === 0x80) {
    tailStart++;
  }
  return (
    bytes.subarray(0, headEnd).toString("utf8") +
    CONTEXT_TRUNCATION_MARKER +
    bytes.subarray(tailStart).toString("utf8")
  );
}

export function renderConnectedContext(
  seed: DiffHunk,
  companions: ConnectedCompanion[],
  hunks: DiffHunk[],
): string {
  let output = truncateUtf8(seed.text, MAX_CONTEXT_BYTES);
  for (const companion of companions) {
    const hunk = hunks[companion.hunkIndex];
    if (!hunk) continue;
    const block =
      "\n\n[connected context: " +
      companion.reason +
      "; file=" +
      hunk.file +
      "]\n" +
      hunk.text;
    if (Buffer.byteLength(output + block, "utf8") > MAX_CONTEXT_BYTES) break;
    output += block;
  }
  return output;
}
