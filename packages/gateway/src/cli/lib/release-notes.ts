/** Best-effort upgrade notes. Remote text is bounded and rendered as plain terminal text. */
import { stripVTControlCharacters } from "node:util";
import { gt, lte, valid } from "semver";
import {
  getGitHubHeaders,
  GITHUB_RELEASES_URL,
  isNightlyVersion,
} from "./binary";
import type { ReleaseChannel } from "./upgrade";

const REPO = "https://github.com/BYK/loreai";
const API = GITHUB_RELEASES_URL.replace(/\/releases$/, "");
const MAX_PAGES = 3;
const MAX_ITEMS = 15;
const MAX_BODY_BYTES = 2_000_000;
const MAX_RAW_TITLE = 4096;
const DEADLINE_MS = 2500;
const CATEGORIES = ["Features", "Fixes", "Performance"] as const;
type Category = (typeof CATEGORIES)[number];
type Entry = { category: Category; title: string };
export interface ReleaseNotes {
  fromVersion: string;
  toVersion: string;
  entries: Entry[];
  url: string;
}
interface NotesOptions {
  channel: ReleaseChannel;
  fromVersion: string;
  toVersion: string;
}
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function plain(value: string): string {
  return stripVTControlCharacters(value.slice(0, MAX_RAW_TITLE))
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/\[([^[\]]+)\]\([^()[\]]*\)/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function add(notes: ReleaseNotes, category: Category, raw: string): void {
  if (notes.entries.length >= MAX_ITEMS) return;
  const title = Array.from(plain(raw)).slice(0, 240).join("");
  if (!title) return;
  if (
    !notes.entries.some(
      (entry) => entry.category === category && entry.title === title,
    )
  )
    notes.entries.push({ category, title });
}

function stableEntries(notes: ReleaseNotes, body: string): void {
  if (notes.entries.length >= MAX_ITEMS) return;
  let category: Category | undefined;
  let fence: string | undefined;
  for (const line of body.split(/\r?\n/)) {
    if (notes.entries.length >= MAX_ITEMS) return;
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length)
        fence = undefined;
      continue;
    }
    if (fence) continue;
    const heading = /^\s{0,3}(#{1,6})\s+(.+)/.exec(line);
    if (heading) {
      if (heading[1].length <= 3) {
        const name = plain(heading[2]).toLowerCase();
        category = /^(new features|features)\b/.test(name)
          ? "Features"
          : /^(bug fixes|fixes)\b/.test(name)
            ? "Fixes"
            : /^performance\b/.test(name)
              ? "Performance"
              : undefined;
      }
      continue;
    }
    const item = /^[-*+]\s+(.+)/.exec(line);
    if (category && item) {
      const raw = item[1].slice(0, MAX_RAW_TITLE);
      const author = raw.lastIndexOf(" by @");
      const suffix =
        author >= 0
          ? /^ by @\S+ in (\[?#\d+\]?(?:\([^)]*\))?)\s*$/.exec(
              raw.slice(author),
            )
          : null;
      const title = suffix ? `${raw.slice(0, author)} (${suffix[1]})` : raw;
      add(notes, category, title);
    }
  }
}

async function json(path: string, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const response = await fetch(`${API}${path}`, {
    headers: getGitHubHeaders(),
    signal,
    redirect: "error",
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("Release notes unavailable");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES)
        throw new Error("Release notes response too large");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function stableNotes(
  notes: ReleaseNotes,
  signal: AbortSignal,
): Promise<void> {
  const releases: { version: string; body: string }[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await json(`/releases?per_page=100&page=${page}`, signal);
    if (!Array.isArray(data)) throw new Error("Invalid release list");
    for (const release of data) {
      if (
        !object(release) ||
        release.draft !== false ||
        release.prerelease !== false ||
        typeof release.tag_name !== "string" ||
        typeof release.body !== "string"
      )
        continue;
      const version = valid(release.tag_name);
      if (
        version &&
        gt(version, notes.fromVersion) &&
        lte(version, notes.toVersion)
      )
        releases.push({ version, body: release.body });
    }
    if (data.length < 100) break;
  }
  releases.sort((a, b) =>
    gt(a.version, b.version) ? -1 : gt(b.version, a.version) ? 1 : 0,
  );
  for (const release of releases) {
    if (notes.entries.length >= MAX_ITEMS) break;
    stableEntries(notes, release.body);
  }
}

/** Resolve timestamped nightlies to real commits before comparing; never invent git tags. */
async function revision(version: string, signal: AbortSignal): Promise<string> {
  const timestamp = /^\d+\.\d+\.\d+-dev\.(\d+)$/.exec(version)?.[1];
  let data: unknown;
  if (timestamp) {
    const seconds = Number(timestamp);
    // GitHub includes commits at the cutoff; adding a second can select
    // a different commit and reject a valid published nightly.
    const until = new Date(seconds * 1000).toISOString();
    const commits = await json(
      `/commits?sha=main&until=${encodeURIComponent(until)}&per_page=2`,
      signal,
    );
    if (!Array.isArray(commits) || commits.length > 2)
      throw new Error("Invalid nightly commit list");
    const matches = commits.filter((candidate) => {
      const commit =
        object(candidate) && object(candidate.commit)
          ? candidate.commit
          : undefined;
      const date =
        commit && object(commit.committer) ? commit.committer.date : undefined;
      return typeof date === "string" && Date.parse(date) === seconds * 1000;
    });
    // Versions encode seconds, not SHAs. Same-second commits cannot be
    // distinguished reliably, so offer a link rather than guess the range.
    if (matches.length !== 1 || commits[0] !== matches[0])
      throw new Error("Nightly commit cannot be identified uniquely");
    data = matches[0];
  } else {
    data = await json(
      `/commits/${encodeURIComponent(version.replace(/^v/, ""))}`,
      signal,
    );
  }
  if (
    !object(data) ||
    typeof data.sha !== "string" ||
    !/^[a-f0-9]{40}$/.test(data.sha)
  )
    throw new Error("Invalid release commit");
  return data.sha;
}

async function nightlyNotes(
  notes: ReleaseNotes,
  signal: AbortSignal,
): Promise<void> {
  const [from, to] = await Promise.all([
    revision(notes.fromVersion, signal),
    revision(notes.toVersion, signal),
  ]);
  notes.url = `${REPO}/compare/${from}...${to}`;
  const readPage = async (page: number) => {
    const data = await json(
      `/compare/${from}...${to}?per_page=100&page=${page}`,
      signal,
    );
    if (
      !object(data) ||
      data.status !== "ahead" ||
      !Array.isArray(data.commits) ||
      data.commits.length > 100 ||
      typeof data.total_commits !== "number" ||
      !Number.isSafeInteger(data.total_commits) ||
      data.total_commits < 0
    )
      throw new Error("Invalid release comparison");
    return { commits: data.commits as unknown[], total: data.total_commits };
  };
  // Comparisons are chronological. Start from the end so the bounded summary
  // includes the latest fixes, even when an upgrade crosses hundreds of commits.
  const first = await readPage(1);
  let requests = 1;
  for (
    let page = Math.max(1, Math.ceil(first.total / 100));
    page >= 1;
    page--
  ) {
    if (page !== 1 && requests >= MAX_PAGES) break;
    const data = page === 1 ? first : await readPage(page);
    if (page !== 1) requests++;
    if (data.total !== first.total)
      throw new Error("Inconsistent release comparison");
    for (const item of data.commits.toReversed()) {
      const message =
        object(item) && object(item.commit) ? item.commit.message : undefined;
      if (typeof message !== "string" || message.includes("#skip-changelog"))
        continue;
      const title = message.split(/\r?\n/, 1)[0];
      const match = /^(feat|fix|perf)(?:\([^)]*\))?!?:\s*(.+)/.exec(title);
      if (match)
        add(
          notes,
          match[1] === "feat"
            ? "Features"
            : match[1] === "fix"
              ? "Fixes"
              : "Performance",
          match[2],
        );
    }
    if (notes.entries.length >= MAX_ITEMS) break;
  }
}

/** Notes never affect upgrade success, including when an HTTP client ignores abort. */
export async function fetchReleaseNotes(
  options: NotesOptions,
): Promise<ReleaseNotes | null> {
  const { channel, fromVersion, toVersion } = options;
  if (!valid(fromVersion) || !valid(toVersion) || !gt(toVersion, fromVersion))
    return null;
  const fallback: ReleaseNotes = {
    fromVersion,
    toVersion,
    entries: [],
    url:
      channel === "stable" && !isNightlyVersion(toVersion)
        ? `${REPO}/releases/tag/${encodeURIComponent(toVersion)}`
        : `${REPO}/commits/main`,
  };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ReleaseNotes>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(fallback);
    }, DEADLINE_MS);
  });
  const notes = { ...fallback, entries: [] };
  const work = (
    channel === "stable" &&
    !isNightlyVersion(fromVersion) &&
    !isNightlyVersion(toVersion)
      ? stableNotes(notes, controller.signal)
      : nightlyNotes(notes, controller.signal)
  )
    .then(() => notes)
    .catch(() => fallback);
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export function formatReleaseNotes(notes: ReleaseNotes): string {
  if (!notes.entries.length) return `[lore] Release notes: ${notes.url}`;
  const lines = [
    `[lore] What's new (${plain(notes.fromVersion)} -> ${plain(notes.toVersion)}):`,
  ];
  for (const category of CATEGORIES) {
    const entries = notes.entries.filter(
      (entry) => entry.category === category,
    );
    if (entries.length)
      lines.push(
        `  ${category}`,
        ...entries.map((entry) => `    - ${entry.title}`),
      );
  }
  lines.push(`[lore] Full changes: ${notes.url}`);
  return lines.join("\n");
}
