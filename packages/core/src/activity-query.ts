export const ACTIVITY_KINDS = [
  "session",
  "knowledge",
  "contradiction",
  "promotion",
] as const;

export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export const PARTICIPANTS = [
  { id: "user", kind: "user", label: "You" },
  { id: "claude-code", kind: "agent", label: "Claude Code" },
  { id: "codex", kind: "agent", label: "Codex" },
  { id: "opencode", kind: "agent", label: "OpenCode" },
  { id: "pi", kind: "agent", label: "Pi" },
  { id: "lore", kind: "lore", label: "Lore" },
  { id: "curator", kind: "lore", label: "Curator" },
  { id: "pattern", kind: "lore", label: "Pattern" },
  { id: "import", kind: "lore", label: "Import" },
] as const;

export type ActivityParticipant = (typeof PARTICIPANTS)[number];
export type ActivityClientFolderFilter = "inbox" | "archive";
export type ActivityClientStateFilter = "unread" | "read" | "pinned";

export type ParsedActivityQuery = {
  server: {
    types: ActivityKind[] | null;
    projects: string[];
    with: ActivityParticipant["id"][];
    before: number | null;
    after: number | null;
    terms: string[];
  };
  client: {
    in: ActivityClientFolderFilter[];
    folders: string[];
    is: ActivityClientStateFilter[];
  };
  errors: {
    token: string;
    start: number;
    end: number;
    message: string;
  }[];
};

export const DEFAULT_ACTIVITY_QUERY = "in:inbox";

type Token = {
  raw: string;
  value: string;
  start: number;
  end: number;
  unterminated: boolean;
  quoted: boolean;
};

function tokenize(query: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < query.length) {
    while (index < query.length && /\s/.test(query[index])) index++;
    if (index >= query.length) break;

    const start = index;
    let value = "";
    let quoted = false;
    let inQuote = false;
    while (index < query.length) {
      const char = query[index];
      if (char === '"') {
        quoted = true;
        inQuote = !inQuote;
        index++;
        continue;
      }
      if (!inQuote && /\s/.test(char)) break;
      value += char;
      index++;
    }
    const end = index;
    tokens.push({
      raw: query.slice(start, end),
      value,
      start,
      end,
      unterminated: inQuote,
      quoted,
    });
  }
  return tokens;
}

function validDate(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date.getTime();
}

function uniquePush<T>(values: T[], value: T): void {
  if (!values.includes(value)) values.push(value);
}

export function parseActivityQuery(query: string): ParsedActivityQuery {
  const parsed: ParsedActivityQuery = {
    server: {
      types: null,
      projects: [],
      with: [],
      before: null,
      after: null,
      terms: [],
    },
    client: { in: [], folders: [], is: [] },
    errors: [],
  };

  const addError = (token: Token, message: string) => {
    parsed.errors.push({
      token: token.raw,
      start: token.start,
      end: token.end,
      message,
    });
  };

  for (const token of tokenize(query)) {
    if (token.unterminated) {
      addError(token, "Unterminated quote");
      continue;
    }
    if (/^[a-z]+:/i.test(token.raw)) {
      const separator = token.value.indexOf(":");
      const key = token.value.slice(0, separator).toLowerCase();
      const value = token.value.slice(separator + 1);
      if (!value) {
        addError(token, `Filter ${key}: requires a value`);
        continue;
      }

      switch (key) {
        case "type": {
          const requested = new Set<ActivityKind>();
          for (const rawKind of value.split(",")) {
            const kind = rawKind.trim();
            if (!kind) {
              addError(token, "type: contains an empty activity kind");
            } else if ((ACTIVITY_KINDS as readonly string[]).includes(kind)) {
              requested.add(kind as ActivityKind);
            } else {
              addError(
                token,
                `Unknown activity kind ${kind}; valid kinds: ${ACTIVITY_KINDS.join(", ")}`,
              );
            }
          }
          const current = parsed.server.types;
          parsed.server.types = ACTIVITY_KINDS.filter((kind) =>
            current === null
              ? requested.has(kind)
              : current.includes(kind) && requested.has(kind),
          );
          break;
        }
        case "project":
          parsed.server.projects.push(value);
          break;
        case "with": {
          const participantValue = value.toLowerCase();
          const participantId =
            participantValue === "you"
              ? "user"
              : PARTICIPANTS.find(
                  (participant) =>
                    participant.id.toLowerCase() === participantValue ||
                    participant.label.toLowerCase() === participantValue,
                )?.id;
          if (!participantId) {
            addError(token, `Unknown participant ${value}`);
          } else {
            parsed.server.with.push(participantId);
          }
          break;
        }
        case "before":
        case "after": {
          const timestamp = validDate(value);
          if (timestamp === null) {
            addError(token, `Invalid calendar date for ${key}: ${value}`);
          } else if (key === "before") {
            parsed.server.before =
              parsed.server.before === null
                ? timestamp
                : Math.min(parsed.server.before, timestamp);
          } else {
            parsed.server.after =
              parsed.server.after === null
                ? timestamp
                : Math.max(parsed.server.after, timestamp);
          }
          break;
        }
        case "in": {
          const normalized = value.toLowerCase();
          if (normalized === "inbox" || normalized === "archive") {
            uniquePush(parsed.client.in, normalized);
          } else if (normalized.startsWith("folder:")) {
            const folder = value.slice("folder:".length);
            if (!folder) {
              addError(token, "in:folder: requires a folder name");
            } else {
              uniquePush(parsed.client.folders, folder);
            }
          } else {
            addError(token, `Unknown in: filter ${value}`);
          }
          break;
        }
        case "is": {
          const state = value.toLowerCase();
          if (state === "unread" || state === "read" || state === "pinned") {
            uniquePush(parsed.client.is, state);
          } else {
            addError(token, `Unknown is: filter ${value}`);
          }
          break;
        }
        default:
          addError(token, `Unknown filter ${key}:`);
      }
      continue;
    }

    if (!token.value) {
      if (token.quoted) addError(token, "Search term cannot be empty");
      continue;
    }
    parsed.server.terms.push(token.value);
  }

  return parsed;
}
