// Same schemas via `zod/mini` (functional, tree-shakeable API).
import * as z from "zod/mini";

// The UI ships under `script-src 'self'` (no unsafe-eval), so Zod's
// `new Function` object fast path is unavailable there; measure the same code
// path the browser will run.
z.config({ jitless: true });

const int = () => z.int();
const nonNeg = () => z.int().check(z.nonnegative());
const epochMs = nonNeg();
const str = () => z.string();
const nonEmpty = () => z.string().check(z.minLength(1));
const nullable = (s) => z.nullable(s);
const nullableOptional = (s) => z.optional(z.nullable(s));
const obj = (shape) => z.looseObject(shape);

export const project = obj({
  id: nonEmpty(),
  path: str(),
  name: nullable(str()),
  git_remote: nullable(str()),
  created_at: epochMs,
  knowledge_count: nonNeg(),
  session_count: nonNeg(),
  message_count: nonNeg(),
  distillation_count: nonNeg(),
});

const knowledgeShape = {
  id: nonEmpty(),
  logical_id: z.optional(nonEmpty()),
  project_id: nullableOptional(str()),
  category: str(),
  title: str(),
  content: str(),
  source_session: nullableOptional(str()),
  cross_project: z.optional(z.union([z.boolean(), z.number()])),
  confidence: z.number().check(z.minimum(0), z.maximum(1)),
  created_at: nullableOptional(epochMs),
  updated_at: nullableOptional(epochMs),
  created_by: nullableOptional(str()),
  updated_by: nullableOptional(str()),
  sensitivity: nullableOptional(str()),
  promotion_status: nullableOptional(str()),
  approval_status: nullableOptional(str()),
  last_accessed_at: nullableOptional(epochMs),
  last_reinforced_at: nullableOptional(epochMs),
};

export const knowledgeEntry = obj(knowledgeShape);

export const knowledgeVersion = obj({
  ...knowledgeShape,
  is_deleted: z.optional(z.boolean()),
  version: z.optional(int()),
});

export const sessionSummary = obj({
  session_id: nonEmpty(),
  message_count: nonNeg(),
  first_message_at: epochMs,
  last_message_at: epochMs,
  distilled_count: nonNeg(),
  undistilled_count: nonNeg(),
  distillation_count: nonNeg(),
});

export const message = obj({
  id: nonEmpty(),
  source_id: nullableOptional(str()),
  project_id: str(),
  session_id: str(),
  role: str(),
  content: str(),
  tokens: nonNeg(),
  distilled: int(),
  created_at: epochMs,
  metadata: nullable(str()),
});

const distillationShape = {
  id: nonEmpty(),
  session_id: str(),
  generation: int(),
  token_count: int(),
  r_compression: nullable(z.number()),
  c_norm: nullable(z.number()),
  archived: int(),
  created_at: epochMs,
};

export const distillationSummary = obj({
  ...distillationShape,
  call_type: nullable(str()),
});

export const distillationDetail = obj({
  ...distillationShape,
  project_id: str(),
  observations: str(),
  source_ids: str(),
});

export const sessionDetail = obj({
  messages: z.array(message),
  distillations: z.array(distillationSummary),
});

export const cursorPage = (item) =>
  obj({ items: z.array(item), next_cursor: nullable(str()) });

export const apiError = obj({
  type: z.literal("error"),
  error: obj({ type: str(), message: str() }),
});

export const account = obj({
  signed_in: z.boolean(),
  user: nullable(
    obj({ id: str(), email: nullable(str()), display_name: nullable(str()) }),
  ),
  provider: nullable(str()),
  expires_at: nullable(str()),
  state: z.enum(["signed_in", "anonymous", "expired"]),
});

const policy = z.enum(["manual", "auto"]);

export const teams = obj({
  teams: z.array(
    obj({
      id: str(),
      name: nullable(str()),
      role: str(),
      member_count: nonNeg(),
    }),
  ),
});

export const sharing = obj({
  linked: z.boolean(),
  team: nullable(obj({ id: str(), name: nullable(str()) })),
  policy: obj({
    effective: policy,
    project_override: nullable(policy),
    team_default: nullable(policy),
  }),
  state: z.enum(["not_linked", "linked", "locked", "degraded"]),
  detail: nullable(str()),
});

export const syncStatus = obj({
  enabled: z.boolean(),
  state: z.enum(["idle", "disabled"]),
  pending_changes: nullable(int()),
});

export const globalStats = obj({
  project_count: int(),
  knowledge_count: int(),
  session_count: int(),
  message_count: int(),
  distillation_count: int(),
  db_size_bytes: int(),
});

export const projectList = z.array(project);
export const knowledgePage = cursorPage(knowledgeEntry);

export const name = "zod-mini";
export function parse(schema, data) {
  const r = z.safeParse(schema, data);
  if (!r.success) throw new Error("invalid");
  return r.data;
}
export function check(schema, data) {
  return z.safeParse(schema, data).success;
}
