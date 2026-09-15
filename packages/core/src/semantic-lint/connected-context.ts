/** Deterministic, bounded companion-context retrieval for large semantic-lint PRs. */
import type { DiffHunk } from "./check";

export interface ConnectedCompanion {
  hunkIndex: number;
  reason: "same-file" | "shared-symbol" | "import-relationship" | "test-pair";
  score: number;
}

const MAX_COMPANIONS = 3;
const MAX_CONTEXT_BYTES = 12 * 1024;
const TOKEN_RE = /\b[A-Za-z_$][\w$]{2,}\b/g;
const IMPORT_RE = /(?:from|import|require\s*\()\s*[\'\"]([^\'\"]+)[\'\"]/g;
const TEST_RE = /(?:^|[./_-])(test|spec|tests?)(?:[./_-]|$)/i;

function tokens(hunk: DiffHunk): Set<string> {
  return new Set(hunk.text.match(TOKEN_RE) ?? []);
}

function imports(hunk: DiffHunk): Set<string> {
  const result = new Set<string>();
  for (const match of hunk.text.matchAll(IMPORT_RE)) {
    if (match[1]) result.add(match[1]);
  }
  return result;
}

function basename(file: string): string {
  return file.split("/").pop() ?? file;
}

function stem(file: string): string {
  return basename(file)
    .replace(/\.(tsx?|jsx?|mjs|cjs|py|rs|go|java)$/i, "")
    .replace(/\.(test|spec)$/i, "");
}

function related(
  seed: DiffHunk,
  candidate: DiffHunk,
): { reason: ConnectedCompanion["reason"]; score: number } | null {
  if (seed.file === candidate.file) return { reason: "same-file", score: 100 };
  const seedTokens = tokens(seed);
  const candidateTokens = tokens(candidate);
  const shared = [...seedTokens].filter((token) => candidateTokens.has(token));
  const seedImports = imports(seed);
  const candidateImports = imports(candidate);
  if ([...seedImports].some(
    (value) =>
      candidate.file.includes(value) ||
      value.endsWith("/" + basename(candidate.file)),
  ))
    return { reason: "import-relationship", score: 80 };
  if ([...candidateImports].some(
    (value) =>
      seed.file.includes(value) ||
      value.endsWith("/" + basename(seed.file)),
  ))
    return { reason: "import-relationship", score: 80 };
  if (shared.length >= 2) {
    return {
      reason: "shared-symbol",
      score: 40 + Math.min(shared.length, 10),
    };
  }
  if (
    stem(seed.file) === stem(candidate.file) &&
    TEST_RE.test(seed.file) !== TEST_RE.test(candidate.file)
  )
    return { reason: "test-pair", score: 70 };
  return null;
}

export function buildConnectedContext(
  hunks: DiffHunk[],
): Map<number, ConnectedCompanion[]> {
  const result = new Map<number, ConnectedCompanion[]>();
  for (let seedIndex = 0; seedIndex < hunks.length; seedIndex++) {
    const companions: ConnectedCompanion[] = [];
    for (let candidateIndex = 0; candidateIndex < hunks.length; candidateIndex++) {
      if (seedIndex === candidateIndex) continue;
      const match = related(hunks[seedIndex], hunks[candidateIndex]);
      if (match) companions.push({ hunkIndex: candidateIndex, ...match });
    }
    companions.sort((a, b) => b.score - a.score || a.hunkIndex - b.hunkIndex);
    result.set(seedIndex, companions.slice(0, MAX_COMPANIONS));
  }
  return result;
}

export function renderConnectedContext(
  seed: DiffHunk,
  companions: ConnectedCompanion[],
  hunks: DiffHunk[],
): string {
  let output = seed.text;
  for (const companion of companions) {
    const hunk = hunks[companion.hunkIndex];
    if (!hunk) continue;
    const block = '\n\n[connected context: ' + companion.reason + '; file=' + hunk.file + ']\n' + hunk.text;
    if (Buffer.byteLength(output + block, "utf8") > MAX_CONTEXT_BYTES) break;
    output += block;
  }
  return output;
}
