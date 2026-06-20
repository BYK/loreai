/**
 * CLI `lore entity` command — manage the entity registry.
 *
 * Subcommands:
 *   list                         List all entities with aliases
 *   show <id>                    Show full detail for an entity
 *   add <type> <name>            Create a new entity
 *   edit <id>                    Edit an entity
 *   alias add <id> --type <t> --value <v>   Add an alias to an entity
 *   alias rm <alias-id>          Remove an alias
 *   relation add <a-id> <b-id> --relation <type>  Add a relation
 *   relation rm <relation-id>    Remove a relation
 *   merge <target-id> <source-id>  Merge two entities
 *   search <query>               Search entities by name or alias
 *   delete <id>                  Delete an entity
 */
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
}

function padRight(str: string, len: number): string {
  return str.length >= len
    ? str.slice(0, len)
    : str + " ".repeat(len - str.length);
}

function printTable(
  headers: string[],
  rows: string[][],
  widths: number[],
): void {
  const header = headers.map((h, i) => padRight(h, widths[i])).join("  ");
  console.log(header);
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) {
    console.log(row.map((cell, i) => padRight(cell, widths[i])).join("  "));
  }
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function cmdList(
  _args: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  const { entities } = await import("@loreai/core");
  const projectPath = resolve((flags.project as string) ?? process.cwd());
  const asJson = !!flags.json;

  const all = flags.all ? entities.listAll() : entities.forProject(projectPath);

  if (asJson) {
    console.log(JSON.stringify(all, null, 2));
    return;
  }

  if (!all.length) {
    console.log("No entities found.");
    return;
  }

  const rows = all.map((e) => {
    const aliasCount = e.aliases.filter(
      (a) => a.alias_value !== e.canonical_name,
    ).length;
    return [
      e.id.slice(0, 16),
      e.entity_type,
      e.canonical_name,
      String(aliasCount),
      e.cross_project ? "yes" : "no",
      formatDate(e.updated_at),
    ];
  });

  printTable(
    ["ID", "Type", "Name", "Aliases", "Cross", "Updated"],
    rows,
    [16, 10, 30, 7, 5, 19],
  );
  console.log(`\n${all.length} entities total.`);
}

async function cmdShow(
  args: string[],
  _flags: Record<string, unknown>,
): Promise<void> {
  const id = args[0];
  if (!id) {
    console.error("Usage: lore entity show <id>");
    process.exit(1);
  }

  const { entities, ltm, db } = await import("@loreai/core");

  // Support prefix matching on ID (list shows truncated 16-char IDs)
  let entity = entities.getWithAliases(id);
  if (!entity && id.length < 36) {
    const match = db()
      .query("SELECT id FROM entities WHERE id LIKE ? LIMIT 1")
      .get(`${id}%`) as { id: string } | null;
    if (match) entity = entities.getWithAliases(match.id);
  }
  if (!entity) {
    console.error(`Entity not found: ${id}`);
    process.exit(1);
  }

  console.log(`Entity: ${entity.canonical_name}`);
  console.log(`ID:     ${entity.id}`);
  console.log(`Type:   ${entity.entity_type}`);
  console.log(`Cross:  ${entity.cross_project ? "yes" : "no"}`);
  console.log(`Created: ${formatDate(entity.created_at)}`);
  console.log(`Updated: ${formatDate(entity.updated_at)}`);
  if (entity.metadata) {
    console.log(`Metadata: ${entity.metadata}`);
  }

  if (entity.aliases.length > 0) {
    console.log(`\nAliases (${entity.aliases.length}):`);
    for (const a of entity.aliases) {
      const src = a.source ? ` [${a.source}]` : "";
      console.log(
        `  ${a.alias_type}: ${a.alias_value}${src}  (${a.id.slice(0, 12)})`,
      );
    }
  }

  // Show linked knowledge entries
  const knowledgeIds = entities.knowledgeForEntity(entity.id);
  if (knowledgeIds.length > 0) {
    console.log(`\nLinked knowledge entries (${knowledgeIds.length}):`);
    for (const kid of knowledgeIds) {
      const entry = ltm.getByLogical(kid); // kid is a logical_id (A2)
      if (entry) {
        console.log(
          `  [${entry.id.slice(0, 16)}] (${entry.category}) ${entry.title}`,
        );
      }
    }
  }

  // Show relationships
  const relations = entities.relationsFor(entity.id);
  if (relations.length > 0) {
    console.log(`\nRelationships (${relations.length}):`);
    for (const r of relations) {
      const metaStr = r.metadata ? ` ${r.metadata}` : "";
      console.log(
        `  ${r.relation}: ${r.other_name} (${r.other_type})${metaStr}  (${r.id.slice(0, 12)})`,
      );
    }
  }
}

