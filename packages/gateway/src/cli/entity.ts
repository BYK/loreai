/**
 * CLI `lore entity` command — manage the entity registry.
 *
 * Subcommands:
 *   list                         List all entities with aliases
 *   show <id>                    Show full detail for an entity
 *   add <type> <name>            Create a new entity
 *   alias add <id> --type <t> --value <v>   Add an alias to an entity
 *   alias rm <alias-id>          Remove an alias
 *   merge <target-id> <source-id>  Merge two entities
 *   search <query>               Search entities by name or alias
 *   delete <id>                  Delete an entity
 */
import { resolve } from "path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
}

function padRight(str: string, len: number): string {
  return str.length >= len ? str.slice(0, len) : str + " ".repeat(len - str.length);
}

function printTable(
  headers: string[],
  rows: string[][],
  widths: number[],
): void {
  const header = headers
    .map((h, i) => padRight(h, widths[i]))
    .join("  ");
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
  args: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  const { entities } = await import("@loreai/core");
  const projectPath = resolve((flags.project as string) ?? process.cwd());
  const asJson = !!flags.json;

  const all = flags.all
    ? entities.listAll()
    : entities.forProject(projectPath);

  if (asJson) {
    console.log(JSON.stringify(all, null, 2));
    return;
  }

  if (!all.length) {
    console.log("No entities found.");
    return;
  }

  const rows = all.map((e) => {
    const aliasCount = e.aliases.filter((a) => a.alias_value !== e.canonical_name).length;
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
      console.log(`  ${a.alias_type}: ${a.alias_value}${src}  (${a.id.slice(0, 12)})`);
    }
  }

  // Show linked knowledge entries
  const knowledgeIds = entities.knowledgeForEntity(entity.id);
  if (knowledgeIds.length > 0) {
    console.log(`\nLinked knowledge entries (${knowledgeIds.length}):`);
    for (const kid of knowledgeIds) {
      const entry = ltm.get(kid);
      if (entry) {
        console.log(`  [${entry.id.slice(0, 16)}] (${entry.category}) ${entry.title}`);
      }
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

  const result = entities.create({
    projectPath,
    entityType: entityType as (typeof entities.ENTITY_TYPES)[number],
    canonicalName: name,
    crossProject: cross,
  });

  if (result.created) {
    console.log(`Created entity: ${result.id}`);
  } else {
    console.log(`Entity already exists: ${result.id}`);
  }
  console.log(`  Type: ${entityType}`);
  console.log(`  Name: ${name}`);
}

async function cmdAliasAdd(
  args: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  const entityId = args[0];
  const aliasType = flags.type as string;
  const aliasValue = flags.value as string;

  if (!entityId || !aliasType || !aliasValue) {
    console.error("Usage: lore entity alias add <entity-id> --type <type> --value <value>");
    console.error("Alias types: name, email, github, slack, phone, nickname, url, domain");
    process.exit(1);
  }

  const { entities } = await import("@loreai/core");

  const ALIAS_TYPES = ["name", "email", "github", "slack", "phone", "nickname", "url", "domain"] as const;
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

  const id = entities.addAlias(entityId, aliasType as (typeof ALIAS_TYPES)[number], aliasValue, "manual");
  if (id) {
    console.log(`Added alias: ${aliasType}:${aliasValue} → ${entity.canonical_name}`);
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

  const { entities } = await import("@loreai/core");
  entities.removeAlias(aliasId);
  console.log(`Removed alias: ${aliasId}`);
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
  console.log(`Merged "${source.canonical_name}" into "${target.canonical_name}"`);
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
    console.log(`[${e.id.slice(0, 16)}] ${e.entity_type}: ${e.canonical_name}${aliasStr}`);
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
// Help & dispatch
// ---------------------------------------------------------------------------

const ENTITY_HELP = `
lore entity — manage the entity registry

Subcommands:
  list                                 List all entities
  show <id>                            Show entity detail with aliases
  add <type> <name>                    Create a new entity
  alias add <id> --type <t> --value <v>  Add an alias
  alias rm <alias-id>                  Remove an alias
  merge <target-id> <source-id>        Merge two entities
  search <query>                       Search entities
  delete <id>                          Delete an entity

Entity types: person, org, service, tool, repo, infra
Alias types: name, email, github, slack, phone, nickname, url, domain

Options:
  --project <path>   Project path (default: cwd)
  --all              List all entities (ignore project scope)
  --json             Output as JSON (list only)
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
    case "merge":
      await cmdMerge(subArgs, values);
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
