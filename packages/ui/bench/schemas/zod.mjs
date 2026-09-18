import { z } from "zod";

const epochMs = z.number().int().nonnegative();
const nullableOptional = (s) => s.nullable().optional();

export const project = z
  .object({
    id: z.string().min(1),
    path: z.string(),
    name: z.string().nullable(),
    git_remote: z.string().nullable(),
    created_at: epochMs,
    knowledge_count: z.number().int().nonnegative(),
    session_count: z.number().int().nonnegative(),
    message_count: z.number().int().nonnegative(),
    distillation_count: z.number().int().nonnegative(),
  })
  .loose();

export const knowledgeEntry = z
  .object({
    id: z.string().min(1),
    logical_id: z.string().min(1).optional(),
    project_id: nullableOptional(z.string()),
    category: z.string(),
    title: z.string(),
    content: z.string(),
    source_session: nullableOptional(z.string()),
    cross_project: z.union([z.boolean(), z.number()]).optional(),
    confidence: z.number().min(0).max(1),
    created_at: nullableOptional(epochMs),
    updated_at: nullableOptional(epochMs),
    created_by: nullableOptional(z.string()),
    updated_by: nullableOptional(z.string()),
    sensitivity: nullableOptional(z.string()),
    promotion_status: nullableOptional(z.string()),
    approval_status: nullableOptional(z.string()),
    last_accessed_at: nullableOptional(epochMs),
    last_reinforced_at: nullableOptional(epochMs),
  })
  .loose();

export const knowledgeVersion = knowledgeEntry.extend({
  is_deleted: z.boolean().optional(),
  version: z.number().int().optional(),
});

export const sessionSummary = z
  .object({
    session_id: z.string().min(1),
    message_count: z.number().int().nonnegative(),
    first_message_at: epochMs,
    last_message_at: epochMs,
    distilled_count: z.number().int().nonnegative(),
    undistilled_count: z.number().int().nonnegative(),
    distillation_count: z.number().int().nonnegative(),
  })
  .loose();

export const message = z
  .object({
    id: z.string().min(1),
    source_id: nullableOptional(z.string()),
    project_id: z.string(),
    session_id: z.string(),
    role: z.string(),
    content: z.string(),
    tokens: z.number().int().nonnegative(),
    distilled: z.number().int(),
    created_at: epochMs,
    metadata: z.string().nullable(),
  })
  .loose();

export const distillationSummary = z
  .object({
    id: z.string().min(1),
    session_id: z.string(),
    generation: z.number().int(),
    token_count: z.number().int(),
    r_compression: z.number().nullable(),
    c_norm: z.number().nullable(),
    archived: z.number().int(),
    created_at: epochMs,
    call_type: z.string().nullable(),
  })
  .loose();

export const distillationDetail = distillationSummary
  .omit({ call_type: true })
  .extend({
    project_id: z.string(),
    observations: z.string(),
    source_ids: z.string(),
  });

export const sessionDetail = z
  .object({
    messages: z.array(message),
    distillations: z.array(distillationSummary),
  })
  .loose();

export const cursorPage = (item) =>
  z.object({ items: z.array(item), next_cursor: z.string().nullable() }).loose();

export const apiError = z
  .object({
    type: z.literal("error"),
    error: z.object({ type: z.string(), message: z.string() }).loose(),
  })
  .loose();

export const account = z
  .object({
    signed_in: z.boolean(),
    user: z
      .object({
        id: z.string(),
        email: z.string().nullable(),
        display_name: z.string().nullable(),
      })
      .nullable(),
    provider: z.string().nullable(),
    expires_at: z.string().nullable(),
    state: z.enum(["signed_in", "anonymous", "expired"]),
  })
  .loose();

const policy = z.enum(["manual", "auto"]);

export const teams = z
  .object({
    teams: z.array(
      z
        .object({
          id: z.string(),
          name: z.string().nullable(),
          role: z.string(),
          member_count: z.number().int().nonnegative(),
        })
        .loose(),
    ),
  })
  .loose();

export const sharing = z
  .object({
    linked: z.boolean(),
    team: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
    policy: z.object({
      effective: policy,
      project_override: policy.nullable(),
      team_default: policy.nullable(),
    }),
    state: z.enum(["not_linked", "linked", "locked", "degraded"]),
    detail: z.string().nullable(),
  })
  .loose();

export const syncStatus = z
  .object({
    enabled: z.boolean(),
    state: z.enum(["idle", "disabled"]),
    pending_changes: z.number().int().nullable(),
  })
  .loose();

export const globalStats = z
  .object({
    project_count: z.number().int(),
    knowledge_count: z.number().int(),
    session_count: z.number().int(),
    message_count: z.number().int(),
    distillation_count: z.number().int(),
    db_size_bytes: z.number().int(),
  })
  .loose();

export const projectList = z.array(project);
export const knowledgePage = cursorPage(knowledgeEntry);

export const name = "zod";
export function parse(schema, data) {
  const r = schema.safeParse(data);
  if (!r.success) throw new Error("invalid");
  return r.data;
}
export function check(schema, data) {
  return schema.safeParse(data).success;
}
