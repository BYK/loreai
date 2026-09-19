/**
 * Runtime schemas for the three read routes UI-02 consumes. They validate
 * only what the UI renders; every other field is passed through untouched
 * (`.loose()`) so core stays the authority on the record shape and later
 * slices can add fields without breaking this client.
 *
 * See the API inventory on #1796 for the full, code-verified response shapes.
 */
import { z } from "zod";

/** Core stores timestamps as epoch milliseconds (`INTEGER` columns). */
export const epochMsSchema = z.number().int().nonnegative();

export const projectSummarySchema = z
  .object({
    id: z.string().min(1),
    path: z.string(),
    name: z.string(),
    git_remote: z.string().nullable().optional(),
    created_at: epochMsSchema.nullable().optional(),
    knowledge_count: z.number().int().nonnegative().catch(0),
    session_count: z.number().int().nonnegative().catch(0),
    message_count: z.number().int().nonnegative().catch(0),
    distillation_count: z.number().int().nonnegative().catch(0),
  })
  .loose();

export type ProjectSummary = z.infer<typeof projectSummarySchema>;

export const projectListSchema = z.array(projectSummarySchema);

export const knowledgeCategorySchema = z.enum([
  "decision",
  "pattern",
  "preference",
  "architecture",
  "gotcha",
]);

export type KnowledgeCategory = z.infer<typeof knowledgeCategorySchema>;

/**
 * `id` is the stable logical id (the API rewrites it for every read route);
 * it is the only identity the browser may put in a URL.
 */
export const knowledgeEntrySchema = z
  .object({
    id: z.string().min(1),
    logical_id: z.string().min(1).optional(),
    project_id: z.string().nullable().optional(),
    category: z.string(),
    title: z.string(),
    content: z.string(),
    source_session: z.string().nullable().optional(),
    cross_project: z.union([z.boolean(), z.number()]).optional(),
    confidence: z.number().min(0).max(1).catch(0),
    created_at: epochMsSchema.nullable().optional(),
    updated_at: epochMsSchema.nullable().optional(),
    created_by: z.string().nullable().optional(),
    updated_by: z.string().nullable().optional(),
    sensitivity: z.string().nullable().optional(),
    promotion_status: z.string().nullable().optional(),
    approval_status: z.string().nullable().optional(),
    last_accessed_at: epochMsSchema.nullable().optional(),
    last_reinforced_at: epochMsSchema.nullable().optional(),
  })
  .loose();

export type KnowledgeEntry = z.infer<typeof knowledgeEntrySchema>;

export const knowledgeListSchema = z.array(knowledgeEntrySchema);

export const apiErrorSchema = z
  .object({
    type: z.literal("error"),
    error: z
      .object({
        type: z.string(),
        message: z.string(),
      })
      .loose(),
  })
  .loose();

export type ApiErrorBody = z.infer<typeof apiErrorSchema>;
