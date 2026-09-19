import * as v from "valibot";

const epochMs = v.pipe(v.number(), v.integer(), v.minValue(0));
const nonNegInt = epochMs;
const nullableOptional = (s) => v.optional(v.nullable(s));
const nonEmpty = v.pipe(v.string(), v.minLength(1));

export const project = v.looseObject({
  id: nonEmpty,
  path: v.string(),
  name: v.nullable(v.string()),
  git_remote: v.nullable(v.string()),
  created_at: epochMs,
  knowledge_count: nonNegInt,
  session_count: nonNegInt,
  message_count: nonNegInt,
  distillation_count: nonNegInt,
});

const knowledgeFields = {
  id: nonEmpty,
  logical_id: v.optional(nonEmpty),
  project_id: nullableOptional(v.string()),
  category: v.string(),
  title: v.string(),
  content: v.string(),
  source_session: nullableOptional(v.string()),
  cross_project: v.optional(v.union([v.boolean(), v.number()])),
  confidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  created_at: nullableOptional(epochMs),
  updated_at: nullableOptional(epochMs),
  created_by: nullableOptional(v.string()),
  updated_by: nullableOptional(v.string()),
  sensitivity: nullableOptional(v.string()),
  promotion_status: nullableOptional(v.string()),
  approval_status: nullableOptional(v.string()),
  last_accessed_at: nullableOptional(epochMs),
  last_reinforced_at: nullableOptional(epochMs),
};

export const knowledgeEntry = v.looseObject(knowledgeFields);

export const knowledgeVersion = v.looseObject({
  ...knowledgeFields,
  is_deleted: v.optional(v.boolean()),
  version: v.optional(v.pipe(v.number(), v.integer())),
});

export const sessionSummary = v.looseObject({
  session_id: nonEmpty,
  message_count: nonNegInt,
  first_message_at: epochMs,
  last_message_at: epochMs,
  distilled_count: nonNegInt,
  undistilled_count: nonNegInt,
  distillation_count: nonNegInt,
});

export const message = v.looseObject({
  id: nonEmpty,
  source_id: nullableOptional(v.string()),
  project_id: v.string(),
  session_id: v.string(),
  role: v.string(),
  content: v.string(),
  tokens: nonNegInt,
  distilled: v.pipe(v.number(), v.integer()),
  created_at: epochMs,
  metadata: v.nullable(v.string()),
});

const distillationFields = {
  id: nonEmpty,
  session_id: v.string(),
  generation: v.pipe(v.number(), v.integer()),
  token_count: v.pipe(v.number(), v.integer()),
  r_compression: v.nullable(v.number()),
  c_norm: v.nullable(v.number()),
  archived: v.pipe(v.number(), v.integer()),
  created_at: epochMs,
};

export const distillationSummary = v.looseObject({
  ...distillationFields,
  call_type: v.nullable(v.string()),
});

export const distillationDetail = v.looseObject({
  ...distillationFields,
  project_id: v.string(),
  observations: v.string(),
  source_ids: v.string(),
});

export const sessionDetail = v.looseObject({
  messages: v.array(message),
  distillations: v.array(distillationSummary),
});

export const cursorPage = (item) =>
  v.looseObject({ items: v.array(item), next_cursor: v.nullable(v.string()) });

export const apiError = v.looseObject({
  type: v.literal("error"),
  error: v.looseObject({ type: v.string(), message: v.string() }),
});

export const account = v.looseObject({
  signed_in: v.boolean(),
  user: v.nullable(
    v.object({
      id: v.string(),
      email: v.nullable(v.string()),
      display_name: v.nullable(v.string()),
    }),
  ),
  provider: v.nullable(v.string()),
  expires_at: v.nullable(v.string()),
  state: v.picklist(["signed_in", "anonymous", "expired"]),
});

const policy = v.picklist(["manual", "auto"]);

export const teams = v.looseObject({
  teams: v.array(
    v.looseObject({
      id: v.string(),
      name: v.nullable(v.string()),
      role: v.string(),
      member_count: nonNegInt,
    }),
  ),
});

export const sharing = v.looseObject({
  linked: v.boolean(),
  team: v.nullable(v.object({ id: v.string(), name: v.nullable(v.string()) })),
  policy: v.object({
    effective: policy,
    project_override: v.nullable(policy),
    team_default: v.nullable(policy),
  }),
  state: v.picklist(["not_linked", "linked", "locked", "degraded"]),
  detail: v.nullable(v.string()),
});

export const syncStatus = v.looseObject({
  enabled: v.boolean(),
  state: v.picklist(["idle", "disabled"]),
  pending_changes: v.nullable(v.pipe(v.number(), v.integer())),
});

export const globalStats = v.looseObject({
  project_count: v.pipe(v.number(), v.integer()),
  knowledge_count: v.pipe(v.number(), v.integer()),
  session_count: v.pipe(v.number(), v.integer()),
  message_count: v.pipe(v.number(), v.integer()),
  distillation_count: v.pipe(v.number(), v.integer()),
  db_size_bytes: v.pipe(v.number(), v.integer()),
});

export const projectList = v.array(project);
export const knowledgePage = cursorPage(knowledgeEntry);

export const name = "valibot";
export function parse(schema, data) {
  const r = v.safeParse(schema, data);
  if (!r.success) throw new Error("invalid");
  return r.output;
}
export function check(schema, data) {
  return v.safeParse(schema, data).success;
}
