// Deterministic synthetic payloads shaped like the gateway responses
// (packages/gateway/src/api.ts, api-lists.ts, folk-status.ts). Seeded PRNG so
// every library parses byte-identical input.

let seed = 0x2f6e2b1;
function rand() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function pick(items) {
  return items[Math.floor(rand() * items.length)];
}
function words(n) {
  const w = [
    "gateway",
    "distillation",
    "knowledge",
    "session",
    "cursor",
    "sqlite",
    "solid",
    "cache",
    "authority",
    "projection",
  ];
  const out = [];
  for (let i = 0; i < n; i++) out.push(pick(w));
  return out.join(" ");
}
function id(prefix, i) {
  return `${prefix}-019e18ec-${i.toString(16).padStart(8, "0")}-${Math.floor(rand() * 1e9).toString(16)}`;
}

const CATEGORIES = [
  "decision",
  "pattern",
  "preference",
  "architecture",
  "gotcha",
];
const BASE_TS = 1_789_000_000_000;

export function knowledgeEntry(i) {
  return {
    id: id("k", i),
    logical_id: id("k", i),
    project_id: "proj-1",
    category: pick(CATEGORIES),
    title: words(6),
    content: words(80),
    source_session: rand() > 0.3 ? id("s", i % 17) : null,
    cross_project: rand() > 0.9 ? 1 : 0,
    confidence: Math.round(rand() * 100) / 100,
    created_at: BASE_TS + i * 1000,
    updated_at: BASE_TS + i * 1000 + 500,
    created_by: rand() > 0.5 ? "curator" : null,
    updated_by: null,
    sensitivity: "normal",
    promotion_status: null,
    approval_status: null,
    last_accessed_at: null,
    last_reinforced_at: null,
    // forward-compat: fields the UI does not know yet
    embedding_model: "text-embedding-3-small",
    rank: i,
  };
}

export function knowledgePage(n = 200) {
  const items = [];
  for (let i = 0; i < n; i++) items.push(knowledgeEntry(i));
  return { items, next_cursor: n > 100 ? "eyJhZnRlciI6IjAxOWUxOGVjIn0" : null };
}

export function temporalMessage(i) {
  const role = i % 3 === 0 ? "user" : i % 3 === 1 ? "assistant" : "tool";
  return {
    id: id("m", i),
    source_id: null,
    project_id: "proj-1",
    session_id: "sess-1",
    role,
    content: words(role === "tool" ? 200 : 40),
    tokens: 40 + (i % 300),
    distilled: i % 2,
    created_at: BASE_TS + i * 2500,
    metadata: JSON.stringify({ model: "claude", stop: "end_turn" }),
  };
}

export function sessionDetail(n = 2000) {
  const messages = [];
  for (let i = 0; i < n; i++) messages.push(temporalMessage(i));
  const distillations = [];
  for (let i = 0; i < 12; i++) {
    distillations.push({
      id: id("d", i),
      session_id: "sess-1",
      generation: i % 3,
      token_count: 1200 + i,
      r_compression: 0.21,
      c_norm: null,
      archived: i < 6 ? 1 : 0,
      created_at: BASE_TS + i * 10_000,
      call_type: "observer",
    });
  }
  return { messages, distillations };
}

export function projectList(n = 12) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: id("p", i),
      path: `/home/dev/${words(1)}-${i}`,
      name: i % 4 === 0 ? null : words(2),
      git_remote: i % 2 ? "git@github.com:BYK/loreai.git" : null,
      created_at: BASE_TS - i * 86_400_000,
      knowledge_count: i * 7,
      session_count: i * 3,
      message_count: i * 400,
      distillation_count: i * 5,
    });
  }
  return out;
}

export const accountStatus = {
  signed_in: true,
  user: { id: "u-1", email: "dev@example.com", display_name: "Dev" },
  provider: "github",
  expires_at: "2026-09-19T12:00:00.000Z",
  state: "signed_in",
};

export const sharingStatus = {
  linked: true,
  team: { id: "t-1", name: "Core" },
  policy: {
    effective: "manual",
    project_override: null,
    team_default: "manual",
  },
  state: "linked",
  detail: null,
};