async function cmdAdd(
  args: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  const entityType = args[0];
  const name = args.slice(1).join(" ");

  if (!entityType || !name) {
    console.error("Usage: lore entity add <type> <name>");
    console.error("Types: person, org, service, tool, repo, infra");
    process.exit(1);
  }

  const { entities } = await import("@loreai/core");
  const validTypes = entities.ENTITY_TYPES as readonly string[];
  if (!validTypes.includes(entityType)) {
    console.error(`Invalid entity type: ${entityType}`);
    console.error(`Valid types: ${entities.ENTITY_TYPES.join(", ")}`);
    process.exit(1);
  }

  const projectPath = resolve((flags.project as string) ?? process.cwd());
  const cross = flags.cross !== false; // default true

  let metadata: Record<string, unknown> | undefined;
  if (flags.metadata) {
    try {
      metadata = JSON.parse(flags.metadata as string);
      if (
        typeof metadata !== "object" ||
        Array.isArray(metadata) ||
        metadata === null
      ) {
        console.error("--metadata must be a JSON object");
        process.exit(1);
      }
    } catch {
      console.error("--metadata must be valid JSON");
      process.exit(1);
    }
  }

  const result = entities.create({
    projectPath,
    entityType: entityType as (typeof entities.ENTITY_TYPES)[number],
    canonicalName: name,
    crossProject: cross,
    metadata,
  });

  if (result.created) {
    console.log(`Created entity: ${result.id}`);
  } else {
    console.log(`Entity already exists: ${result.id}`);
  }
  console.log(`  Type: ${entityType}`);
  console.log(`  Name: ${name}`);
}

async function cmdEdit(
  args: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  const id = args[0];
  if (!id) {
    console.error(
      "Usage: lore entity edit <id> [--name <name>] [--metadata <json>] [--cross]",
    );
    process.exit(1);
  }

  const { entities, db } = await import("@loreai/core");

  // Support prefix matching on ID
  let entity = entities.get(id);
  if (!entity && id.length < 36) {
    const match = db()
      .query("SELECT id FROM entities WHERE id LIKE ? LIMIT 1")
      .get(`${id}%`) as { id: string } | null;
    if (match) entity = entities.get(match.id);
  }
  if (!entity) {
    console.error(`Entity not found: ${id}`);
    process.exit(1);
  }

  const updates: Record<string, unknown> = {};

  if (flags.name) {
    updates.canonicalName = flags.name as string;
  }

  if (flags.cross !== undefined) {
    updates.crossProject = flags.cross !== false;
  }

  if (flags.metadata) {
    let parsed: Record<string, unknown> | undefined;
    try {
      const value = JSON.parse(flags.metadata as string);
      if (typeof value !== "object" || Array.isArray(value) || value === null) {
        console.error("--metadata must be a JSON object");
        process.exit(1);
      }
      parsed = value as Record<string, unknown>;
    } catch {
      console.error("--metadata must be valid JSON");
      process.exit(1);
    }
    if (!parsed) {
      console.error("--metadata must be a JSON object");
      process.exit(1);
    }
    const merged = entities.mergeMetadata(entity.metadata, parsed);
    updates.metadata = merged ?? {};
  }

  if (Object.keys(updates).length === 0) {
    console.error("No changes specified. Use --name, --metadata, or --cross.");
    process.exit(1);
  }

  entities.update(entity.id, updates);
  console.log(`Updated entity: ${entity.canonical_name} (${entity.id})`);
}

