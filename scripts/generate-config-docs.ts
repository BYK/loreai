/**
 * Generate the `configuration.md` reference page from the Zod schema
 * in `packages/core/src/config.ts`.
 *
 * Mimics the Sentry CLI pattern: a single source of truth (the Zod
 * schema with `.describe()` calls) drives a hand-shaped Markdown file
 * that the docs site consumes. A `--check` flag makes the script exit 1
 * when the generated output would change the committed file, so CI can
 * gate against schema/doc drift.
 *
 * Walks the Zod schema directly via `_def.shape` / `_def.innerType` so
 * we don't need a JSON Schema round-trip — this is robust to Zod 4
 * wrapper types (ZodEffects, ZodPipeline) that zod-to-json-schema can't
 * always inline.
 *
 * Usage:
 *   pnpm generate:docs                  # write configuration.md
 *   pnpm check:docs                     # exit 1 if configuration.md is stale
 */
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ZodTypeAny } from "zod";
import { LoreConfig } from "../packages/core/src/config.ts";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const OUTPUT_PATH = join(
  REPO_ROOT,
  "packages/website/src/content/docs/docs/configuration.md",
);

const checkOnly = process.argv.includes("--check");

// ---------------------------------------------------------------------------
// Zod introspection helpers
// ---------------------------------------------------------------------------

/** Get the underlying ZodObject even when wrapped (ZodEffects/ZodPipeline). */
function unwrap(schema: ZodTypeAny): ZodTypeAny {
  let current = schema;
  // Unwrap ZodDefault, ZodOptional, ZodNullable chains in Zod 4.
  // Zod 4 uses _def.type ("default" | "optional" | "nullable") and
  // _def.innerType for the wrapped schema.
  while (true) {
    const def = current._def as {
      type?: string;
      innerType?: ZodTypeAny;
    };
    if (
      (def.type === "default" ||
        def.type === "optional" ||
        def.type === "nullable") &&
      def.innerType
    ) {
      current = def.innerType;
      continue;
    }
    break;
  }
  return current;
}

/** Get the .shape map of a ZodObject, or null if not an object schema. */
function getShape(schema: ZodTypeAny): Record<string, ZodTypeAny> | null {
  const inner = unwrap(schema);
  const shape = (inner._def as { shape?: Record<string, ZodTypeAny> }).shape;
  if (shape && typeof shape === "object") {
    return shape;
  }
  return null;
}

/** Get the .description from a Zod schema. In Zod 4, this is a top-level
 *  property on the schema instance (not on _def). We walk through the
 *  wrapper chain (default/optional) to find the most-specific description
 *  — outer wrappers override inner ones. */
function getDescription(schema: ZodTypeAny): string | undefined {
  let current: ZodTypeAny | undefined = schema;
  let lastSeen: string | undefined;
  while (current) {
    const desc = (current as { description?: string }).description;
    if (desc) lastSeen = desc;
    const def = current._def as { innerType?: ZodTypeAny };
    current = def.innerType;
  }
  return lastSeen;
}

/** Get the default value if .default() was applied. */
function getDefault(schema: ZodTypeAny): unknown {
  const def = schema._def as {
    type?: string;
    defaultValue?: unknown;
    innerType?: ZodTypeAny;
  };
  if (def.type === "default" && "defaultValue" in def) {
    return def.defaultValue;
  }
  if (def.innerType) {
    return getDefault(def.innerType);
  }
  return undefined;
}

/** Get the Zod 4 type name (from _def.type). */
function getTypeName(schema: ZodTypeAny): string | undefined {
  return (schema._def as { type?: string }).type;
}

/** Get enum values from a ZodEnum. */
function getEnumValues(schema: ZodTypeAny): string[] | undefined {
  const def = schema._def as {
    type?: string;
    values?: readonly string[] | Record<string, string>;
  };
  if (def.type !== "enum") return undefined;
  if (Array.isArray(def.values)) return [...def.values];
  if (def.values && typeof def.values === "object") {
    return Object.values(def.values);
  }
  return undefined;
}

/** Get min/max from a ZodNumber. Unwraps default/optional layers first
 *  because .min()/.max() checks live on the inner ZodNumber, not the wrapper. */
function getNumberRange(schema: ZodTypeAny): { min?: number; max?: number } {
  const inner = unwrap(schema);
  const def = inner._def as {
    type?: string;
    checks?: Array<{
      _zod?: {
        def?: { check?: string; value?: number; inclusive?: boolean };
      };
    }>;
  };
  const range: { min?: number; max?: number } = {};
  if (def.type !== "number") return range;
  if (Array.isArray(def.checks)) {
    for (const c of def.checks) {
      const zodCheck = c._zod?.def;
      // Zod 4 uses check names: greater_than (exclusive min) and less_than
      // (exclusive max). For inclusive bounds (min/max), use inclusive=true.
      // The README-facing labels map both to "min N" / "max N".
      if (zodCheck?.check === "greater_than" || zodCheck?.check === "min") {
        if (zodCheck.value !== undefined) range.min = zodCheck.value;
      }
      if (zodCheck?.check === "less_than" || zodCheck?.check === "max") {
        if (zodCheck.value !== undefined) range.max = zodCheck.value;
      }
    }
  }
  return range;
}

// ---------------------------------------------------------------------------
// Type formatting
// ---------------------------------------------------------------------------

