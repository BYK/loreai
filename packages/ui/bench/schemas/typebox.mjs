import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

// TypeBox objects allow additional properties by default (JSON Schema
// semantics), which matches the forward-compatibility rule.
const epochMs = Type.Integer({ minimum: 0 });
const nonNegInt = epochMs;
const nullable = (s) => Type.Union([s, Type.Null()]);
const nullableOptional = (s) => Type.Optional(nullable(s));
const nonEmpty = Type.String({ minLength: 1 });

export const project = Type.Object({
  id: nonEmpty,
  path: Type.String(),
  name: nullable(Type.String()),
  git_remote: nullable(Type.String()),
  created_at: epochMs,
  knowledge_count: nonNegInt,
  session_count: nonNegInt,
  message_count: nonNegInt,
  distillation_count: nonNegInt,
});

const knowledgeFields = {
  id: nonEmpty,
  logical_id: Type.Optional(nonEmpty),
  project_id: nullableOptional(Type.String()),
  category: Type.String(),
  title: Type.String(),
  content: Type.String(),
  source_session: nullableOptional(Type.String()),
  cross_project: Type.Optional(Type.Union([Type.Boolean(), Type.Number()])),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  created_at: nullableOptional(epochMs),
  updated_at: nullableOptional(epochMs),
  created_by: nullableOptional(Type.String()),
  updated_by: nullableOptional(Type.String()),
  sensitivity: nullableOptional(Type.String()),
  promotion_status: nullableOptional(Type.String()),
  approval_status: nullableOptional(Type.String()),
  last_accessed_at: nullableOptional(epochMs),
  last_reinforced_at: nullableOptional(epochMs),
};

export const knowledgeEntry = Type.Object(knowledgeFields);

export const knowledgeVersion = Type.Object({
  ...knowledgeFields,
  is_deleted: Type.Optional(Type.Boolean()),
  version: Type.Optional(Type.Integer()),
});

export const sessionSummary = Type.Object({
  session_id: nonEmpty,
  message_count: nonNegInt,
  first_message_at: epochMs,
  last_message_at: epochMs,
  distilled_count: nonNegInt,
  undistilled_count: nonNegInt,
  distillation_count: nonNegInt,
});

export const message = Type.Object({
  id: nonEmpty,
  source_id: nullableOptional(Type.String()),
  project_id: Type.String(),
  session_id: Type.String(),
  role: Type.String(),
  content: Type.String(),
  tokens: nonNegInt,
  distilled: Type.Integer(),
  created_at: epochMs,
  metadata: nullable(Type.String()),
});

const distillationFields = {
  id: nonEmpty,
  session_id: Type.String(),
  generation: Type.Integer(),
  token_count: Type.Integer(),
  r_compression: nullable(Type.Number()),
  c_norm: nullable(Type.Number()),
  archived: Type.Integer(),
  created_at: epochMs,
};

export const distillationSummary = Type.Object({
  ...distillationFields,
  call_type: nullable(Type.String()),
});

export const distillationDetail = Type.Object({
  ...distillationFields,
  project_id: Type.String(),
  observations: Type.String(),
  source_ids: Type.String(),
});

export const sessionDetail = Type.Object({
  messages: Type.Array(message),
  distillations: Type.Array(distillationSummary),
});

export const cursorPage = (item) =>
  Type.Object({
    items: Type.Array(item),
    next_cursor: nullable(Type.String()),
  });

export const apiError = Type.Object({
  type: Type.Literal("error"),
  error: Type.Object({ type: Type.String(), message: Type.String() }),
});

export const account = Type.Object({
  signed_in: Type.Boolean(),
  user: nullable(
    Type.Object({
      id: Type.String(),
      email: nullable(Type.String()),
      display_name: nullable(Type.String()),
    }),
  ),
  provider: nullable(Type.String()),
  expires_at: nullable(Type.String()),
  state: Type.Union([
    Type.Literal("signed_in"),
    Type.Literal("anonymous"),
    Type.Literal("expired"),
  ]),
});

const policy = Type.Union([Type.Literal("manual"), Type.Literal("auto")]);

export const teams = Type.Object({
  teams: Type.Array(
    Type.Object({
      id: Type.String(),
      name: nullable(Type.String()),
      role: Type.String(),
      member_count: nonNegInt,
    }),
  ),
});

export const sharing = Type.Object({
  linked: Type.Boolean(),
  team: nullable(
    Type.Object({ id: Type.String(), name: nullable(Type.String()) }),
  ),
  policy: Type.Object({
    effective: policy,
    project_override: nullable(policy),
    team_default: nullable(policy),
  }),
  state: Type.Union([
    Type.Literal("not_linked"),
    Type.Literal("linked"),
    Type.Literal("locked"),
    Type.Literal("degraded"),
  ]),
  detail: nullable(Type.String()),
});

export const syncStatus = Type.Object({
  enabled: Type.Boolean(),
  state: Type.Union([Type.Literal("idle"), Type.Literal("disabled")]),
  pending_changes: nullable(Type.Integer()),
});

export const globalStats = Type.Object({
  project_count: Type.Integer(),
  knowledge_count: Type.Integer(),
  session_count: Type.Integer(),
  message_count: Type.Integer(),
  distillation_count: Type.Integer(),
  db_size_bytes: Type.Integer(),
});

export const projectList = Type.Array(project);
export const knowledgePage = cursorPage(knowledgeEntry);

export const name = "typebox";
// Value.Check is the non-compiled validator (the compiled one needs
// `new Function`, which the UI's CSP `script-src 'self'` forbids).
export function parse(schema, data) {
  if (!Value.Check(schema, data)) throw new Error("invalid");
  return data;
}
export function check(schema, data) {
  return Value.Check(schema, data);
}