async function cmdAliasAdd(
  args: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  const entityId = args[0];
  const aliasType = flags.type as string;
  const aliasValue = flags.value as string;

  if (!entityId || !aliasType || !aliasValue) {
    console.error(
      "Usage: lore entity alias add <entity-id> --type <type> --value <value>",
    );
    console.error(
      "Alias types: name, email, github, slack, phone, nickname, url, domain",
    );
    process.exit(1);
  }

  const { entities } = await import("@loreai/core");

  const ALIAS_TYPES = [
    "name",
    "email",
    "github",
    "slack",
    "phone",
    "nickname",
    "url",
    "domain",
  ] as const;
  if (!ALIAS_TYPES.includes(aliasType as (typeof ALIAS_TYPES)[number])) {
    console.error(`Invalid alias type: ${aliasType}`);
    console.error(`Valid types: ${ALIAS_TYPES.join(", ")}`);
    process.exit(1);
  }

  const entity = entities.get(entityId);
  if (!entity) {
    console.error(`Entity not found: ${entityId}`);
    process.exit(1);
  }

  const id = entities.addAlias(
    entityId,
    aliasType as (typeof ALIAS_TYPES)[number],
    aliasValue,
    "manual",
  );
  if (id) {
    // Refresh the dedup embedding now that the alias set changed.
    entities.reembedEntity(entityId);
    console.log(
      `Added alias: ${aliasType}:${aliasValue} → ${entity.canonical_name}`,
    );
  } else {
    console.error(`Alias already exists: ${aliasType}:${aliasValue}`);
  }
}

async function cmdAliasRm(
  args: string[],
  _flags: Record<string, unknown>,
): Promise<void> {
  const aliasId = args[0];
  if (!aliasId) {
    console.error("Usage: lore entity alias rm <alias-id>");
    process.exit(1);
  }

  const { entities, db } = await import("@loreai/core");
  // Capture the owning entity before deletion so we can refresh its embedding.
  const owner = db()
    .query("SELECT entity_id FROM entity_aliases WHERE id = ?")
    .get(aliasId) as { entity_id: string } | null;
  entities.removeAlias(aliasId);
  if (owner) entities.reembedEntity(owner.entity_id);
  console.log(`Removed alias: ${aliasId}`);
}

async function cmdRelationAdd(
  args: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  const idA = args[0];
  const idB = args[1];
  const relation = flags.relation as string;

  if (!idA || !idB || !relation) {
    console.error(
      "Usage: lore entity relation add <entity-a-id> <entity-b-id> --relation <type> [--metadata <json>]",
    );
    process.exit(1);
  }

  const { entities, db } = await import("@loreai/core");

  const validRelations = entities.RELATION_TYPES as readonly string[];
  if (!validRelations.includes(relation)) {
    console.error(`Invalid relation type: ${relation}`);
    console.error(`Valid types: ${entities.RELATION_TYPES.join(", ")}`);
    process.exit(1);
  }

  // Prefix matching on both IDs
  let entityA = entities.get(idA);
  if (!entityA && idA.length < 36) {
    const match = db()
      .query("SELECT id FROM entities WHERE id LIKE ? LIMIT 1")
      .get(`${idA}%`) as { id: string } | null;
    if (match) entityA = entities.get(match.id);
  }
  if (!entityA) {
    console.error(`Entity A not found: ${idA}`);
    process.exit(1);
  }

  let entityB = entities.get(idB);
  if (!entityB && idB.length < 36) {
    const match = db()
      .query("SELECT id FROM entities WHERE id LIKE ? LIMIT 1")
      .get(`${idB}%`) as { id: string } | null;
    if (match) entityB = entities.get(match.id);
  }
  if (!entityB) {
    console.error(`Entity B not found: ${idB}`);
    process.exit(1);
  }

  let relMetadata: Record<string, unknown> | undefined;
  if (flags.metadata) {
    try {
      const parsed = JSON.parse(flags.metadata as string);
      if (
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        parsed === null
      ) {
        console.error("--metadata must be a JSON object");
        process.exit(1);
      }
      relMetadata = parsed as Record<string, unknown>;
    } catch {
      console.error("--metadata must be valid JSON");
      process.exit(1);
    }
  }

  const relId = entities.addRelation(
    entityA.id,
    entityB.id,
    relation as (typeof entities.RELATION_TYPES)[number],
    { metadata: relMetadata, source: "manual" },
  );
  console.log(
    `Added relation: ${entityA.canonical_name} —[${relation}]→ ${entityB.canonical_name}`,
  );
  console.log(`  Relation ID: ${relId}`);
}

async function cmdRelationRm(
  args: string[],
  _flags: Record<string, unknown>,
): Promise<void> {
  const relationId = args[0];
  if (!relationId) {
    console.error("Usage: lore entity relation rm <relation-id>");
    process.exit(1);
  }

  const { entities } = await import("@loreai/core");
  entities.removeRelation(relationId);
  console.log(`Removed relation: ${relationId}`);
}