function formatType(schema: ZodTypeAny): string {
  const enumValues = getEnumValues(schema);
  if (enumValues) {
    return enumValues.map((v) => `"${v}"`).join(" \\| ");
  }
  const typeName = getTypeName(schema);
  // Unwrap optional/default wrappers for the type label
  const inner = unwrap(schema);
  const innerTypeName = getTypeName(inner);

  if (innerTypeName === "array") {
    const itemDef = inner._def as { element: ZodTypeAny };
    const element = itemDef.element;
    const elementType = getTypeName(unwrap(element));
    if (elementType === "object") {
      const shape = getShape(element);
      if (shape) {
        const fieldNames = Object.keys(shape).join(", ");
        return `array<{ ${fieldNames} }>`;
      }
    }
    return `array<${formatType(element)}>`;
  }
  if (innerTypeName === "record") {
    const recordDef = inner._def as { valueType: ZodTypeAny };
    return `Record<string, ${formatType(recordDef.valueType)}>`;
  }
  if (innerTypeName === "object") {
    return "object";
  }
  if (innerTypeName === "number") return "number";
  if (innerTypeName === "string") return "string";
  if (innerTypeName === "boolean") return "boolean";
  if (innerTypeName === "optional") {
    const optDef = inner._def as { innerType: ZodTypeAny };
    return `${formatType(optDef.innerType)} \\| undefined`;
  }
  return innerTypeName ?? "unknown";
}

function formatDefault(value: unknown): string {
  if (value === undefined) return "—";
  if (typeof value === "string") return `\`"${value}"\``;
  if (value === null) return "`null`";
  if (typeof value === "object") return `\`${JSON.stringify(value)}\``;
  return `\`${String(value)}\``;
}

function formatConstraints(schema: ZodTypeAny): string {
  const enumValues = getEnumValues(schema);
  if (enumValues) return `one of: ${enumValues.join(", ")}`;
  const { min, max } = getNumberRange(schema);
  const parts: string[] = [];
  if (min !== undefined) parts.push(`min ${min}`);
  if (max !== undefined) parts.push(`max ${max}`);
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function renderFieldRow(name: string, schema: ZodTypeAny): string {
  const type = formatType(schema);
  const def = formatDefault(getDefault(schema));
  const constraints = formatConstraints(schema);
  const description = (getDescription(schema) ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ");
  return `| \`${name}\` | ${type} | ${def} | ${constraints} | ${description} |`;
}

function renderObject(name: string, schema: ZodTypeAny, depth = 0): string {
  const lines: string[] = [];
  // Top-level calls (depth=0) render as `## name`; nested as `###`,
  // and so on. Capped at h6 to keep heading hierarchy sensible.
  const heading = `${"#".repeat(Math.min(depth + 2, 6))} \`${name}\``;
  lines.push(heading);
  const description = getDescription(schema);
  if (description) {
    lines.push("");
    lines.push(description);
  }
  lines.push("");

  const shape = getShape(schema);
  if (!shape) {
    return lines.join("\n");
  }

  // Render the field table
  lines.push("| Field | Type | Default | Constraints | Description |");
  lines.push("|---|---|---|---|---|");
  for (const [fieldName, fieldSchema] of Object.entries(shape)) {
    lines.push(renderFieldRow(fieldName, fieldSchema));
  }
  lines.push("");

  // Recurse into nested objects (one level deep per call; depth controls
  // how far the recursion goes). At depth 0 we go to depth 2, etc.
  if (depth < 1) {
    for (const [fieldName, fieldSchema] of Object.entries(shape)) {
      const inner = unwrap(fieldSchema);
      if (getTypeName(inner) === "object") {
        lines.push(
          renderObject(`${name}.${fieldName}`, fieldSchema, depth + 1),
        );
      }
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Page assembly
// ---------------------------------------------------------------------------

function renderPage(): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push("title: Configuration reference");
  lines.push(
    "description: Complete reference for every field in .lore.json, generated from the Zod schema.",
  );
  lines.push("sidebar:");
  lines.push("  order: 4");
  lines.push("---");
  lines.push("");
  lines.push(
    "This page is auto-generated from the Zod schema in `packages/core/src/config.ts`. " +
      "If you change the schema, run `pnpm run generate:docs` to regenerate this file.",
  );
  lines.push("");

  // Index of top-level keys
  lines.push("## Top-level keys");
  lines.push("");
  const topShape = getShape(LoreConfig);
  if (!topShape) {
    throw new Error("LoreConfig is not a ZodObject — cannot generate docs");
  }
  for (const [key, schema] of Object.entries(topShape)) {
    const desc = (getDescription(schema) ?? "").replace(/\n/g, " ");
    lines.push(
      `- [\`${key}\`](#${key.replace(/\./g, "")}) — ${desc || "_no description_"}`,
    );
  }
  lines.push("");

  // Detail per top-level key
  for (const [key, schema] of Object.entries(topShape)) {
    lines.push(renderObject(key, schema, 0));
    lines.push("");
  }
  return lines.join("\n");
}

const generated = renderPage();

// ---------------------------------------------------------------------------
// Write or check
// ---------------------------------------------------------------------------

if (checkOnly) {
  let existing: string;
  try {
    existing = readFileSync(OUTPUT_PATH, "utf8");
  } catch {
    console.error(
      `[generate-config-docs] --check: ${OUTPUT_PATH} does not exist. Run 'pnpm run generate:docs' to create it.`,
    );
    process.exit(1);
  }
  if (existing !== generated) {
    console.error(
      `[generate-config-docs] --check: ${OUTPUT_PATH} is stale. Run 'pnpm run generate:docs' to update it.`,
    );
    process.exit(1);
  }
  console.log(`[generate-config-docs] --check: ${OUTPUT_PATH} is up to date.`);
} else {
  writeFileSync(OUTPUT_PATH, generated, "utf8");
  console.log(`[generate-config-docs] wrote ${OUTPUT_PATH}`);
}
