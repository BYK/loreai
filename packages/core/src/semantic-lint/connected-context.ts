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
const TEST_RE = /(?:^|[./_-])(test|spec|tests?)(?:[./_-]|$)/i;
const TEST_PAIR_ROOTS = new Set([
  "app",
  "lib",
  "src",
  "spec",
  "specs",
  "test",
  "tests",
  "__tests__",
]);
const CONTEXT_TRUNCATION_MARKER = "\n... [seed hunk truncated by Lore] ...\n";
const CONTEXT_OMISSION_MARKER =
  "\n[connected context: companion hunks omitted by size bound]\n";

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
  "array",
  "client",
  "describe",
  "expect",
  "it",
  "logger",
  "manager",
  "number",
  "mock",
  "object",
  "promise",
  "record",
  "server",
  "service",
  "setup",
  "status",
  "test",
  "url",
]);

interface HunkMetadata {
  file: string;
  oldFile?: string;
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
  byTestStem: Map<string, number[]>;
  bySourceStem: Map<string, number[]>;
  sameFileNeighbors: Map<number, number[]>;
}

function diffLines(hunk: DiffHunk, prefix: "+" | "-" | "result"): string {
  return hunk.text
    .split("\n")
    .filter((line) => {
      if (prefix === "+")
        return line.startsWith("+") && !line.startsWith("+++");
      if (prefix === "-")
        return line.startsWith("-") && !line.startsWith("---");
      return (
        line.startsWith(" ") ||
        (line.startsWith("+") && !line.startsWith("+++"))
      );
    })
    .map((line) => line.slice(1))
    .join("\n");
}

function currentLines(hunk: DiffHunk): string {
  return diffLines(hunk, "result");
}

function oldLines(hunk: DiffHunk): string {
  return diffLines(hunk, "-") + "\n" + diffLines(hunk, "result");
}

function hasAddedLines(hunk: DiffHunk): boolean {
  return diffLines(hunk, "+").trim().length > 0;
}

function usesOldSide(hunk: DiffHunk): boolean {
  return hunk.deleted === true || hunk.oldFile !== undefined;
}

interface StringLiteral {
  start: number;
  end: number;
  value: string;
}

interface LexedSource {
  masked: string;
  strings: StringLiteral[];
}

function lexSource(value: string): LexedSource {
  let output = "";
  const strings: StringLiteral[] = [];
  let quote: "'" | '"' | "`" | null = null;
  let blockComment = false;
  let stringStart = -1;
  let stringValue = "";
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    const next = value[i + 1];
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        output += "  ";
        i++;
      } else if (char === "\n") {
        output += "\n";
      } else {
        output += " ";
      }
      continue;
    }
    if (quote) {
      if (char === "\n") output += "\n";
      else output += " ";
      if (char === "\\" && next !== undefined) {
        if (next === "\n") output += "\n";
        else output += " ";
        if (quote !== "`") stringValue += next;
        i++;
      } else if (char === quote) {
        if (quote !== "`") {
          strings.push({
            start: stringStart,
            end: i + 1,
            value: stringValue,
          });
        }
        quote = null;
        stringStart = -1;
        stringValue = "";
      } else if (quote !== "`") {
        stringValue += char;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "\x60") {
      quote = char;
      stringStart = i;
      stringValue = "";
      output += " ";
    } else if (char === "/" && next === "/") {
      output += "  ";
      i++;
      while (i < value.length && value[i] !== "\n") {
        output += " ";
        i++;
      }
      if (value[i] === "\n") output += "\n";
    } else if (char === "/" && next === "*") {
      blockComment = true;
      output += "  ";
      i++;
    } else {
      output += char;
    }
  }
  return { masked: output, strings };
}

function codeText(value: string): string {
  return lexSource(value).masked;
}

function firstStringAfter(
  strings: StringLiteral[],
  start: number,
  end: number,
): StringLiteral | undefined {
  return strings.find(
    (literal) => literal.start >= start && literal.end <= end,
  );
}