async function cmdMerge(
  args: string[],
  _flags: Record<string, unknown>,
): Promise<void> {
  const targetId = args[0];
  const sourceId = args[1];

  if (!targetId || !sourceId) {
    console.error("Usage: lore entity merge <target-id> <source-id>");
    console.error("Keeps target, absorbs aliases from source, deletes source.");
    process.exit(1);
  }

  const { entities } = await import("@loreai/core");
  const target = entities.get(targetId);
  const source = entities.get(sourceId);
  if (!target) {
    console.error(`Target entity not found: ${targetId}`);
    process.exit(1);
  }
  if (!source) {
    console.error(`Source entity not found: ${sourceId}`);
    process.exit(1);
  }

  entities.merge(targetId, sourceId);
  console.log(
    `Merged "${source.canonical_name}" into "${target.canonical_name}"`,
  );
}

async function cmdSearch(
  args: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  const query = args.join(" ");
  if (!query) {
    console.error("Usage: lore entity search <query>");
    process.exit(1);
  }

  const { entities } = await import("@loreai/core");
  const projectPath = resolve((flags.project as string) ?? process.cwd());
  const results = entities.search({ query, projectPath });

  if (!results.length) {
    console.log("No entities found.");
    return;
  }

  for (const e of results) {
    const aliases = e.aliases
      .filter((a) => a.alias_value !== e.canonical_name)
      .map((a) => `${a.alias_type}:${a.alias_value}`)
      .join(", ");
    const aliasStr = aliases ? ` (${aliases})` : "";
    console.log(
      `[${e.id.slice(0, 16)}] ${e.entity_type}: ${e.canonical_name}${aliasStr}`,
    );
  }
}

async function cmdDelete(
  args: string[],
  _flags: Record<string, unknown>,
): Promise<void> {
  const id = args[0];
  if (!id) {
    console.error("Usage: lore entity delete <id>");
    process.exit(1);
  }

  const { entities } = await import("@loreai/core");
  const entity = entities.get(id);
  if (!entity) {
    console.error(`Entity not found: ${id}`);
    process.exit(1);
  }

  entities.remove(id);
  console.log(`Deleted entity: ${entity.canonical_name} (${id})`);
}

// ---------------------------------------------------------------------------
// dedup — find and merge duplicate entities
// ---------------------------------------------------------------------------

type EntityDedupResult = Awaited<
  ReturnType<typeof import("@loreai/core").entities.deduplicateEntities>
>;
type EntityDedupCluster = EntityDedupResult["merged"][number];

function printEntityClusters(
  clusters: EntityDedupCluster[],
  heading: string,
  apply: boolean,
): void {
  if (!clusters.length) return;
  console.log(`\n${heading}`);
  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i];
    const total = 1 + c.merged.length;
    console.log(`\nCluster ${i + 1} (${total} → 1):`);
    console.log(
      `  Keep:   ${c.surviving.name} (${c.surviving.id.slice(0, 8)}…)`,
    );
    for (const m of c.merged) {
      const verb = apply ? "Merge " : "Would merge";
      console.log(
        `  ${verb}: ${m.name} (${m.id.slice(0, 8)}…) [sim: ${m.similarity.toFixed(3)}]`,
      );
    }
  }
}

/** Prompt the user for a single-key choice. Returns the chosen key, or fallback on EOF. */
function promptChoice(
  message: string,
  choices: string[],
  fallback = "s",
): Promise<string> {
  return new Promise((resolveChoice) => {
    // Lazy import keeps CLI startup fast and avoids a top-level node:readline dep.
    const { createInterface } =
      require("node:readline") as typeof import("readline");
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    let resolved = false;
    const done = (v: string) => {
      if (resolved) return;
      resolved = true;
      rl.close();
      resolveChoice(v);
    };
    rl.on("close", () => {
      if (!resolved) {
        resolved = true;
        resolveChoice(fallback);
      }
    });
    const ask = () => {
      rl.question(message, (answer) => {
        const key = answer.trim().toLowerCase()[0] ?? "";
        if (choices.includes(key)) done(key);
        else ask();
      });
    };
    ask();
  });
}

