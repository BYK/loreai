// ArkType JIT-compiles validators with `new Function`, which the UI's CSP
// (`script-src 'self'`, no 'unsafe-eval') forbids. `jitless` is the mode we
// would have to ship, so it is the mode we benchmark. Set BENCH_ARKTYPE_JIT=1
// to see the compiled numbers for reference.
import { configure } from "arktype/config";

configure({ jitless: process.env.BENCH_ARKTYPE_JIT !== "1" });

const { type } = await import("arktype");

// ArkType ignores undeclared keys by default (forward compatibility).
const epochMs = type("number.integer >= 0");
const nonNegInt = epochMs;

export const project = type({
  id: "string > 0",
  path: "string",
  name: "string | null",
  git_remote: "string | null",
  created_at: epochMs,
  knowledge_count: nonNegInt,
  session_count: nonNegInt,
  message_count: nonNegInt,
  distillation_count: nonNegInt,
});

const knowledgeFields = {
  id: "string > 0",
  "logical_id?": "string > 0",
  "project_id?": "string | null",
  category: "string",
  title: "string",
  content: "string",
  "source_session?": "string | null",
  "cross_project?": "boolean | number",
  confidence: "0 <= number <= 1",
  "created_at?": epochMs.or("null"),
  "updated_at?": epochMs.or("null"),
  "created_by?": "string | null",
  "updated_by?": "string | null",
  "sensitivity?": "string | null",
  "promotion_status?": "string | null",
  "approval_status?": "string | null",
  "last_accessed_at?": epochMs.or("null"),
  "last_reinforced_at?": epochMs.or("null"),
};

export const knowledgeEntry = type(knowledgeFields);

export const knowledgeVersion = type({
  ...knowledgeFields,
  "is_deleted?": "boolean",
  "version?": "number.integer",
});

export const sessionSummary = type({
  session_id: "string > 0",
  message_count: nonNegInt,
  first_message_at: epochMs,
  last_message_at: epochMs,
  distilled_count: nonNegInt,
  undistilled_count: nonNegInt,
  distillation_count: nonNegInt,
});

export const message = type({
  id: "string > 0",
  "source_id?": "string | null",
  project_id: "string",
  session_id: "string",
  role: "string",
  content: "string",
  tokens: nonNegInt,
  distilled: "number.integer",
  created_at: epochMs,
  metadata: "string | null",
});

const distillationFields = {
  id: "string > 0",
  session_id: "string",
  generation: "number.integer",
  token_count: "number.integer",
  r_compression: "number | null",
  c_norm: "number | null",
  archived: "number.integer",
  created_at: epochMs,
};

export const distillationSummary = type({
  ...distillationFields,
  call_type: "string | null",
});

export const distillationDetail = type({
  ...distillationFields,
  project_id: "string",
  observations: "string",
  source_ids: "string",
});

export const sessionDetail = type({
  messages: message.array(),
  distillations: distillationSummary.array(),
});

export const cursorPage = (item) =>
  type({ items: item.array(), next_cursor: "string | null" });

export const apiError = type({
  type: "'error'",
  error: { type: "string", message: "string" },
});

export const account = type({
  signed_in: "boolean",
  user: type({
    id: "string",
    email: "string | null",
    display_name: "string | null",
  }).or("null"),
  provider: "string | null",
  expires_at: "string | null",
  state: "'signed_in' | 'anonymous' | 'expired'",
});

export const teams = type({
  teams: type({
    id: "string",
    name: "string | null",
    role: "string",
    member_count: nonNegInt,
  }).array(),
});

export const sharing = type({
  linked: "boolean",
  team: type({ id: "string", name: "string | null" }).or("null"),
  policy: {
    effective: "'manual' | 'auto'",
    project_override: "'manual' | 'auto' | null",
    team_default: "'manual' | 'auto' | null",
  },
  state: "'not_linked' | 'linked' | 'locked' | 'degraded'",
  detail: "string | null",
});

export const syncStatus = type({
  enabled: "boolean",
  state: "'idle' | 'disabled'",
  pending_changes: "number.integer | null",
});

export const globalStats = type({
  project_count: "number.integer",
  knowledge_count: "number.integer",
  session_count: "number.integer",
  message_count: "number.integer",
  distillation_count: "number.integer",
  db_size_bytes: "number.integer",
});

export const projectList = project.array();
export const knowledgePage = cursorPage(knowledgeEntry);

export const name = "arktype";
export function parse(schema, data) {
  const r = schema(data);
  if (r instanceof type.errors) throw new Error("invalid");
  return r;
}
export function check(schema, data) {
  return !(schema(data) instanceof type.errors);
}