function extractImports(value: string): Set<string> {
  const { masked, strings } = lexSource(value);
  const result = new Set<string>();
  const scanLimit = (start: number): number => {
    const semicolon = masked.indexOf(";", start);
    return semicolon >= 0
      ? Math.min(semicolon, start + 4_096)
      : Math.min(masked.length, start + 4_096);
  };

  for (const match of masked.matchAll(/(?:^|[;\n])\s*import\b/gm)) {
    const keyword = match.index + match[0].lastIndexOf("import");
    const end = scanLimit(keyword + "import".length);
    const from = /\bfrom\b/.exec(masked.slice(keyword + "import".length, end));
    const literal = firstStringAfter(
      strings,
      from
        ? keyword + "import".length + from.index + from[0].length
        : keyword + "import".length,
      end + 1,
    );
    if (literal) result.add(literal.value);
  }

  for (const match of masked.matchAll(/(?:^|[;\n])\s*export\b/gm)) {
    const keyword = match.index + match[0].lastIndexOf("export");
    const end = scanLimit(keyword + "export".length);
    const from = /\bfrom\b/.exec(masked.slice(keyword + "export".length, end));
    if (!from) continue;
    const literal = firstStringAfter(
      strings,
      keyword + "export".length + from.index + from[0].length,
      end + 1,
    );
    if (literal) result.add(literal.value);
  }

  for (const match of masked.matchAll(/\brequire\s*\(/g)) {
    const end = scanLimit(match.index + match[0].length);
    const literal = firstStringAfter(
      strings,
      match.index + match[0].length,
      end + 1,
    );
    if (literal) result.add(literal.value);
  }
  return result;
}

function tokens(hunk: DiffHunk): Set<string> {
  const result = new Set<string>();
  const current = currentLines(hunk);
  const source =
    !usesOldSide(hunk) || hasAddedLines(hunk)
      ? codeText(current)
      : codeText(oldLines(hunk));
  for (const token of source.match(TOKEN_RE) ?? []) {
    if (!IGNORED_TOKENS.has(token.toLowerCase())) result.add(token);
  }
  return result;
}

function imports(hunk: DiffHunk): Set<string> {
  const current = currentLines(hunk);
  const source =
    !usesOldSide(hunk) || hasAddedLines(hunk) ? current : oldLines(hunk);
  return extractImports(source);
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

function isTestPath(file: string): boolean {
  return TEST_RE.test(file);
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
    ...(hunk.oldFile && hunk.oldFile !== hunk.file
      ? { oldFile: hunk.oldFile }
      : {}),
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

function importTargetFromPath(importer: string, specifier: string): string {
  if (!specifier.startsWith(".")) return modulePath(specifier);
  const directory = importer.split("/").slice(0, -1).join("/");
  return modulePath(normalizePath(directory + "/" + specifier));
}

function filePaths(hunk: HunkMetadata): string[] {
  return hunk.oldFile ? [hunk.file, hunk.oldFile] : [hunk.file];
}

function buildIndex(hunks: DiffHunk[]): HunkIndex {
  const metadataList = hunks.map(metadata);
  const index: HunkIndex = {
    metadata: metadataList,
    byFile: new Map(),
    byModule: new Map(),
    byToken: new Map(),
    byImportTarget: new Map(),
    byTestStem: new Map(),
    bySourceStem: new Map(),
    sameFileNeighbors: new Map(),
  };

  for (let i = 0; i < metadataList.length; i++) {
    const item = metadataList[i];
    for (const file of filePaths(item)) {
      addIndex(index.byFile, file, i);
      for (const key of moduleLookupKeys(modulePath(file))) {
        addIndex(index.byModule, key, i);
      }
      const stemIndex = isTestPath(file)
        ? index.byTestStem
        : index.bySourceStem;
      addIndex(stemIndex, stem(file), i);
    }
    for (const token of item.tokens) {
      addIndex(index.byToken, token, i);
    }
    for (const specifier of item.imports) {
      for (const file of filePaths(item)) {
        addIndex(
          index.byImportTarget,
          importTargetFromPath(file, specifier),
          i,
        );
      }
    }
  }

  for (const fileIndices of index.byFile.values()) {
    const ordered = [...fileIndices].sort((a, b) => {
      const aLine = index.metadata[a].lineStart;
      const bLine = index.metadata[b].lineStart;
      if (aLine === null || bLine === null) return a - b;
      return aLine - bLine || a - b;
    });
    const positions = new Map(
      ordered.map((value, position) => [value, position]),
    );
    for (const seedIndex of ordered) {
      const position = positions.get(seedIndex) ?? 0;
      const nearby = ordered.slice(
        Math.max(0, position - MAX_SAME_FILE_CANDIDATES),
        Math.min(ordered.length, position + MAX_SAME_FILE_CANDIDATES + 1),
      );
      nearby.sort((a, b) => {
        const seedLine = index.metadata[seedIndex].lineStart;
        const aLine = index.metadata[a].lineStart;
        const bLine = index.metadata[b].lineStart;
        if (seedLine === null || aLine === null || bLine === null) {
          return a - b;
        }
        return Math.abs(aLine - seedLine) - Math.abs(bLine - seedLine) || a - b;
      });
      const merged = [
        ...(index.sameFileNeighbors.get(seedIndex) ?? []),
        ...nearby.filter((candidate) => candidate !== seedIndex),
      ];
      const unique = [...new Set(merged)];
      unique.sort((a, b) => {
        const seedLine = index.metadata[seedIndex].lineStart;
        const aLine = index.metadata[a].lineStart;
        const bLine = index.metadata[b].lineStart;
        if (seedLine === null || aLine === null || bLine === null) {
          return a - b;
        }
        return Math.abs(aLine - seedLine) - Math.abs(bLine - seedLine) || a - b;
      });
      index.sameFileNeighbors.set(
        seedIndex,
        unique.slice(0, MAX_SAME_FILE_CANDIDATES),
      );
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
    for (const importer of filePaths(seed)) {
      for (const key of moduleLookupKeys(
        importTargetFromPath(importer, specifier),
      )) {
        appendCandidates(
          direct,
          index.byModule.get(key),
          seedIndex,
          MAX_DIRECT_CANDIDATES,
        );
      }
    }
  }
  for (const importer of filePaths(seed)) {
    for (const key of moduleLookupKeys(modulePath(importer))) {
      appendCandidates(
        direct,
        index.byImportTarget.get(key),
        seedIndex,
        MAX_DIRECT_CANDIDATES,
      );
    }
  }
  appendCandidates(
    candidates,
    [...direct],
    seedIndex,
    MAX_CONTEXT_CANDIDATES_PER_SEED,
  );
  appendCandidates(
    candidates,
    index.sameFileNeighbors.get(seedIndex),
    seedIndex,
    MAX_CONTEXT_CANDIDATES_PER_SEED,
  );
  for (const seedFile of filePaths(seed)) {
    appendCandidates(
      candidates,
      isTestPath(seedFile)
        ? index.bySourceStem.get(stem(seedFile))
        : index.byTestStem.get(stem(seedFile)),
      seedIndex,
      MAX_CONTEXT_CANDIDATES_PER_SEED,
    );
  }

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
  return normalizedCandidate === normalizedSpecifier;
}

function testPairPathCompatible(source: string, test: string): boolean {
  const sourceParts = source.split("/").slice(0, -1);
  const testParts = test.split("/").slice(0, -1);
  if (sourceParts.join("/") === testParts.join("/")) return true;
  let common = 0;
  while (
    common < sourceParts.length &&
    common < testParts.length &&
    sourceParts[common] === testParts[common]
  ) {
    common++;
  }
  if (common >= 2) return true;
  return (
    common === 0 &&
    TEST_PAIR_ROOTS.has(sourceParts[0] ?? "") &&
    TEST_PAIR_ROOTS.has(testParts[0] ?? "")
  );
}

function isTestPair(seed: HunkMetadata, candidate: HunkMetadata): boolean {
  for (const seedFile of filePaths(seed)) {
    for (const candidateFile of filePaths(candidate)) {
      const seedIsTest = isTestPath(seedFile);
      const candidateIsTest = isTestPath(candidateFile);
      if (
        seedIsTest !== candidateIsTest &&
        stem(seedFile) === stem(candidateFile) &&
        testPairPathCompatible(
          seedIsTest ? candidateFile : seedFile,
          seedIsTest ? seedFile : candidateFile,
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function related(
  seed: HunkMetadata,
  candidate: HunkMetadata,
): { reason: ConnectedCompanion["reason"]; score: number } | null {
  if (filePaths(seed).some((file) => filePaths(candidate).includes(file))) {
    const distance =
      seed.lineStart === null || candidate.lineStart === null
        ? 1000
        : Math.abs(seed.lineStart - candidate.lineStart);
    return { reason: "same-file", score: 100_000 - distance };
  }
  if (
    filePaths(seed).some((importer) =>
      [...seed.imports].some((value) =>
        filePaths(candidate).some((candidateFile) =>
          importMatches(importer, value, candidateFile),
        ),
      ),
    )
  ) {
    return { reason: "import-relationship", score: 80_000 };
  }
  if (
    filePaths(candidate).some((importer) =>
      [...candidate.imports].some((value) =>
        filePaths(seed).some((seedFile) =>
          importMatches(importer, value, seedFile),
        ),
      ),
    )
  ) {
    return { reason: "import-relationship", score: 80_000 };
  }
  if (isTestPair(seed, candidate)) {
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
  signal?: AbortSignal,
): Map<number, ConnectedCompanion[]> {
  const index = buildIndex(hunks);
  const result = new Map<number, ConnectedCompanion[]>();
  let relationChecks = 0;

  for (let seedIndex = 0; seedIndex < hunks.length; seedIndex++) {
    signal?.throwIfAborted();
    if (relationChecks >= MAX_CONTEXT_RELATION_CHECKS) break;
    const companions: ConnectedCompanion[] = [];
    for (const candidateIndex of candidateIndexes(seedIndex, index)) {
      signal?.throwIfAborted();
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

export interface RenderedConnectedContext {
  text: string;
  truncated: boolean;
  omittedCompanions: number;
}

export function renderConnectedContextDetails(
  seed: DiffHunk,
  companions: ConnectedCompanion[],
  hunks: DiffHunk[],
): RenderedConnectedContext {
  const seedBytes = Buffer.byteLength(seed.text, "utf8");
  let output = truncateUtf8(seed.text, MAX_CONTEXT_BYTES);
  let omittedCompanions = 0;
  for (const companion of companions) {
    const hunk = hunks[companion.hunkIndex];
    if (!hunk) {
      omittedCompanions++;
      continue;
    }
    const block =
      "\n\n[connected context: " +
      companion.reason +
      "; file=" +
      hunk.file +
      "]\n" +
      hunk.text;
    if (Buffer.byteLength(output + block, "utf8") > MAX_CONTEXT_BYTES) {
      omittedCompanions++;
      continue;
    }
    output += block;
  }
  if (omittedCompanions > 0) {
    const marker =
      CONTEXT_OMISSION_MARKER.slice(0, -1) + ` (${omittedCompanions})\n`;
    if (Buffer.byteLength(output + marker, "utf8") <= MAX_CONTEXT_BYTES) {
      output += marker;
    }
  }
  return {
    text: output,
    // A complete hunk may exceed the connected-context rendering bound and is
    // still usable for isolated judging. Only parser-level truncation means
    // that the diff evidence itself is incomplete and must fail closed.
    truncated: seed.text.includes("hunk truncated by Lore"),
    omittedCompanions,
  };
}

export function renderConnectedContext(
  seed: DiffHunk,
  companions: ConnectedCompanion[],
  hunks: DiffHunk[],
): string {
  return renderConnectedContextDetails(seed, companions, hunks).text;
}