async function cmdDedup(
  _args: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  const {
    entities,
    embedding: emb,
    projectId: getProjectId,
  } = await import("@loreai/core");

  const apply = !!flags.yes;
  const interactive = !!flags.interactive;
  const asJson = !!flags.json;
  const projectPath = flags.all
    ? undefined
    : resolve((flags.project as string) ?? process.cwd());

  if (interactive && apply) {
    console.error("--interactive and --yes are mutually exclusive.");
    process.exit(1);
  }
  if (interactive && !process.stdin.isTTY) {
    console.error("--interactive requires a TTY.");
    process.exit(1);
  }

  // Preflight: backfill missing entity embeddings so similarity has vectors.
  if (emb.isAvailable()) {
    try {
      const n = await emb.backfillEntityEmbeddings();
      if (n > 0) console.log(`Re-indexed ${n} entit${n === 1 ? "y" : "ies"}.`);
    } catch (err) {
      console.error(
        "Warning: entity embedding reindex failed, dedup will use name/alias signals only:",
        err,
      );
    }
  } else {
    console.log(
      "Note: no embedding provider available — using name/alias signals only.",
    );
  }

  const pid = projectPath ? (getProjectId(projectPath) ?? null) : null;

  // Calibration status line.
  const count = entities.getEntityDedupFeedbackCount(pid);
  const threshold = entities.loadEntityCalibratedThreshold(pid);
  if (threshold !== null) {
    console.log(
      `Using calibrated threshold ${threshold.toFixed(3)} (from ${count} feedback pairs, default: ${entities.ENTITY_EMBEDDING_DEDUP_THRESHOLD}).`,
    );
  } else if (count > 0) {
    console.log(
      `${count}/20 feedback samples collected. Threshold calibration activates after 20 samples.`,
    );
  }

  // Interactive mode: compute dry-run, prompt per cluster.
  if (interactive) {
    const result = await entities.deduplicateEntities(projectPath, {
      dryRun: true,
    });
    const clusters = [...result.merged, ...result.suggested];
    if (!clusters.length) {
      console.log("\nNo duplicate entities found.");
      return;
    }
    let mergedCount = 0;
    for (let i = 0; i < clusters.length; i++) {
      const c = clusters[i];
      console.log(`\nCluster ${i + 1} (${1 + c.merged.length} → 1):`);
      console.log(
        `  Keep: ${c.surviving.name} (${c.surviving.id.slice(0, 8)}…)`,
      );
      for (const m of c.merged) {
        console.log(
          `  Dup:  ${m.name} (${m.id.slice(0, 8)}…) [sim: ${m.similarity.toFixed(3)}]`,
        );
      }
      const choice = await promptChoice(
        "\n  [a]ccept merge / [r]eject (keep all) / [s]kip? ",
        ["a", "r", "s"],
      );
      if (choice === "a") {
        for (const m of c.merged) {
          entities.merge(c.surviving.id, m.id);
          entities.recordEntityDedupFeedback({
            projectId: pid,
            entryATitle: c.surviving.name,
            entryBTitle: m.name,
            similarity: m.similarity,
            accepted: true,
            source: "cli_interactive",
          });
          mergedCount++;
        }
      } else if (choice === "r") {
        for (const m of c.merged) {
          entities.recordEntityDedupFeedback({
            projectId: pid,
            entryATitle: c.surviving.name,
            entryBTitle: m.name,
            similarity: m.similarity,
            accepted: false,
            source: "cli_interactive",
          });
        }
      }
    }
    console.log(
      `\nMerged ${mergedCount} entit${mergedCount === 1 ? "y" : "ies"}.`,
    );
    const newThreshold = entities.calibrateEntityDedupThreshold(pid);
    if (newThreshold !== null) {
      const c = entities.getEntityDedupFeedbackCount(pid);
      entities.saveEntityCalibratedThreshold(pid, newThreshold, c);
      console.log(
        `Threshold calibrated to ${newThreshold.toFixed(3)} (from ${c} feedback pairs).`,
      );
    }
    return;
  }

  // Non-interactive: dry-run (default) or apply (--yes).
  const result = await entities.deduplicateEntities(projectPath, {
    dryRun: !apply,
  });

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          merged: result.merged,
          suggested: result.suggested,
          applied: apply,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (!result.merged.length && !result.suggested.length) {
    console.log("\nNo duplicate entities found.");
    return;
  }

  printEntityClusters(
    result.merged,
    apply ? "Auto-merged:" : "Auto-merge candidates (use --yes to apply):",
    apply,
  );
  printEntityClusters(
    result.suggested,
    "Suggestions (moderate confidence — review with `lore entity merge`):",
    false,
  );

  if (apply) {
    let mergedCount = 0;
    for (const c of result.merged) {
      for (const m of c.merged) {
        entities.recordEntityDedupFeedback({
          projectId: pid,
          entryATitle: c.surviving.name,
          entryBTitle: m.name,
          similarity: m.similarity,
          accepted: true,
          source: "cli_yes",
        });
        mergedCount++;
      }
    }
    console.log(
      `\nMerged ${mergedCount} entit${mergedCount === 1 ? "y" : "ies"}.`,
    );
    const newThreshold = entities.calibrateEntityDedupThreshold(pid);
    if (newThreshold !== null) {
      const c = entities.getEntityDedupFeedbackCount(pid);
      entities.saveEntityCalibratedThreshold(pid, newThreshold, c);
      console.log(
        `Threshold calibrated to ${newThreshold.toFixed(3)} (from ${c} feedback pairs).`,
      );
    }
  } else {
    console.log("\nRun with --yes to apply auto-merges.");
  }
}

// ---------------------------------------------------------------------------
// Help & dispatch
// ---------------------------------------------------------------------------

const ENTITY_HELP = `
lore entity — manage the entity registry

Subcommands:
  list                                 List all entities
  show <id>                            Show entity detail with aliases
  add <type> <name>                    Create a new entity
  edit <id>                            Edit an entity
  alias add <id> --type <t> --value <v>  Add an alias
  alias rm <alias-id>                  Remove an alias
  relation add <a-id> <b-id> --relation <type>  Add a relation
  relation rm <relation-id>            Remove a relation
  merge <target-id> <source-id>        Merge two entities
  dedup                                Find/merge duplicate entities
  search <query>                       Search entities
  delete <id>                          Delete an entity

Entity types: person, org, service, tool, repo, infra
Alias types: name, email, github, slack, phone, nickname, url, domain

Options:
  --project <path>   Project path (default: cwd)
  --all              All entities, ignore project scope (list, dedup)
  --json             Output as JSON (list, dedup)
  --metadata <json>  JSON metadata (add, edit, relation add)
  --name <name>      New name (edit only)
  --cross            Cross-project flag (add, edit)
  --yes, -y          Apply auto-merges (dedup)
  --interactive, -i  Accept/reject each cluster (dedup)

Examples:
  lore entity dedup                    # dry-run: show duplicate clusters
  lore entity dedup --yes              # apply: auto-merge high-confidence dupes
  lore entity dedup --interactive      # decide per cluster
`.trim();

export async function commandEntity(
  args: string[],
  values: Record<string, unknown>,
): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case "list":
      await cmdList(subArgs, values);
      break;
    case "show":
      await cmdShow(subArgs, values);
      break;
    case "add":
      await cmdAdd(subArgs, values);
      break;
    case "edit":
      await cmdEdit(subArgs, values);
      break;
    case "alias": {
      const aliasCmd = subArgs[0];
      const aliasArgs = subArgs.slice(1);
      if (aliasCmd === "add") {
        await cmdAliasAdd(aliasArgs, values);
      } else if (aliasCmd === "rm" || aliasCmd === "remove") {
        await cmdAliasRm(aliasArgs, values);
      } else {
        console.error(`Unknown alias subcommand: ${aliasCmd}`);
        console.log("Usage: lore entity alias add|rm ...");
        process.exit(1);
      }
      break;
    }
    case "relation": {
      const relCmd = subArgs[0];
      const relArgs = subArgs.slice(1);
      if (relCmd === "add") {
        await cmdRelationAdd(relArgs, values);
      } else if (relCmd === "rm" || relCmd === "remove") {
        await cmdRelationRm(relArgs, values);
      } else {
        console.error(`Unknown relation subcommand: ${relCmd}`);
        console.log("Usage: lore entity relation add|rm ...");
        process.exit(1);
      }
      break;
    }
    case "merge":
      await cmdMerge(subArgs, values);
      break;
    case "dedup":
      await cmdDedup(subArgs, values);
      break;
    case "search":
      await cmdSearch(subArgs, values);
      break;
    case "delete":
      await cmdDelete(subArgs, values);
      break;
    case "help":
    case undefined:
      console.log(ENTITY_HELP);
      break;
    default:
      console.error(`Unknown subcommand "${subcommand}".`);
      console.log(ENTITY_HELP);
      process.exit(1);
  }
}
