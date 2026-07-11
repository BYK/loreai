/**
 * CLI `lore data` command — inspect and manage stored data.
 *
 * Subcommands:
 *   list <type>           List entries (projects, knowledge, sessions, distillations)
 *   show <type> <id>      Show full detail for an entry
 *   clear [options]       Clear data for a project or wipe the database
 *   delete <type> <id>    Delete a single entry (type: knowledge, session, distillation, project)
 *   move <type> <id..>    Move session(s) or knowledge to another project (--to required)
 *   split                 Auto-suggest & move mis-grouped sessions to correct projects
 *   export                Regenerate .lore.md / AGENTS.md from the DB for a project
 *
 * When `LORE_REMOTE_URL` is set, most subcommands delegate to the remote
 * gateway REST API instead of accessing the local database.
 */
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import {
  getRemoteUrl,
  projectQueryParams,
  remoteGet,
  remotePost,
  remoteDelete,
} from "./remote";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
}

function truncate(str: string, max: number): string {
  const oneLine = str.replace(/\n/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}\u2026`;
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

async function confirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.error(
      "Error: Cannot prompt for confirmation in non-TTY mode. Use --yes to skip.",
    );
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise<boolean>((resolve) => {
    rl.question(`${message}\nType "yes" to confirm: `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "yes");
    });
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function cmdList(
  args: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  const remote = getRemoteUrl();
  if (remote) return cmdListRemote(remote, args, flags);

  const { data, ltm } = await import("@loreai/core");
  const type = args[0];
  const limit = flags.limit ? Number(flags.limit) : 50;
  const asJson = !!flags.json;
  const projectPath = resolve((flags.project as string) ?? process.cwd());

  switch (type) {
    case "projects": {
      const projects = data.listProjects();
      if (asJson) {
        console.log(JSON.stringify(projects, null, 2));
        return;
      }
      if (!projects.length) {
        console.log("No projects found.");
        return;
      }
      printTable(
        [
          "Name",
          "Path",
          "Git Remote",
          "ID",
          "Knowledge",
          "Sessions",
          "Created",
        ],
        projects.map((p) => [
          p.name ?? "(unnamed)",
          truncate(p.path, 35),
          truncate(p.git_remote ?? "-", 30),
          p.id.slice(0, 8),
          String(p.knowledge_count),
          String(p.session_count),
          formatDate(p.created_at),
        ]),
        [16, 35, 30, 10, 10, 10, 20],
      );
      break;
    }

    case "knowledge": {
      const entries = ltm.forProject(projectPath, false);
      const limited = entries.slice(0, limit);
      if (asJson) {
        console.log(JSON.stringify(limited, null, 2));
        return;
      }
      if (!limited.length) {
        console.log("No knowledge entries found for this project.");
        return;
      }
      printTable(
        ["Category", "Title", "Confidence", "Updated", "ID"],
        limited.map((e) => [
          e.category,
          truncate(e.title, 40),
          e.confidence.toFixed(2),
          formatDate(e.updated_at),
          e.logical_id.slice(0, 8), // stable id (A2): show/delete/move resolve by logical_id
        ]),
        [14, 40, 12, 20, 10],
      );
      break;
    }

    case "sessions": {
      const sessions = data.listSessions(projectPath, limit);
      if (asJson) {
        console.log(JSON.stringify(sessions, null, 2));
        return;
      }
      if (!sessions.length) {
        console.log("No sessions found for this project.");
        return;
      }
      printTable(
        [
          "Session ID",
          "Messages",
          "Distilled",
          "Distillations",
          "First",
          "Last",
        ],
        sessions.map((s) => [
          s.session_id.slice(0, 12),
          String(s.message_count),
          String(s.distilled_count),
          String(s.distillation_count),
          formatDate(s.first_message_at),
          formatDate(s.last_message_at),
        ]),
        [14, 10, 10, 14, 20, 20],
      );
      break;
    }

    case "distillations": {
      const dists = data.listDistillations(projectPath, { limit });
      if (asJson) {
        console.log(JSON.stringify(dists, null, 2));
        return;
      }
      if (!dists.length) {
        console.log("No distillations found for this project.");
        return;
      }
      printTable(
        [
          "Session",
          "Gen",
          "Tokens",
          "R_comp",
          "C_norm",
          "Archived",
          "Created",
          "ID",
        ],
        dists.map((d) => [
          d.session_id.slice(0, 12),
          String(d.generation),
          String(d.token_count),
          d.r_compression?.toFixed(2) ?? "-",
          d.c_norm?.toFixed(2) ?? "-",
          d.archived ? "yes" : "no",
          formatDate(d.created_at),
          d.id.slice(0, 8),
        ]),
        [14, 5, 8, 8, 8, 10, 20, 10],
      );
      break;
    }

    default:
      console.error(
        `Unknown type "${type ?? "(none)"}". Use: projects, knowledge, sessions, distillations`,
      );
      process.exit(1);
  }
}

async function cmdShow(
  args: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  const remote = getRemoteUrl();
  if (remote) return cmdShowRemote(remote, args, flags);

  const { data, ltm, temporal } = await import("@loreai/core");
  const type = args[0];
  const rawId = args[1];
  const asJson = !!flags.json;
  const projectPath = resolve((flags.project as string) ?? process.cwd());

  if (!rawId) {
    console.error("Error: Missing <id> argument.");
    process.exit(1);
  }

  switch (type) {
    case "knowledge": {
      const id = data.resolveId("knowledge", rawId) ?? rawId;
      // Resolve to the current version via the stable logical_id (A2, #823).
      const entry = ltm.get(id) ?? ltm.getByLogical(ltm.logicalIdOf(id));
      if (!entry) {
        console.error(`Knowledge entry not found: ${rawId}`);
        process.exit(1);
      }
      if (asJson) {
        console.log(JSON.stringify(entry, null, 2));
        return;
      }
      console.log(`ID:          ${entry.id}`);
      console.log(`Category:    ${entry.category}`);
      console.log(`Title:       ${entry.title}`);
      console.log(`Confidence:  ${entry.confidence}`);
      const impact = ltm.outcomeImpact(entry.logical_id);
      if (impact.passes || impact.fails) {
        console.log(
          `Outcome:     ${impact.passes} passed / ${impact.fails} failed sessions`,
        );
      }
      const refs = ltm.refValidity(entry.logical_id);
      if (refs) {
        console.log(
          `References:  ${refs.total - refs.broken}/${refs.total} resolve` +
            `${refs.broken > 0 ? ` (${refs.broken} broken)` : ""}` +
            ` (last checked ${formatDate(refs.checkedAt)})`,
        );
      }
      console.log(`Project ID:  ${entry.project_id ?? "(global)"}`);
      console.log(`Cross-proj:  ${entry.cross_project ? "yes" : "no"}`);
      console.log(`Session:     ${entry.source_session ?? "(none)"}`);
      console.log(`Created:     ${formatDate(entry.created_at)}`);
      console.log(`Updated:     ${formatDate(entry.updated_at)}`);
      if (entry.metadata) {
        console.log(`Metadata:    ${JSON.stringify(entry.metadata)}`);
      }
      console.log(`\nContent:\n${entry.content}`);
      break;
    }

    case "session": {
      const sessions = data.listSessions(projectPath, 1000);
      // Find session by prefix match
      const session = sessions.find((s) => s.session_id.startsWith(rawId));
      if (!session) {
        console.error(`Session not found: ${rawId}`);
        process.exit(1);
      }
      const messages = temporal.bySession(projectPath, session.session_id);
      const dists = data.listDistillations(projectPath, {
        sessionId: session.session_id,
      });

      if (asJson) {
        console.log(
          JSON.stringify({ session, messages, distillations: dists }, null, 2),
        );
        return;
      }

      console.log(`Session:       ${session.session_id}`);
      console.log(`Messages:      ${session.message_count}`);
      console.log(`Distilled:     ${session.distilled_count}`);
      console.log(`Undistilled:   ${session.undistilled_count}`);
      console.log(`Distillations: ${session.distillation_count}`);
      console.log(`First:         ${formatDate(session.first_message_at)}`);
      console.log(`Last:          ${formatDate(session.last_message_at)}`);

      if (messages.length) {
        console.log(`\n--- Messages (${messages.length}) ---\n`);
        for (const msg of messages) {
          const prefix = msg.role === "user" ? ">" : "<";
          console.log(
            `${prefix} [${formatDate(msg.created_at)}] ${msg.role}: ${truncate(msg.content, 120)}`,
          );
        }
      }

      if (dists.length) {
        console.log(`\n--- Distillations (${dists.length}) ---\n`);
        for (const d of dists) {
          console.log(
            `  gen=${d.generation} tokens=${d.token_count} ${formatDate(d.created_at)} ${d.id.slice(0, 8)}`,
          );
        }
      }
      break;
    }

    case "distillation": {
      const id = data.resolveId("distillations", rawId) ?? rawId;
      const dist = data.getDistillation(id);
      if (!dist) {
        console.error(`Distillation not found: ${rawId}`);
        process.exit(1);
      }
      if (asJson) {
        console.log(JSON.stringify(dist, null, 2));
        return;
      }
      console.log(`ID:            ${dist.id}`);
      console.log(`Session:       ${dist.session_id}`);
      console.log(`Project ID:    ${dist.project_id}`);
      console.log(`Generation:    ${dist.generation}`);
      console.log(`Tokens:        ${dist.token_count}`);
      console.log(`R_compression: ${dist.r_compression?.toFixed(3) ?? "-"}`);
      console.log(`C_norm:        ${dist.c_norm?.toFixed(3) ?? "-"}`);
      console.log(`Archived:      ${dist.archived ? "yes" : "no"}`);
      console.log(`Created:       ${formatDate(dist.created_at)}`);
      console.log(`Source IDs:    ${dist.source_ids}`);
      console.log(`\nObservations:\n${dist.observations}`);
      break;
    }

    default:
      console.error(
        `Unknown type "${type ?? "(none)"}". Use: knowledge, session, distillation`,
      );
      process.exit(1);
  }
}

async function cmdClear(
  _args: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  const remote = getRemoteUrl();
  const skipConfirm = !!flags.yes;

  // Nuclear option: wipe entire database (local-only)
  if (flags.all) {
    if (remote) {
      console.error(
        "Error: --all (wipe entire database) is not supported in remote mode.",
      );
      process.exit(1);
    }
    const { data } = await import("@loreai/core");
    if (!skipConfirm) {
      const stats = data.globalStats();
      const confirmed = await confirm(
        `\nWARNING: This will permanently delete ALL Lore data:\n` +
          `  ${stats.project_count} projects, ${stats.knowledge_count} knowledge entries,\n` +
          `  ${stats.message_count} messages, ${stats.distillation_count} distillations\n` +
          `  Database: ${formatBytes(stats.db_size_bytes)}\n`,
      );
      if (!confirmed) {
        console.log("Cancelled.");
        return;
      }
    }
    const dbFile = data.wipeDatabase();
    console.log(`Database wiped: ${dbFile}`);
    console.log(
      "Note: Remove or regenerate .lore.md in your project directories to prevent re-import from git.",
    );
    return;
  }

  const projectPath = resolve((flags.project as string) ?? process.cwd());

  if (remote) return cmdClearRemote(remote, projectPath, flags);

  const { data } = await import("@loreai/core");
  const onlyKnowledge = !!flags.knowledge;
  const onlyTemporal = !!flags.temporal;
  const onlyDistillations = !!flags.distillations;
  const specific = onlyKnowledge || onlyTemporal || onlyDistillations;

  if (specific) {
    // Collect counts once and build a single confirmation prompt
    const counts = data.countForProject(projectPath);
    const targets: string[] = [];
    if (onlyKnowledge) targets.push(`${counts.knowledge} knowledge entries`);
    if (onlyTemporal) targets.push(`${counts.messages} temporal messages`);
    if (onlyDistillations)
      targets.push(`${counts.distillations} distillations`);

    if (!skipConfirm) {
      const confirmed = await confirm(
        `\nThis will delete the following for project at:\n  ${projectPath}\n` +
          targets.map((t) => `  - ${t}`).join("\n") +
          (onlyKnowledge ? "\n  The .lore.md file will be regenerated." : ""),
      );
      if (!confirmed) {
        console.log("Cancelled.");
        return;
      }
    }

    if (onlyKnowledge) {
      const deleted = data.clearKnowledge(projectPath);
      console.log(`Deleted ${deleted} knowledge entries.`);
      console.log(
        "Regenerated .lore.md \u2014 commit the change to prevent re-import from git.",
      );
    }
    if (onlyTemporal) {
      const deleted = data.clearTemporal(projectPath);
      console.log(`Deleted ${deleted} temporal messages.`);
    }
    if (onlyDistillations) {
      const deleted = data.clearDistillations(projectPath);
      console.log(`Deleted ${deleted} distillations.`);
    }
    return;
  }

  // Default: clear ALL data for the project
  const counts = data.countForProject(projectPath);
  if (!skipConfirm) {
    const confirmed = await confirm(
      `\nThis will permanently delete ALL data for project at:\n  ${projectPath}\n` +
        `  ${counts.knowledge} knowledge entries\n` +
        `  ${counts.messages} temporal messages (${counts.sessions} sessions)\n` +
        `  ${counts.distillations} distillations\n` +
        `The .lore.md file will be regenerated.`,
    );
    if (!confirmed) {
      console.log("Cancelled.");
      return;
    }
  }

  const result = data.clearProject(projectPath);
  console.log(
    `Cleared: ${result.knowledge_deleted} knowledge, ${result.temporal_deleted} messages, ${result.distillations_deleted} distillations.`,
  );
  console.log(
    "Regenerated .lore.md \u2014 commit the change to prevent re-import from git.",
  );
}

async function cmdDelete(
  args: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  const remote = getRemoteUrl();
  if (remote) return cmdDeleteRemote(remote, args, flags);

  const { data } = await import("@loreai/core");
  const type = args[0];
  const rawId = args[1];
  const skipConfirm = !!flags.yes;
  const projectPath = resolve((flags.project as string) ?? process.cwd());

  if (!rawId) {
    console.error("Error: Missing <id> argument.");
    process.exit(1);
  }

  switch (type) {
    case "knowledge": {
      const id = data.resolveId("knowledge", rawId) ?? rawId;
      if (!skipConfirm) {
        const confirmed = await confirm(
          `\nDelete knowledge entry ${id.slice(0, 12)}...?`,
        );
        if (!confirmed) {
          console.log("Cancelled.");
          return;
        }
      }
      if (data.deleteKnowledge(id)) {
        console.log(`Deleted knowledge entry: ${id}`);
      } else {
        console.error(`Knowledge entry not found: ${rawId}`);
        process.exit(1);
      }
      break;
    }

    case "session": {
      if (!skipConfirm) {
        const confirmed = await confirm(
          `\nDelete all messages and distillations for session ${rawId}?`,
        );
        if (!confirmed) {
          console.log("Cancelled.");
          return;
        }
      }
      const result = data.deleteSession(projectPath, rawId);
      console.log(
        `Deleted: ${result.messages_deleted} messages, ${result.distillations_deleted} distillations.`,
      );
      break;
    }

    case "distillation": {
      const id = data.resolveId("distillations", rawId) ?? rawId;
      if (!skipConfirm) {
        const confirmed = await confirm(
          `\nDelete distillation ${id.slice(0, 12)}...?`,
        );
        if (!confirmed) {
          console.log("Cancelled.");
          return;
        }
      }
      if (data.deleteDistillation(id)) {
        console.log(`Deleted distillation: ${id}`);
      } else {
        console.error(`Distillation not found: ${rawId}`);
        process.exit(1);
      }
      break;
    }

    case "project": {
      const { projectId: resolveProjectId } = await import("@loreai/core");
      // rawId can be a project UUID or a filesystem path
      let id = rawId;
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          rawId,
        )
      ) {
        const resolved = resolveProjectId(resolve(rawId));
        if (!resolved) {
          console.error(`No project found for path: ${rawId}`);
          process.exit(1);
        }
        id = resolved;
      }
      // Validate existence before prompting for confirmation
      const project = data.listProjects().find((p) => p.id === id);
      if (!project) {
        console.error(`Project not found: ${rawId}`);
        process.exit(1);
      }
      if (!skipConfirm) {
        const confirmed = await confirm(
          `\nDelete project ${project.name ?? id.slice(0, 12)}... and ALL its data ` +
            `(${project.knowledge_count} knowledge, ${project.session_count} sessions, ` +
            `${project.distillation_count} distillations)?`,
        );
        if (!confirmed) {
          console.log("Cancelled.");
          return;
        }
      }
      const result = data.deleteProject(id);
      if (!result) {
        console.log(`Project not found: ${id}`);
        return;
      }
      console.log(
        `Deleted project: ${result.knowledge_deleted} knowledge, ` +
          `${result.temporal_deleted} messages, ` +
          `${result.distillations_deleted} distillations, ` +
          `${result.sessions_cleared} sessions.`,
      );
      break;
    }

    default:
      console.error(
        `Unknown type "${type ?? "(none)"}". Use: knowledge, session, distillation, project`,
      );
      process.exit(1);
  }
}

async function cmdRecover(
  _args: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  const remote = getRemoteUrl();
  if (remote) {
    console.error(
      "Error: recover is not supported in remote mode (requires local filesystem access).",
    );
    process.exit(1);
  }

  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const {
    data,
    importLoreFile,
    importFromFile,
    loreFileExists,
    clearLoreFileCache,
    LORE_FILE,
  } = await import("@loreai/core");
  const skipConfirm = !!flags.yes;
  const asJson = !!flags.json;

  const projects = data.listProjects();
  const recoverable: Array<{
    name: string | null;
    path: string;
    source: string; // ".lore.md" | "AGENTS.md" | "CLAUDE.md"
  }> = [];

  // Scan for recoverable files
  for (const project of projects) {
    if (!existsSync(project.path)) continue;

    if (loreFileExists(project.path)) {
      recoverable.push({
        name: project.name,
        path: project.path,
        source: LORE_FILE,
      });
    } else {
      // Check AGENTS.md, then CLAUDE.md
      for (const filename of ["AGENTS.md", "CLAUDE.md"]) {
        const filePath = join(project.path, filename);
        if (existsSync(filePath)) {
          recoverable.push({
            name: project.name,
            path: project.path,
            source: filename,
          });
          break; // prefer AGENTS.md over CLAUDE.md
        }
      }
    }
  }

  if (recoverable.length === 0) {
    console.log("No recoverable files found in any project directory.");
    return;
  }

  console.log(
    `Found ${recoverable.length} project(s) with recoverable knowledge files:\n`,
  );
  for (const r of recoverable) {
    console.log(`  ${r.name ?? r.path}  ← ${r.source}`);
  }
  console.log();

  if (!skipConfirm) {
    const confirmed = await confirm(
      `This will re-import knowledge entries from the files listed above.\n` +
        `Entries with existing UUIDs will be updated if changed.\n` +
        `New entries (unknown UUIDs or hand-written) will be created.`,
    );
    if (!confirmed) {
      console.log("Cancelled.");
      return;
    }
  }

  const results: Array<{
    name: string | null;
    path: string;
    source: string;
    before: number;
    after: number;
  }> = [];

  for (const r of recoverable) {
    const before = data.countForProject(r.path).knowledge;

    // Clear the file cache to ensure shouldImportLoreFile won't short-circuit
    clearLoreFileCache(r.path);

    if (r.source === LORE_FILE) {
      importLoreFile(r.path);
    } else {
      importFromFile({ projectPath: r.path, filePath: join(r.path, r.source) });
    }

    const after = data.countForProject(r.path).knowledge;
    results.push({
      name: r.name,
      path: r.path,
      source: r.source,
      before,
      after,
    });
  }

  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  console.log(`\nRecovery results:`);
  let totalImported = 0;
  for (const r of results) {
    const imported = r.after - r.before;
    totalImported += imported;
    const label = r.name ?? r.path;
    if (imported > 0) {
      console.log(
        `  ${padRight(label, 30)}  +${imported} entries (${r.before} → ${r.after}) from ${r.source}`,
      );
    } else {
      console.log(
        `  ${padRight(label, 30)}  no change (${r.after} entries) from ${r.source}`,
      );
    }
  }
  console.log(
    `\nTotal: ${totalImported} entries recovered across ${results.length} project(s).`,
  );

  // Re-rank recovered preference entries so they get proper confidence values
  const { ltm } = await import("@loreai/core");
  const reranked = ltm.rerankPreferences();
  if (reranked > 0) {
    console.log(
      `Re-ranked ${reranked} preference entries by directive strength.`,
    );
  }
}

async function cmdMerge(
  _args: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  const remote = getRemoteUrl();
  if (remote) return cmdMergeRemote(remote, flags);

  const { data } = await import("@loreai/core");
  const skipConfirm = !!flags.yes;
  const asJson = !!flags.json;

  // Dry run first: show what would be merged
  const projects = data.listProjects();
  const withoutRemote = projects.filter((p) => !p.git_remote);

  if (withoutRemote.length === 0) {
    console.log("All projects already have git remote information.");
    console.log("No merges needed.");
    return;
  }

  console.log(
    `Found ${withoutRemote.length} project(s) without git remote information.`,
  );
  console.log("Scanning git remotes...\n");

  if (!skipConfirm) {
    const confirmed = await confirm(
      `This will:\n` +
        `  1. Scan ${withoutRemote.length} project paths for git remote URLs\n` +
        `  2. Set git_remote on projects that are git repositories\n` +
        `  3. Merge projects that share the same git remote\n\n` +
        `Merged projects will have their data (knowledge, messages,\n` +
        `distillations) consolidated into a single project entry.`,
    );
    if (!confirmed) {
      console.log("Cancelled.");
      return;
    }
  }

  const result = data.backfillGitRemotes();

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`\nResults:`);
  console.log(`  Updated: ${result.updated} project(s) with git remote info`);
  console.log(`  Merged:  ${result.merged} duplicate project(s)`);
  console.log(`  Renamed: ${result.namesBackfilled} project(s) with repo name`);

  if (result.mergeDetails.length > 0) {
    console.log(`\nMerge details:`);
    for (const detail of result.mergeDetails) {
      console.log(`  ${detail.sourcePath}`);
      console.log(`    → merged into: ${detail.targetPath}`);
      console.log(`    git remote:    ${detail.gitRemote}`);
      console.log(
        `    moved: ${detail.result.knowledge_moved} knowledge, ` +
          `${detail.result.messages_moved} messages, ` +
          `${detail.result.distillations_moved} distillations`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// dedup — Deduplicate knowledge entries across all projects (or one)
// ---------------------------------------------------------------------------

/** Stable pair key for two entry IDs — mirrors ltm.dedupPairKey(). */
function pairKey(idA: string, idB: string): string {
  return idA < idB ? `${idA}:${idB}` : `${idB}:${idA}`;
}

function printDedupResult(
  result: Awaited<ReturnType<typeof import("@loreai/core").ltm.deduplicate>>,
  apply: boolean,
  label?: string,
): void {
  if (label) console.log(`\n--- ${label} ---\n`);

  for (let i = 0; i < result.clusters.length; i++) {
    const cluster = result.clusters[i];
    const total = 1 + cluster.merged.length;
    console.log(`Cluster ${i + 1} (${total} entries → 1):`);
    console.log(
      `  Keep:   "${truncate(cluster.surviving.title, 70)}" (${cluster.surviving.id.slice(0, 8)}…)`,
    );
    for (const m of cluster.merged) {
      const pk = pairKey(cluster.surviving.id, m.id);
      const sim = result.pairSimilarities.get(pk);
      const simStr = sim != null ? ` [sim: ${sim.toFixed(3)}]` : "";
      console.log(
        `  ${apply ? "Remove" : "Would remove"}: "${truncate(m.title, 55)}" (${m.id.slice(0, 8)}…)${simStr}`,
      );
    }
    console.log();
  }
}

/** Prompt the user for a single-key choice. Returns the chosen key, or "s" on EOF/close. */
function promptChoice(
  message: string,
  choices: string[],
  fallback = "s",
): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    let resolved = false;
    rl.on("close", () => {
      if (!resolved) {
        resolved = true;
        resolve(fallback);
      }
    });
    const ask = () => {
      rl.question(message, (answer) => {
        if (resolved) return;
        const trimmed = answer.trim().toLowerCase();
        if (choices.includes(trimmed)) {
          resolved = true;
          rl.close();
          resolve(trimmed);
        } else {
          ask(); // re-prompt on invalid input
        }
      });
    };
    ask();
  });
}

/**
 * `lore data contradictions` — list open contradictions detected between
 * knowledge entries (#1123). Read-only surface; resolve them on the dashboard
 * (/ui/knowledge) or by editing/removing one side of the pair.
 */
async function cmdContradictions(
  _args: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  const { ltm } = await import("@loreai/core");
  const asJson = !!flags.json;
  const projectPath = resolve((flags.project as string) ?? process.cwd());
  const items = ltm.listOpenContradictions(projectPath);

  if (asJson) {
    console.log(JSON.stringify(items, null, 2));
    return;
  }
  if (!items.length) {
    console.log("No open contradictions.");
    return;
  }

  console.log(`${items.length} open contradiction(s):\n`);
  for (const c of items) {
    console.log(`  "${c.titleA}"`);
    console.log(`    vs "${c.titleB}"`);
    if (c.rationale) console.log(`    reason: ${c.rationale}`);
    console.log(
      `    similarity ${c.similarity.toFixed(3)}   detected ${formatDate(c.detectedAt)}`,
    );
    console.log("");
  }
  console.log(
    "Resolve in the dashboard (/ui/knowledge), or edit/remove one side to clear it.",
  );
}

async function cmdDedup(
  _args: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  const remote = getRemoteUrl();
  if (remote) return cmdDedupRemote(remote, flags);

  const {
    ltm,
    data,
    projectId: getProjectId,
    embedding: emb,
  } = await import("@loreai/core");
  const apply = !!flags.yes;
  const interactive = !!flags.interactive;
  const asJson = !!flags.json;
  const explicitProject =
    typeof flags.project === "string" ? resolve(flags.project) : null;

  if (interactive && apply) {
    console.error("Error: --interactive and --yes are mutually exclusive.");
    process.exit(1);
  }

  if (interactive && !process.stdin.isTTY) {
    console.error(
      "Error: --interactive requires a TTY. Use --yes for non-interactive.",
    );
    process.exit(1);
  }

  // Determine which projects to process. Skip synthetic test paths (/test/...)
  // that may have leaked into the production DB via raw-SQL test inserts —
  // ensureProject() refuses to resolve them (db.ts guard) and would otherwise
  // abort the entire dedup run for one bad row.
  const projects = explicitProject
    ? [{ path: explicitProject, name: explicitProject }]
    : data
        .listProjects()
        .filter((p) => !p.path.startsWith("/test/"))
        .map((p) => ({ path: p.path, name: p.name ?? p.path }));

  if (projects.length === 0) {
    console.log("No projects found.");
    return;
  }

  // Auto-reindex if embedding config changed (e.g. model migration)
  // or if there are entries missing embeddings. backfillEmbeddings()
  // calls checkConfigChange() internally — no need to call it separately.
  if (emb.isAvailable()) {
    try {
      const knowledgeCount = await emb.backfillEmbeddings();
      // Also backfill distillations — checkConfigChange() inside
      // backfillEmbeddings() may have NULLed their embeddings too.
      const distillCount = await emb.backfillDistillationEmbeddings();
      const total = knowledgeCount + distillCount;
      if (total > 0) {
        console.log(
          `Re-indexed ${total} entries (${knowledgeCount} knowledge, ${distillCount} distillations).\n`,
        );
      }
    } catch (err) {
      console.error(
        "Warning: embedding reindex failed, dedup will use title-overlap only:",
        err,
      );
    }
  }

  // Display calibration status for each project
  for (const project of projects) {
    const pid = getProjectId(project.path);
    if (!pid) continue;
    const count = ltm.getDedupFeedbackCount(pid);
    const threshold = ltm.loadCalibratedThreshold(pid);
    if (threshold !== null) {
      console.log(
        `[${project.name}] Using calibrated threshold ${threshold.toFixed(3)} (from ${count} feedback pairs, default: 0.935).`,
      );
    } else if (count > 0) {
      console.log(
        `[${project.name}] ${count}/20 feedback samples collected. Threshold calibration activates after 20 samples.`,
      );
    }
  }

  // Interactive mode: dry-run first, then prompt per cluster
  if (interactive) {
    await cmdDedupInteractive(projects, explicitProject, ltm, getProjectId);
    return;
  }

  if (!apply) {
    console.log("Scanning for duplicate knowledge entries (dry run)...\n");
  } else {
    console.log("Deduplicating knowledge entries...\n");
  }

  let grandTotalRemoved = 0;
  let grandTotalClusters = 0;
  const allResults: Array<{
    name: string;
    path: string;
    result: Awaited<ReturnType<typeof ltm.deduplicate>>;
  }> = [];

  for (const project of projects) {
    let result: Awaited<ReturnType<typeof ltm.deduplicate>>;
    try {
      result = await ltm.deduplicate(project.path, { dryRun: !apply });
    } catch (err) {
      console.error(
        `Warning: skipping project "${project.name}": ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (result.clusters.length > 0) {
      allResults.push({ name: project.name, path: project.path, result });
      grandTotalRemoved += result.totalRemoved;
      grandTotalClusters += result.clusters.length;
    }
  }

  // Also dedup global (cross-project) entries
  const globalResult = await ltm.deduplicateGlobal({ dryRun: !apply });
  if (globalResult.clusters.length > 0) {
    allResults.push({ name: "Global", path: "", result: globalResult });
    grandTotalRemoved += globalResult.totalRemoved;
    grandTotalClusters += globalResult.clusters.length;
  }

  if (grandTotalClusters === 0) {
    console.log("No duplicates found.");
    return;
  }

  if (asJson) {
    // Map is not JSON-serializable — convert to plain objects.
    const serializable = allResults.map((r) => ({
      ...r,
      result: {
        ...r.result,
        pairSimilarities: Object.fromEntries(r.result.pairSimilarities),
        entryTitles: Object.fromEntries(r.result.entryTitles),
      },
    }));
    console.log(JSON.stringify(serializable, null, 2));
    return;
  }

  const multiProject =
    allResults.length > 1 || (!explicitProject && projects.length > 1);
  for (const { name, result } of allResults) {
    printDedupResult(result, apply, multiProject ? name : undefined);
  }

  console.log(
    `${apply ? "Removed" : "Would remove"} ${grandTotalRemoved} duplicate entries ` +
      `across ${grandTotalClusters} clusters` +
      (multiProject ? ` in ${allResults.length} projects.` : "."),
  );

  // Record feedback and recalibrate when --yes is used
  if (apply) {
    for (const { name, path, result } of allResults) {
      const pid = name === "Global" ? null : (getProjectId(path) ?? null);
      ltm.recordDedupResultFeedback(pid, result, true, "cli_yes");
    }
    // Recalibrate per project
    const calibratedProjects = new Set<string | null>();
    for (const { name, path } of allResults) {
      const pid = name === "Global" ? null : (getProjectId(path) ?? null);
      if (calibratedProjects.has(pid)) continue;
      calibratedProjects.add(pid);
      const newThreshold = ltm.calibrateDedupThreshold(pid);
      if (newThreshold !== null) {
        const count = ltm.getDedupFeedbackCount(pid);
        ltm.saveCalibratedThreshold(pid, newThreshold, count);
        console.log(
          `Threshold calibrated to ${newThreshold.toFixed(3)} (from ${count} feedback pairs).`,
        );
      }
    }
  }

  if (!apply) {
    console.log(
      "\nRun with --yes to apply, or --interactive for per-cluster review.",
    );
  }
}

/**
 * Interactive dedup: dry-run first, then prompt the user per cluster
 * for accept/reject/skip decisions. Records feedback for calibration.
 */
async function cmdDedupInteractive(
  projects: Array<{ path: string; name: string }>,
  explicitProject: string | null,
  ltm: typeof import("@loreai/core").ltm,
  getProjectId: typeof import("@loreai/core").projectId,
): Promise<void> {
  console.log(
    "Scanning for duplicate knowledge entries (interactive mode)...\n",
  );

  // Collect all clusters across projects (dry run)
  type ProjectCluster = {
    projectName: string;
    projectPath: string;
    cluster: Awaited<ReturnType<typeof ltm.deduplicate>>["clusters"][number];
    pairSimilarities: Map<string, number>;
  };
  const allClusters: ProjectCluster[] = [];

  for (const project of projects) {
    let result: Awaited<ReturnType<typeof ltm.deduplicate>>;
    try {
      result = await ltm.deduplicate(project.path, { dryRun: true });
    } catch (err) {
      console.error(
        `Warning: skipping project "${project.name}": ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    for (const cluster of result.clusters) {
      allClusters.push({
        projectName: project.name,
        projectPath: project.path,
        cluster,
        pairSimilarities: result.pairSimilarities,
      });
    }
  }

  // Global entries
  const globalResult = await ltm.deduplicateGlobal({ dryRun: true });
  for (const cluster of globalResult.clusters) {
    allClusters.push({
      projectName: "Global",
      projectPath: "",
      cluster,
      pairSimilarities: globalResult.pairSimilarities,
    });
  }

  if (allClusters.length === 0) {
    console.log("No duplicates found.");
    return;
  }

  let acceptedCount = 0;
  let rejectedCount = 0;
  let skippedCount = 0;
  let removedCount = 0;
  const multiProject =
    allClusters.length > 1 || (!explicitProject && projects.length > 1);

  for (let i = 0; i < allClusters.length; i++) {
    const { projectName, projectPath, cluster, pairSimilarities } =
      allClusters[i];
    const total = 1 + cluster.merged.length;

    if (multiProject) console.log(`--- ${projectName} ---`);
    console.log(
      `\nCluster ${i + 1} of ${allClusters.length} (${total} entries → 1):`,
    );
    console.log(
      `  Keep:   "${truncate(cluster.surviving.title, 70)}" (${cluster.surviving.id.slice(0, 8)}…)`,
    );
    for (const m of cluster.merged) {
      const pk = pairKey(cluster.surviving.id, m.id);
      const sim = pairSimilarities.get(pk);
      const simStr = sim != null ? ` [sim: ${sim.toFixed(3)}]` : "";
      console.log(
        `  Merge:  "${truncate(m.title, 55)}" (${m.id.slice(0, 8)}…)${simStr}`,
      );
    }

    const answer = await promptChoice(
      "\n  [a]ccept merge / [r]eject (keep all) / [s]kip? ",
      ["a", "r", "s"],
    );
    const pid =
      projectName === "Global" ? null : (getProjectId(projectPath) ?? null);

    if (answer === "a") {
      // Apply merge: remove merged entries
      for (const m of cluster.merged) {
        ltm.remove(m.id);
      }
      // Record accept feedback
      for (const m of cluster.merged) {
        const pk = pairKey(cluster.surviving.id, m.id);
        const sim = pairSimilarities.get(pk);
        if (sim != null && sim > 0) {
          ltm.recordDedupFeedback({
            projectId: pid,
            entryATitle: cluster.surviving.title,
            entryBTitle: m.title,
            similarity: sim,
            accepted: true,
            source: "cli_interactive",
          });
        }
      }
      acceptedCount++;
      removedCount += cluster.merged.length;
      console.log(`  → Merged (${cluster.merged.length} entries removed).`);
    } else if (answer === "r") {
      // Record reject feedback (don't delete anything)
      for (const m of cluster.merged) {
        const pk = pairKey(cluster.surviving.id, m.id);
        const sim = pairSimilarities.get(pk);
        if (sim != null && sim > 0) {
          ltm.recordDedupFeedback({
            projectId: pid,
            entryATitle: cluster.surviving.title,
            entryBTitle: m.title,
            similarity: sim,
            accepted: false,
            source: "cli_interactive",
          });
        }
      }
      rejectedCount++;
      console.log("  → Kept separate.");
    } else {
      skippedCount++;
      console.log("  → Skipped.");
    }
  }

  console.log(
    `\nDone: ${acceptedCount} accepted (${removedCount} entries removed), ` +
      `${rejectedCount} rejected, ${skippedCount} skipped.`,
  );

  // Recalibrate per project after interactive session
  const calibratedProjects = new Set<string | null>();
  for (const { projectName, projectPath } of allClusters) {
    const pid =
      projectName === "Global" ? null : (getProjectId(projectPath) ?? null);
    if (calibratedProjects.has(pid)) continue;
    calibratedProjects.add(pid);
    const newThreshold = ltm.calibrateDedupThreshold(pid);
    if (newThreshold !== null) {
      const count = ltm.getDedupFeedbackCount(pid);
      ltm.saveCalibratedThreshold(pid, newThreshold, count);
      console.log(
        `Threshold calibrated to ${newThreshold.toFixed(3)} (from ${count} feedback pairs).`,
      );
    }
  }
}

async function cmdRerank(): Promise<void> {
  const remote = getRemoteUrl();
  if (remote) {
    console.error(
      "Error: rerank is not supported in remote mode (requires local DB access).",
    );
    process.exit(1);
  }

  const { ltm } = await import("@loreai/core");
  console.log("Re-ranking preference entries by directive strength...");
  const updated = ltm.rerankPreferences();
  if (updated === 0) {
    console.log("All preference entries are already ranked.");
  } else {
    console.log(`Done — ${updated} preference entries re-ranked.`);
  }
}

async function cmdVacuum(): Promise<void> {
  const remote = getRemoteUrl();
  if (remote) {
    console.error(
      "Error: vacuum is not supported in remote mode (requires local DB access).",
    );
    process.exit(1);
  }

  const { vacuum, dbFileSizeBytes, freelistBytes } =
    await import("@loreai/core");
  const mb = (b: number) => `${(b / 1e6).toFixed(1)} MB`;

  console.log(
    `Database: ${mb(dbFileSizeBytes())} (${mb(freelistBytes())} reclaimable free pages)`,
  );
  console.log(
    "Running VACUUM — this rewrites the whole database and can take a while (and ~2× the DB size in free disk) on a large DB…",
  );
  try {
    const { beforeBytes, afterBytes } = vacuum();
    console.log(
      `Done — ${mb(beforeBytes)} → ${mb(afterBytes)} (reclaimed ${mb(Math.max(0, beforeBytes - afterBytes))}).`,
    );
  } catch (err) {
    console.error("VACUUM failed:", err);
    console.error(
      "If a gateway/agent is running it holds the DB open — stop it and retry (VACUUM needs exclusive access).",
    );
    process.exit(1);
  }
}

async function cmdReindex(flags?: Record<string, unknown>): Promise<void> {
  const remote = getRemoteUrl();
  if (remote) return cmdReindexRemote(remote, flags ?? {});

  const { embedding } = await import("@loreai/core");

  if (!embedding.isAvailable()) {
    console.error("No embedding provider available.");
    console.error(
      "Set VOYAGE_API_KEY/OPENAI_API_KEY for remote embeddings, or ensure " +
        "@huggingface/transformers is installed for local embeddings.",
    );
    process.exit(1);
  }

  try {
    // backfillEmbeddings() calls checkConfigChange() internally —
    // it detects config changes, clears stale embeddings, then re-embeds.
    console.log("Re-indexing knowledge entries...");
    const knowledgeCount = await embedding.backfillEmbeddings();
    console.log(`  ✓ ${knowledgeCount} knowledge entries embedded`);

    console.log("Re-indexing distillations...");
    const distillCount = await embedding.backfillDistillationEmbeddings();
    console.log(`  ✓ ${distillCount} distillations embedded`);

    const total = knowledgeCount + distillCount;
    if (total === 0) {
      console.log("\nAll embeddings are up to date.");
    } else {
      console.log(`\nDone — ${total} entries re-indexed.`);
    }
  } catch (err) {
    console.error("Re-indexing failed:", err);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Remote CLI handlers
// ---------------------------------------------------------------------------

async function cmdListRemote(
  remote: string,
  args: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  const type = args[0];
  const limit = flags.limit ? Number(flags.limit) : 50;
  const asJson = !!flags.json;
  const projectPath = resolve((flags.project as string) ?? process.cwd());

  switch (type) {
    case "projects": {
      const projects = await remoteGet<
        Array<{
          id: string;
          path: string;
          name: string | null;
          git_remote: string | null;
          created_at: number;
          knowledge_count: number;
          session_count: number;
        }>
      >(remote, "/api/v1/projects");
      if (asJson) {
        console.log(JSON.stringify(projects, null, 2));
        return;
      }
      if (!projects.length) {
        console.log("No projects found.");
        return;
      }
      printTable(
        [
          "Name",
          "Path",
          "Git Remote",
          "ID",
          "Knowledge",
          "Sessions",
          "Created",
        ],
        projects.map((p) => [
          p.name ?? "(unnamed)",
          truncate(p.path, 35),
          truncate(p.git_remote ?? "-", 30),
          p.id.slice(0, 8),
          String(p.knowledge_count),
          String(p.session_count),
          formatDate(p.created_at),
        ]),
        [16, 35, 30, 10, 10, 10, 20],
      );
      break;
    }

    case "knowledge": {
      const matchingProject = await resolveRemoteProject(remote, projectPath);
      if (!matchingProject) {
        console.error(`No project found for: ${projectPath}`);
        process.exit(1);
      }
      const entries = await remoteGet<
        Array<{
          id: string;
          category: string;
          title: string;
          confidence: number;
          updated_at: number;
        }>
      >(remote, `/api/v1/projects/${matchingProject}/knowledge`);
      const limited = entries.slice(0, limit);
      if (asJson) {
        console.log(JSON.stringify(limited, null, 2));
        return;
      }
      if (!limited.length) {
        console.log("No knowledge entries found for this project.");
        return;
      }
      printTable(
        ["Category", "Title", "Confidence", "Updated", "ID"],
        limited.map((e) => [
          e.category,
          truncate(e.title, 40),
          e.confidence.toFixed(2),
          formatDate(e.updated_at),
          e.id.slice(0, 8), // remote API presents logical_id as id (A2)
        ]),
        [14, 40, 12, 20, 10],
      );
      break;
    }

    case "sessions": {
      const projectId = await resolveRemoteProject(remote, projectPath);
      if (!projectId) {
        console.error(`No project found for: ${projectPath}`);
        process.exit(1);
      }
      const sessions = await remoteGet<
        Array<{
          session_id: string;
          message_count: number;
          distilled_count: number;
          distillation_count: number;
          first_message_at: number;
          last_message_at: number;
        }>
      >(remote, `/api/v1/projects/${projectId}/sessions?limit=${limit}`);
      if (asJson) {
        console.log(JSON.stringify(sessions, null, 2));
        return;
      }
      if (!sessions.length) {
        console.log("No sessions found for this project.");
        return;
      }
      printTable(
        [
          "Session ID",
          "Messages",
          "Distilled",
          "Distillations",
          "First",
          "Last",
        ],
        sessions.map((s) => [
          s.session_id.slice(0, 12),
          String(s.message_count),
          String(s.distilled_count),
          String(s.distillation_count),
          formatDate(s.first_message_at),
          formatDate(s.last_message_at),
        ]),
        [14, 10, 10, 14, 20, 20],
      );
      break;
    }

    case "distillations": {
      const projectId = await resolveRemoteProject(remote, projectPath);
      if (!projectId) {
        console.error(`No project found for: ${projectPath}`);
        process.exit(1);
      }
      const dists = await remoteGet<
        Array<{
          id: string;
          session_id: string;
          generation: number;
          token_count: number;
          r_compression: number | null;
          c_norm: number | null;
          archived: number;
          created_at: number;
        }>
      >(remote, `/api/v1/projects/${projectId}/distillations?limit=${limit}`);
      if (asJson) {
        console.log(JSON.stringify(dists, null, 2));
        return;
      }
      if (!dists.length) {
        console.log("No distillations found for this project.");
        return;
      }
      printTable(
        [
          "Session",
          "Gen",
          "Tokens",
          "R_comp",
          "C_norm",
          "Archived",
          "Created",
          "ID",
        ],
        dists.map((d) => [
          d.session_id.slice(0, 12),
          String(d.generation),
          String(d.token_count),
          d.r_compression?.toFixed(2) ?? "-",
          d.c_norm?.toFixed(2) ?? "-",
          d.archived ? "yes" : "no",
          formatDate(d.created_at),
          d.id.slice(0, 8),
        ]),
        [14, 5, 8, 8, 8, 10, 20, 10],
      );
      break;
    }

    default:
      console.error(
        `Unknown type "${type ?? "(none)"}". Use: projects, knowledge, sessions, distillations`,
      );
      process.exit(1);
  }
}

async function cmdShowRemote(
  remote: string,
  args: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  const type = args[0];
  const rawId = args[1];
  const asJson = !!flags.json;
  const projectPath = resolve((flags.project as string) ?? process.cwd());

  if (!rawId) {
    console.error("Error: Missing <id> argument.");
    process.exit(1);
  }

  switch (type) {
    case "knowledge": {
      const entry = await remoteGet<{
        id: string;
        category: string;
        title: string;
        content: string;
        confidence: number;
        project_id: string | null;
        cross_project: boolean;
        source_session: string | null;
        created_at: number;
        updated_at: number;
        // The API serializes ltm.get()'s hydrated entry, so metadata arrives as
        // a parsed object (KnowledgeMetadata), not a JSON string (#627 Phase 1).
        metadata: Record<string, unknown> | null;
      }>(remote, `/api/v1/knowledge/${encodeURIComponent(rawId)}`);
      if (asJson) {
        console.log(JSON.stringify(entry, null, 2));
        return;
      }
      console.log(`ID:          ${entry.id}`);
      console.log(`Category:    ${entry.category}`);
      console.log(`Title:       ${entry.title}`);
      console.log(`Confidence:  ${entry.confidence}`);
      console.log(`Project ID:  ${entry.project_id ?? "(global)"}`);
      console.log(`Cross-proj:  ${entry.cross_project ? "yes" : "no"}`);
      console.log(`Session:     ${entry.source_session ?? "(none)"}`);
      console.log(`Created:     ${formatDate(entry.created_at)}`);
      console.log(`Updated:     ${formatDate(entry.updated_at)}`);
      if (entry.metadata)
        console.log(`Metadata:    ${JSON.stringify(entry.metadata)}`);
      console.log(`\nContent:\n${entry.content}`);
      break;
    }

    case "session": {
      const pq = projectQueryParams(projectPath);
      const data = await remoteGet<{
        messages: Array<{ role: string; content: string; created_at: number }>;
        distillations: Array<{
          id: string;
          generation: number;
          token_count: number;
          created_at: number;
        }>;
      }>(remote, `/api/v1/sessions/${encodeURIComponent(rawId)}?${pq}`);
      if (asJson) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      console.log(`Session: ${rawId}`);
      console.log(`Messages: ${data.messages.length}`);
      console.log(`Distillations: ${data.distillations.length}`);
      if (data.messages.length) {
        console.log(`\n--- Messages (${data.messages.length}) ---\n`);
        for (const msg of data.messages) {
          const prefix = msg.role === "user" ? ">" : "<";
          console.log(
            `${prefix} [${formatDate(msg.created_at)}] ${msg.role}: ${truncate(msg.content, 120)}`,
          );
        }
      }
      if (data.distillations.length) {
        console.log(`\n--- Distillations (${data.distillations.length}) ---\n`);
        for (const d of data.distillations) {
          console.log(
            `  gen=${d.generation} tokens=${d.token_count} ${formatDate(d.created_at)} ${d.id.slice(0, 8)}`,
          );
        }
      }
      break;
    }

    case "distillation": {
      const dist = await remoteGet<{
        id: string;
        session_id: string;
        project_id: string;
        generation: number;
        token_count: number;
        r_compression: number | null;
        c_norm: number | null;
        archived: number;
        created_at: number;
        source_ids: string;
        observations: string;
      }>(remote, `/api/v1/distillations/${encodeURIComponent(rawId)}`);
      if (asJson) {
        console.log(JSON.stringify(dist, null, 2));
        return;
      }
      console.log(`ID:            ${dist.id}`);
      console.log(`Session:       ${dist.session_id}`);
      console.log(`Project ID:    ${dist.project_id}`);
      console.log(`Generation:    ${dist.generation}`);
      console.log(`Tokens:        ${dist.token_count}`);
      console.log(`R_compression: ${dist.r_compression?.toFixed(3) ?? "-"}`);
      console.log(`C_norm:        ${dist.c_norm?.toFixed(3) ?? "-"}`);
      console.log(`Archived:      ${dist.archived ? "yes" : "no"}`);
      console.log(`Created:       ${formatDate(dist.created_at)}`);
      console.log(`Source IDs:    ${dist.source_ids}`);
      console.log(`\nObservations:\n${dist.observations}`);
      break;
    }

    default:
      console.error(
        `Unknown type "${type ?? "(none)"}". Use: knowledge, session, distillation`,
      );
      process.exit(1);
  }
}

async function cmdClearRemote(
  remote: string,
  projectPath: string,
  flags: Record<string, unknown>,
): Promise<void> {
  const skipConfirm = !!flags.yes;
  const projectId = await resolveRemoteProject(remote, projectPath);
  if (!projectId) {
    console.error(`No project found for: ${projectPath}`);
    process.exit(1);
  }

  const body: Record<string, boolean> = {};
  if (flags.knowledge) body.knowledge = true;
  if (flags.temporal) body.temporal = true;
  if (flags.distillations) body.distillations = true;

  const hasFlags = body.knowledge || body.temporal || body.distillations;
  const label = hasFlags
    ? `selected data (${Object.keys(body).join(", ")})`
    : "ALL data";

  if (!skipConfirm) {
    const confirmed = await confirm(
      `\nClear ${label} for project at:\n  ${projectPath}\n`,
    );
    if (!confirmed) {
      console.log("Cancelled.");
      return;
    }
  }

  const result = await remotePost<Record<string, number>>(
    remote,
    `/api/v1/projects/${projectId}/clear`,
    body,
  );
  const parts = Object.entries(result).map(
    ([k, v]) => `${v} ${k.replace("_", " ")}`,
  );
  console.log(`Cleared: ${parts.join(", ")}.`);
}

async function cmdDeleteRemote(
  remote: string,
  args: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  const type = args[0];
  const rawId = args[1];
  const skipConfirm = !!flags.yes;
  const projectPath = resolve((flags.project as string) ?? process.cwd());

  if (!rawId) {
    console.error("Error: Missing <id> argument.");
    process.exit(1);
  }

  switch (type) {
    case "knowledge": {
      if (!skipConfirm) {
        const confirmed = await confirm(`\nDelete knowledge entry ${rawId}?`);
        if (!confirmed) {
          console.log("Cancelled.");
          return;
        }
      }
      await remoteDelete(
        remote,
        `/api/v1/knowledge/${encodeURIComponent(rawId)}`,
      );
      console.log(`Deleted knowledge entry: ${rawId}`);
      break;
    }

    case "session": {
      if (!skipConfirm) {
        const confirmed = await confirm(
          `\nDelete all messages and distillations for session ${rawId}?`,
        );
        if (!confirmed) {
          console.log("Cancelled.");
          return;
        }
      }
      const pq = projectQueryParams(projectPath);
      const result = await remoteDelete<{
        messages_deleted: number;
        distillations_deleted: number;
      }>(remote, `/api/v1/sessions/${encodeURIComponent(rawId)}?${pq}`);
      console.log(
        `Deleted: ${result.messages_deleted} messages, ${result.distillations_deleted} distillations.`,
      );
      break;
    }

    case "distillation": {
      if (!skipConfirm) {
        const confirmed = await confirm(`\nDelete distillation ${rawId}?`);
        if (!confirmed) {
          console.log("Cancelled.");
          return;
        }
      }
      await remoteDelete(
        remote,
        `/api/v1/distillations/${encodeURIComponent(rawId)}`,
      );
      console.log(`Deleted distillation: ${rawId}`);
      break;
    }

    case "project": {
      // Resolve project: rawId can be UUID or path
      let projectId = rawId;
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          rawId,
        )
      ) {
        const resolved = await resolveRemoteProject(remote, resolve(rawId));
        if (!resolved) {
          console.error(`No project found for path: ${rawId}`);
          process.exit(1);
        }
        projectId = resolved;
      }
      if (!skipConfirm) {
        const confirmed = await confirm(
          `\nDelete project ${projectId.slice(0, 12)}... and ALL its data?`,
        );
        if (!confirmed) {
          console.log("Cancelled.");
          return;
        }
      }
      const result = await remoteDelete<{
        knowledge_deleted: number;
        temporal_deleted: number;
        distillations_deleted: number;
        sessions_cleared: number;
      }>(remote, `/api/v1/projects/${encodeURIComponent(projectId)}`);
      console.log(
        `Deleted project: ${result.knowledge_deleted} knowledge, ` +
          `${result.temporal_deleted} messages, ` +
          `${result.distillations_deleted} distillations, ` +
          `${result.sessions_cleared} sessions.`,
      );
      break;
    }

    default:
      console.error(
        `Unknown type "${type ?? "(none)"}". Use: knowledge, session, distillation, project`,
      );
      process.exit(1);
  }
}

async function cmdMergeRemote(
  remote: string,
  flags: Record<string, unknown>,
): Promise<void> {
  const skipConfirm = !!flags.yes;
  const asJson = !!flags.json;

  if (!skipConfirm) {
    const confirmed = await confirm(
      `This will scan git remotes and merge duplicate projects on the remote gateway.`,
    );
    if (!confirmed) {
      console.log("Cancelled.");
      return;
    }
  }

  const result = await remotePost<{
    updated: number;
    merged: number;
    namesBackfilled: number;
    mergeDetails: Array<{
      sourcePath: string;
      targetPath: string;
      gitRemote: string;
      result: Record<string, number>;
    }>;
  }>(remote, "/api/v1/projects/merge");

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`\nResults:`);
  console.log(`  Updated: ${result.updated} project(s) with git remote info`);
  console.log(`  Merged:  ${result.merged} duplicate project(s)`);
  console.log(`  Renamed: ${result.namesBackfilled} project(s) with repo name`);

  if (result.mergeDetails?.length) {
    console.log(`\nMerge details:`);
    for (const detail of result.mergeDetails) {
      console.log(`  ${detail.sourcePath}`);
      console.log(`    → merged into: ${detail.targetPath}`);
      console.log(`    git remote:    ${detail.gitRemote}`);
    }
  }
}

async function cmdDedupRemote(
  remote: string,
  flags: Record<string, unknown>,
): Promise<void> {
  const asJson = !!flags.json;
  const interactive = !!flags.interactive;
  const explicitProject =
    typeof flags.project === "string" ? resolve(flags.project) : null;

  if (interactive) {
    console.error(
      "Error: --interactive mode is not supported in remote mode. Use --yes for non-interactive.",
    );
    process.exit(1);
  }

  let projectId: string | undefined;
  if (explicitProject) {
    projectId =
      (await resolveRemoteProject(remote, explicitProject)) ?? undefined;
    if (!projectId) {
      console.error(`No project found for: ${explicitProject}`);
      process.exit(1);
    }
  }

  console.log(
    "Scanning for duplicate knowledge entries (dry run, remote)...\n",
  );

  if (!projectId) {
    const projects = await remoteGet<
      Array<{ id: string; name: string | null }>
    >(remote, "/api/v1/projects");
    if (!projects.length) {
      console.log("No projects found.");
      return;
    }
    // Dedup each project
    for (const p of projects) {
      const result = await remotePost(remote, `/api/v1/projects/${p.id}/dedup`);
      if (asJson) {
        console.log(
          JSON.stringify(
            { project: p.name ?? p.id, ...(result as object) },
            null,
            2,
          ),
        );
      } else {
        console.log(`[${p.name ?? p.id}] ${JSON.stringify(result)}`);
      }
    }
  } else {
    const result = await remotePost(
      remote,
      `/api/v1/projects/${projectId}/dedup`,
    );
    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
  }

  console.log(
    "\nNote: Remote dedup is always a dry run. Apply changes locally or via the gateway.",
  );
}

async function cmdReindexRemote(
  remote: string,
  _flags: Record<string, unknown>,
): Promise<void> {
  console.log("Re-indexing embeddings on remote gateway...");
  const result = await remotePost<{
    knowledge_embedded: number;
    distillations_embedded: number;
  }>(remote, "/api/v1/reindex");

  const total = result.knowledge_embedded + result.distillations_embedded;
  console.log(`  ${result.knowledge_embedded} knowledge entries embedded`);
  console.log(`  ${result.distillations_embedded} distillations embedded`);
  if (total === 0) {
    console.log("\nAll embeddings are up to date.");
  } else {
    console.log(`\nDone — ${total} entries re-indexed.`);
  }
}

/**
 * Resolve a local project path to a remote project UUID.
 * Lists projects from the remote and matches by git_remote (preferred) or path.
 */
async function resolveRemoteProject(
  remote: string,
  projectPath: string,
): Promise<string | null> {
  const { getGitRemote, normalizeRemoteUrl } = await import("@loreai/core");
  const gitRemote = getGitRemote(projectPath);
  const normalizedRemote = gitRemote ? normalizeRemoteUrl(gitRemote) : null;

  const projects = await remoteGet<
    Array<{
      id: string;
      path: string;
      git_remote: string | null;
    }>
  >(remote, "/api/v1/projects");

  // Prefer git_remote match
  if (normalizedRemote) {
    for (const p of projects) {
      if (
        p.git_remote &&
        normalizeRemoteUrl(p.git_remote) === normalizedRemote
      ) {
        return p.id;
      }
    }
  }

  // Fallback: exact path match
  for (const p of projects) {
    if (p.path === projectPath) return p.id;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Move / reassign sessions and knowledge between projects
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve a `--to` flag value to a project path. Accepts a UUID (resolved
 * via the DB) or a filesystem path.
 */
async function resolveTargetPath(rawTo: string): Promise<string> {
  if (UUID_RE.test(rawTo)) {
    const { projectPath: getProjectPathById } = await import("@loreai/core");
    const p = getProjectPathById(rawTo);
    if (!p) {
      console.error(`Error: No project found for UUID: ${rawTo}`);
      process.exit(1);
    }
    return p;
  }
  return resolve(rawTo);
}

async function cmdMove(
  args: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  const remote = getRemoteUrl();
  if (remote) return cmdMoveRemote(remote, args, flags);

  const { data } = await import("@loreai/core");
  const type = args[0];
  const rawIds = args.slice(1);
  const skipConfirm = !!flags.yes;
  const asJson = !!flags.json;
  const dryRun = !!flags["dry-run"];
  const rawTo = flags.to as string | undefined;
  const projectPath = resolve((flags.project as string) ?? process.cwd());

  if (!rawTo) {
    console.error(
      "Error: --to <path|UUID> is required. Specify the target project.",
    );
    process.exit(1);
  }

  if (!rawIds.length) {
    console.error(
      `Error: Missing <id> argument(s). Usage: lore data move ${type ?? "session"} <id...> --to <target>`,
    );
    process.exit(1);
  }

  switch (type) {
    case "session": {
      const { ensureProject } = await import("@loreai/core");
      const sourceProjectId = ensureProject(projectPath);
      const targetPath = await resolveTargetPath(rawTo);
      const includeChildren = flags["no-children"] !== true;

      // Resolve session IDs via prefix matching
      const allSessions = data.listSessions(projectPath, 10000);
      const resolved: string[] = [];
      for (const rawId of rawIds) {
        const match = allSessions.find((s) => s.session_id.startsWith(rawId));
        if (!match) {
          console.error(`Session not found (prefix: ${rawId})`);
          process.exit(1);
        }
        resolved.push(match.session_id);
      }

      if (asJson && dryRun) {
        console.log(
          JSON.stringify(
            {
              dryRun: true,
              from: projectPath,
              to: targetPath,
              sessions: resolved.map((sid) => {
                const s = allSessions.find((x) => x.session_id === sid)!;
                return {
                  session_id: sid,
                  messages: s.message_count,
                  distillations: s.distillation_count,
                };
              }),
            },
            null,
            2,
          ),
        );
        return;
      }

      if (!asJson) {
        console.log(`\nMove ${resolved.length} session(s):`);
        console.log(`  from: ${projectPath}`);
        console.log(`  to:   ${targetPath}`);
        console.log(`  include children: ${includeChildren}`);
        for (const sid of resolved) {
          const s = allSessions.find((x) => x.session_id === sid);
          console.log(
            `  - ${sid.slice(0, 12)}  (${s?.message_count ?? "?"} msgs, ${s?.distillation_count ?? "?"} distillations)`,
          );
        }
      }

      if (dryRun) {
        console.log("\nDry run — no changes made.");
        return;
      }

      if (!skipConfirm) {
        const confirmed = await confirm(
          `\nMove ${resolved.length} session(s) to ${targetPath}?`,
        );
        if (!confirmed) {
          console.log("Cancelled.");
          return;
        }
      }

      const result = data.moveSessions(resolved, sourceProjectId, targetPath, {
        includeChildren,
      });

      if (asJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(
          `\nMoved: ${result.sessions_moved} sessions, ` +
            `${result.messages_moved} messages, ` +
            `${result.distillations_moved} distillations, ` +
            `${result.tool_calls_moved} tool calls, ` +
            `${result.knowledge_moved} knowledge entries.`,
        );
      }
      break;
    }

    case "knowledge": {
      const rawId = rawIds[0];
      const targetPath = await resolveTargetPath(rawTo);
      const id = data.resolveId("knowledge", rawId) ?? rawId;

      if (!skipConfirm && !dryRun) {
        const confirmed = await confirm(
          `\nMove knowledge entry ${id.slice(0, 12)}... to ${targetPath}?`,
        );
        if (!confirmed) {
          console.log("Cancelled.");
          return;
        }
      }

      if (dryRun) {
        console.log(
          `Would move knowledge ${id.slice(0, 12)}... to ${targetPath}`,
        );
        return;
      }

      if (data.reassignKnowledge(id, targetPath)) {
        console.log(`Moved knowledge entry ${id} to ${targetPath}`);
      } else {
        console.error(`Knowledge entry not found: ${rawId}`);
        process.exit(1);
      }
      break;
    }

    default:
      console.error(
        `Unknown type "${type ?? "(none)"}". Use: session, knowledge`,
      );
      process.exit(1);
  }
}

async function cmdMoveRemote(
  remote: string,
  args: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  const type = args[0];
  const rawIds = args.slice(1);
  const skipConfirm = !!flags.yes;
  const rawTo = flags.to as string | undefined;
  const projectPath = resolve((flags.project as string) ?? process.cwd());

  if (!rawTo) {
    console.error(
      "Error: --to <path|UUID> is required. Specify the target project.",
    );
    process.exit(1);
  }

  if (!rawIds.length) {
    console.error(
      `Error: Missing <id> argument(s). Usage: lore data move ${type ?? "session"} <id...> --to <target>`,
    );
    process.exit(1);
  }

  switch (type) {
    case "session": {
      const sourceProjectId = await resolveRemoteProject(remote, projectPath);
      if (!sourceProjectId) {
        console.error(`No project found for path: ${projectPath}`);
        process.exit(1);
      }

      // Resolve target: UUID or path
      let toProject: { id?: string; path?: string };
      if (UUID_RE.test(rawTo)) {
        toProject = { id: rawTo };
      } else {
        toProject = { path: resolve(rawTo) };
      }

      if (!skipConfirm) {
        const confirmed = await confirm(
          `\nMove ${rawIds.length} session(s) to ${rawTo}?`,
        );
        if (!confirmed) {
          console.log("Cancelled.");
          return;
        }
      }

      const result = await remotePost<{
        sessions_moved: number;
        messages_moved: number;
        distillations_moved: number;
        tool_calls_moved: number;
        knowledge_moved: number;
      }>(remote, "/api/v1/sessions/move", {
        session_ids: rawIds,
        from_project_id: sourceProjectId,
        to_project: toProject,
        include_children: flags["no-children"] !== true,
      });

      console.log(
        `Moved: ${result.sessions_moved} sessions, ` +
          `${result.messages_moved} messages, ` +
          `${result.distillations_moved} distillations, ` +
          `${result.tool_calls_moved} tool calls, ` +
          `${result.knowledge_moved} knowledge entries.`,
      );
      break;
    }

    case "knowledge": {
      const rawId = rawIds[0];

      let toProject: { id?: string; path?: string };
      if (UUID_RE.test(rawTo)) {
        toProject = { id: rawTo };
      } else {
        toProject = { path: resolve(rawTo) };
      }

      if (!skipConfirm) {
        const confirmed = await confirm(
          `\nMove knowledge entry ${rawId} to ${rawTo}?`,
        );
        if (!confirmed) {
          console.log("Cancelled.");
          return;
        }
      }

      await remotePost(
        remote,
        `/api/v1/knowledge/${encodeURIComponent(rawId)}/move`,
        { to_project: toProject },
      );
      console.log(`Moved knowledge entry: ${rawId}`);
      break;
    }

    default:
      console.error(
        `Unknown type "${type ?? "(none)"}". Use: session, knowledge`,
      );
      process.exit(1);
  }
}

type SplitPlanSession = {
  sessionId: string;
  messages: number;
  confidence: "high" | "low";
  tier: "session_state" | "path" | "git_remote" | null;
  /** Set true during interactive review when the operator chooses to skip. */
  skip?: boolean;
};

type SplitPlanEntry = {
  targetId: string;
  targetName: string | null;
  targetPath: string | null;
  sessions: SplitPlanSession[];
};

/**
 * Pull the first few REAL user messages of a session (skipping tool results,
 * session markers, and system-reminders) plus, when `expand` is set, a larger
 * window. Gives the reviewer real context instead of one truncated line.
 */
function splitSessionPreview(
  bySession: (p: string, s: string) => Array<{ content: string }>,
  projectPath: string,
  sessionId: string,
  expand: boolean,
): string[] {
  let rows: Array<{ content: string }>;
  try {
    rows = bySession(projectPath, sessionId);
  } catch {
    return ["(could not load messages)"];
  }
  const maxMsgs = expand ? 12 : 4;
  const maxLen = expand ? 1200 : 400;
  const out: string[] = [];
  for (const r of rows) {
    if (out.length >= maxMsgs) break;
    const c = (r.content ?? "").trim();
    if (
      !c ||
      c.startsWith("[tool:result]") ||
      c.startsWith("<session>") ||
      c.startsWith("{") ||
      c.startsWith("<task-notification>") ||
      c.startsWith("<system-reminder>")
    ) {
      continue;
    }
    // Unwrap a system-reminder-wrapped prompt if present.
    const m = c.match(/The user (?:sent|asked)[^:]*:\s*([\s\S]{4,})/i);
    const text = (m ? m[1] : c).replace(/\s+/g, " ").trim();
    if (text.length > 3) out.push(text.slice(0, maxLen));
  }
  return out.length ? out : ["(no user-authored messages found)"];
}

/**
 * Interactive review of a split plan (item 2). For each planned session, shows
 * richer context and lets the operator keep, skip, or expand the view.
 */
async function reviewSplitPlan(
  plans: SplitPlanEntry[],
  projectPath: string,
): Promise<void> {
  const { createInterface } = await import("node:readline");
  const { temporal } = await import("@loreai/core");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));

  const items: Array<{ plan: SplitPlanEntry; sess: SplitPlanSession }> = [];
  for (const plan of plans)
    for (const sess of plan.sessions) items.push({ plan, sess });

  console.log(`\n=== interactive review (${items.length} sessions) ===`);
  console.log(
    `For each: [Enter]=keep (move as planned), [s]=skip (leave in source), [e]=expand, [q]=quit review\n`,
  );

  let i = 0;
  for (const { plan, sess } of items) {
    i++;
    let expand = false;
    for (;;) {
      console.log(
        `\n[${i}/${items.length}] session ${sess.sessionId.slice(0, 14)} ` +
          `(${sess.messages} msgs, ${sess.confidence}, via ${sess.tier ?? "?"})`,
      );
      console.log(`   → planned target: ${plan.targetName ?? plan.targetPath}`);
      const preview = splitSessionPreview(
        temporal.bySession,
        projectPath,
        sess.sessionId,
        expand,
      );
      for (const line of preview) console.log(`     | ${line}`);
      const ans = (await ask("   keep/skip/expand/quit [k/s/e/q]: "))
        .trim()
        .toLowerCase();
      if (ans === "e") {
        expand = true;
        continue;
      }
      if (ans === "q") {
        rl.close();
        return;
      }
      if (ans === "s") {
        sess.skip = true;
      }
      break;
    }
  }
  rl.close();
}

/**
 * Auto-suggest planner: scan sessions in a project, suggest target projects
 * by scanning stored message content for project path patterns.
 * Mirrors `cmdConsolidate` conventions (dry-run default, --yes to apply).
 */
async function cmdSplit(
  _args: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  const remote = getRemoteUrl();
  if (remote) {
    console.error(
      "Error: split is not supported in remote mode (needs direct DB access for content scanning).",
    );
    process.exit(1);
  }

  const { data, ensureProject } = await import("@loreai/core");
  const { suggestProjectsForSessions } = await import("../suggest");

  const skipConfirm = !!flags.yes;
  const asJson = !!flags.json;
  const dryRun = !!flags["dry-run"] || !skipConfirm;
  const interactive = !!flags.interactive;
  const noBackup = !!flags["no-backup"];
  const minConfidence = (flags["min-confidence"] as string) ?? "high";
  const projectPath = resolve((flags.project as string) ?? process.cwd());

  const sourceProjectId = ensureProject(projectPath);
  const sessions = data.listSessions(projectPath, 10000);

  if (!sessions.length) {
    if (!asJson) console.log("No sessions found in project.");
    return;
  }

  // Suggest targets for all sessions
  const suggestions = suggestProjectsForSessions(
    sessions.map((s) => s.session_id),
    sourceProjectId,
    projectPath,
  );

  // Group by suggested target
  const planMap = new Map<string, SplitPlanEntry>();
  const unresolved: Array<{ sessionId: string; messages: number }> = [];

  for (let i = 0; i < suggestions.length; i++) {
    const s = suggestions[i];
    const sess = sessions[i];
    if (
      !s.suggestedProjectId ||
      !s.confidence ||
      (minConfidence === "high" && s.confidence !== "high")
    ) {
      unresolved.push({
        sessionId: sess.session_id,
        messages: sess.message_count,
      });
      continue;
    }
    let entry = planMap.get(s.suggestedProjectId);
    if (!entry) {
      entry = {
        targetId: s.suggestedProjectId,
        targetName: s.suggestedProjectName,
        targetPath: s.suggestedProjectPath,
        sessions: [],
      };
      planMap.set(s.suggestedProjectId, entry);
    }
    entry.sessions.push({
      sessionId: sess.session_id,
      messages: sess.message_count,
      confidence: s.confidence,
      tier: s.tier,
    });
  }

  const plans = [...planMap.values()];

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          dryRun,
          source: projectPath,
          plans: plans.map((p) => ({
            target: p.targetName ?? p.targetPath,
            targetId: p.targetId,
            sessions: p.sessions.map((s) => ({
              session_id: s.sessionId.slice(0, 12),
              messages: s.messages,
              confidence: s.confidence,
            })),
          })),
          unresolved: unresolved.map((u) => ({
            session_id: u.sessionId.slice(0, 12),
            messages: u.messages,
          })),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`\nSource project: ${projectPath}`);
    console.log(`Total sessions: ${sessions.length}`);
    console.log(`  with suggestion: ${sessions.length - unresolved.length}`);
    console.log(`  unresolved: ${unresolved.length}\n`);

    for (const plan of plans) {
      console.log(
        `  → ${plan.targetName ?? plan.targetPath} (${plan.sessions.length} sessions)`,
      );
      for (const s of plan.sessions) {
        console.log(
          `      ${s.sessionId.slice(0, 12)}  ${s.messages} msgs  [${s.confidence}]`,
        );
      }
    }
    if (unresolved.length) {
      console.log(`\n  ? Unresolved (${unresolved.length} sessions):`);
      for (const u of unresolved) {
        console.log(
          `      ${u.sessionId.slice(0, 12)}  ${u.messages} msgs  → use "lore data move session <id> --to <target>"`,
        );
      }
    }
  }

  if (plans.length === 0) {
    if (!asJson)
      console.log(
        "\nNo confident suggestions found. Use `lore data move session <id> --to <target>` to move manually.",
      );
    return;
  }

  if (dryRun) {
    if (!asJson) {
      console.log(
        `\nDry run — no changes made. Re-run with --yes to move ${plans.reduce((n, p) => n + p.sessions.length, 0)} session(s).` +
          ` Add -i/--interactive to review each session before moving.`,
      );
    }
    return;
  }

  // --- Interactive review (item 2): let the operator inspect and confirm/skip
  // each planned session, with richer context than a single truncated line. ---
  if (interactive && !asJson) {
    await reviewSplitPlan(plans, projectPath);
    // Drop any sessions the reviewer skipped (marked `skip = true`).
    for (let i = plans.length - 1; i >= 0; i--) {
      plans[i].sessions = plans[i].sessions.filter((s) => !s.skip);
      if (plans[i].sessions.length === 0) plans.splice(i, 1);
    }
    if (plans.length === 0) {
      console.log("\nAll sessions skipped — nothing to move.");
      return;
    }
  }

  // --- Mandatory backup before ANY write (item 3) ---
  // Always snapshot via VACUUM INTO first so a mistake is recoverable. We never
  // touch the live -wal/-shm files or cp over a live DB; SQLite manages them.
  let backupPath: string | null = null;
  if (!noBackup) {
    try {
      backupPath = data.backupDatabase();
      if (!asJson) console.log(`\nBackup written: ${backupPath}`);
    } catch (e) {
      console.error(
        `\n  ✗ Backup failed — aborting before any changes: ${(e as Error).message}`,
      );
      console.error(
        `    (re-run with --no-backup to skip the backup at your own risk)`,
      );
      process.exit(1);
    }
  } else if (!asJson) {
    console.log(
      "\n⚠ --no-backup: skipping the pre-write backup. Data loss is not recoverable.",
    );
  }

  const before = data.validateDatabaseIntegrity();

  // Apply. moveSessions wraps each move in its own transaction; the live
  // gateway (if running against the same DB) is serialized by SQLite WAL.
  let totalMoved = 0;
  for (const plan of plans) {
    if (!plan.targetPath) continue;
    try {
      const result = data.moveSessions(
        plan.sessions.map((s) => s.sessionId),
        sourceProjectId,
        plan.targetPath,
      );
      totalMoved += result.sessions_moved;
      if (!asJson) {
        console.log(
          `\n  ✓ Moved ${result.sessions_moved} session(s) → ${plan.targetName ?? plan.targetPath}` +
            ` (${result.messages_moved} msgs, ${result.distillations_moved} distillations, ${result.knowledge_moved} knowledge)`,
        );
      }
    } catch (e) {
      console.error(
        `  ✗ Failed to move to ${plan.targetName ?? plan.targetPath}: ${(e as Error).message}`,
      );
    }
  }

  // --- Validate after apply (item 3): integrity + no message loss + FTS parity ---
  const after = data.validateDatabaseIntegrity();
  const messagesPreserved = after.messageCount === before.messageCount;
  if (!after.ok || !messagesPreserved) {
    console.error(
      `\n  ✗ VALIDATION FAILED after split: integrity=${after.integrity}, ` +
        `messages ${before.messageCount}→${after.messageCount} ` +
        `(${messagesPreserved ? "preserved" : "CHANGED"}), ` +
        `knowledge/fts ${after.knowledgeFtsMatch ? "ok" : "MISMATCH"}. ` +
        (backupPath
          ? `Restore the pre-split backup if needed: ${backupPath}`
          : `No backup was taken (--no-backup) — manual recovery required.`),
    );
    process.exit(1);
  }

  if (!asJson) {
    console.log(
      `\nSplit complete: ${totalMoved} session(s) moved. ` +
        `Validation OK (integrity=${after.integrity}, messages preserved).`,
    );
    if (unresolved.length) {
      console.log(
        `${unresolved.length} unresolved session(s) remain — use "lore data move session <id> --to <target>".`,
      );
    }
  }
}

// Main dispatch
// ---------------------------------------------------------------------------

const DATA_HELP = `
lore data — Manage stored data

Usage:
  lore data <subcommand> [options]

Subcommands:
  list <type>           List entries (projects, knowledge, sessions, distillations)
  show <type> <id>      Show full detail for an entry
  clear [options]       Clear data for a project or wipe the database
  delete <type> <id>    Delete a single entry (type: knowledge, session, distillation, project)
  move <type> <id..>    Move session(s) or knowledge to another project (--to required)
  split                 Auto-suggest & move mis-grouped sessions to correct projects
  merge                 Scan git remotes and merge duplicate projects
  consolidate           Merge "(unattributed)" buckets into matched real projects
  export                Regenerate .lore.md / AGENTS.md from the DB for a project
  recover               Re-import knowledge from .lore.md / AGENTS.md files
  reground-entities     Re-derive entities (people, tools, ...) from history (needs a running gateway)
  dedup                 Find and remove duplicate knowledge entries (all projects)
  contradictions        List knowledge entries that contradict each other (#1123)
  reindex               Rebuild embedding vectors (after model/config change)
  rerank                Re-score preference confidence by directive strength
  vacuum                Reclaim free space from the DB file (full VACUUM; #1221)
  cache-stats           Show cache-bust counters (system[0] cache-alignment gate)

Options:
  --project <path>      Target project directory (default: current directory)
  --limit <n>           Max rows for list commands (default: 50)
  --json                Output JSON instead of table
  --yes, -y             Skip confirmation for destructive operations
  --interactive, -i     Interactive mode for dedup (accept/reject per cluster)
  --dry-run             Preview only (no mutations)

Move options:
  --to <path|UUID>      Target project for move/reassign (required for move)
  --no-children         Don't include sub-agent child sessions in the move
  --min-confidence      Minimum confidence for split suggestions (high|low, default: high)

Split options:
  -i, --interactive     Review each session (keep/skip/expand) before moving
  --no-backup           Skip the mandatory pre-write DB backup (NOT recommended)

Clear options:
  --knowledge           Clear only knowledge entries
  --temporal            Clear only temporal messages
  --distillations       Clear only distillations
  --all                 Wipe the entire database (ignores --project)

Examples:
  lore data list projects
  lore data list knowledge --project /path/to/project
  lore data show knowledge abc12345
  lore data clear --project .
  lore data clear --project . --knowledge --yes
  lore data clear --all
  lore data delete knowledge abc12345
  lore data delete session abc12345-6789
  lore data delete project /path/to/project  # delete project and ALL its data
  lore data move session abc123 --to /path/to/project   # move a session
  lore data move session abc123 def456 --to <UUID>     # move multiple sessions
  lore data move knowledge abc123 --to /path/to/project  # reassign a knowledge entry
  lore data split --project /wrong/project             # dry-run: suggest moves
  lore data split --project /wrong/project --yes       # apply confident suggestions
  lore data merge                          # scan & merge git duplicates
  lore data merge --yes                    # skip confirmation
  lore data consolidate                    # dry-run: show "(unattributed)" buckets & matches
  lore data consolidate --yes              # apply: merge matched buckets into real projects
  lore data consolidate --json             # machine-readable plan (dryRun:true unless --yes)
  lore data export                         # regenerate .lore.md for current project from the DB
  lore data export --project /path         # regenerate for a specific project
  lore data recover                        # re-import from .lore.md / AGENTS.md
  lore data recover --yes                  # skip confirmation
  lore data reground-entities --dry-run    # preview entities re-derived from history (current project)
  lore data reground-entities --project .  # apply for current project (prompts to confirm)
  lore data reground-entities --all --yes  # re-derive across all projects with history
  lore data dedup                          # dry-run: show duplicate clusters
  lore data dedup --yes                    # apply: remove duplicates
  lore data dedup --interactive            # accept/reject each cluster interactively
  lore data cache-stats                    # cache-bust tally + system[0] relocatable share (all projects)
  lore data cache-stats --project .        # scope the cache-bust gate to one project
  lore data dedup --project /path/to/project
  lore data reindex                        # rebuild all embedding vectors
  lore data rerank                         # re-score preference confidence
`.trimStart();

/**
 * Consolidate synthetic "unattributed" project buckets
 * (`/__lore_unattributed__/<sessionID>`) created by a remote gateway when it
 * couldn't determine a confident project path.
 *
 * For each bucket, attempt to match a REAL project by git_remote (the only
 * reliable cross-session signal). When matched, merge the bucket into the real
 * project (re-pointing all rows). Buckets with no confident match are reported
 * but left intact (they remain a clearly-labelled cross-project memory source).
 */
/**
 * `lore data export [--project <path>]` — regenerate the on-disk knowledge
 * file(s) from the current DB state for a single project. Useful when the
 * file has drifted from the DB (e.g. stale entries that consolidation/tombstones
 * removed from the DB but still linger in a committed .lore.md), without
 * waiting for the idle exporter or running a destructive `clear`.
 *
 * Respects the same loreFile/agentsFile config the idle exporter uses.
 */
async function cmdExport(
  _args: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  if (getRemoteUrl()) {
    console.error(
      "Error: export is not supported in remote mode (requires local filesystem access).",
    );
    process.exit(1);
  }

  const projectPath = resolve((flags.project as string) ?? process.cwd());

  const {
    config: loreConfig,
    ltm,
    exportToFile,
    exportLoreFile,
    exportInlineToAgentsFile,
    deleteLoreFile,
    removeLoreSectionFromFile,
    resolveAgentsFileName,
    otherAgentsFileCandidate,
    AGENTS_FILE_CANDIDATES,
  } = await import("@loreai/core");
  const cfg = loreConfig();

  if (!cfg.knowledge.enabled) {
    console.error(
      "Error: knowledge is disabled in config — nothing to export.",
    );
    process.exit(1);
  }

  const entries = ltm.forProject(projectPath, false);
  // No live session here — resolve "auto" via existing-file detection.
  const agentsFileName = resolveAgentsFileName(cfg.agentsFile.path, {
    projectPath,
  });
  const agentsFilePath = join(projectPath, agentsFileName);

  if (entries.length === 0) {
    // No knowledge for this project — fully reconcile the on-disk files so no
    // stale entries remain to be re-imported from git. This must cover EVERY
    // config combination, not just .lore.md: a dangling AGENTS.md pointer (to a
    // now-deleted .lore.md) or a stale inline AGENTS.md knowledge section would
    // otherwise survive — exactly the drift this command exists to fix.
    const cleaned: string[] = [];
    if (cfg.loreFile.enabled && deleteLoreFile(projectPath)) {
      cleaned.push(join(projectPath, ".lore.md"));
    }
    // Strip lore's section from the agents file (pointer in the default config,
    // inline knowledge in the agentsFile-only config). Preserves user content.
    // Under "auto", clean BOTH candidates since either may hold a stale section.
    if (cfg.agentsFile.enabled) {
      const names =
        cfg.agentsFile.path === "auto"
          ? [...AGENTS_FILE_CANDIDATES]
          : [agentsFileName];
      for (const name of names) {
        const p = join(projectPath, name);
        if (removeLoreSectionFromFile(p)) cleaned.push(p);
      }
    }
    if (cleaned.length) {
      console.log(`No knowledge for ${projectPath} — cleaned stale file(s):`);
      for (const f of cleaned) console.log(`  ${f}`);
      console.log("Commit the change(s) to keep git in sync.");
    } else {
      console.log(`No knowledge for ${projectPath} — nothing to export.`);
    }
    return;
  }

  const written: string[] = [];
  let wroteAgentsFile = false;
  if (cfg.loreFile.enabled && cfg.agentsFile.enabled) {
    exportToFile({ projectPath, filePath: agentsFilePath });
    written.push(join(projectPath, ".lore.md"), agentsFilePath);
    wroteAgentsFile = true;
  } else if (cfg.loreFile.enabled) {
    exportLoreFile(projectPath);
    written.push(join(projectPath, ".lore.md"));
  } else if (cfg.agentsFile.enabled) {
    exportInlineToAgentsFile({ projectPath, filePath: agentsFilePath });
    written.push(agentsFilePath);
    wroteAgentsFile = true;
  } else {
    console.log(
      "Both loreFile and agentsFile are disabled in config — nothing written.",
    );
    return;
  }
  // In "auto" mode, strip a stale managed section from the OTHER candidate so a
  // target flip never leaves a duplicate (mirrors the idle exporter).
  if (wroteAgentsFile && cfg.agentsFile.path === "auto") {
    const other = otherAgentsFileCandidate(agentsFileName);
    if (other && removeLoreSectionFromFile(join(projectPath, other))) {
      console.log(`  (removed stale lore section from ${other})`);
    }
  }

  console.log(
    `Exported ${entries.length} knowledge ${entries.length === 1 ? "entry" : "entries"} for ${projectPath}:`,
  );
  for (const f of written) console.log(`  ${f}`);
  console.log(
    "Commit the regenerated file(s) to keep git in sync and prevent re-import of stale entries.",
  );
}

async function cmdConsolidate(
  _args: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  const remote = getRemoteUrl();
  if (remote) {
    console.error(
      "Error: consolidate is not supported in remote mode (run it on the gateway host).",
    );
    process.exit(1);
  }

  const { data, isUnattributedProjectPath } = await import("@loreai/core");
  const mergeProjects = data.mergeProjects;
  const skipConfirm = !!flags.yes;
  const asJson = !!flags.json;
  // Destructive op → default to a dry run. Apply only with --yes. `--dry-run`
  // forces preview even when --yes is present.
  const dryRun = !!flags["dry-run"] || !skipConfirm;

  const projects = data.listProjects();
  const buckets = projects.filter((p) => isUnattributedProjectPath(p.path));
  // Candidate targets are REAL projects only (never other buckets). Matching a
  // bucket to a real project by git remote is the only reliable cross-session
  // signal — note both the bucket AND the real project may carry the same
  // remote, so we must explicitly exclude buckets from the target set rather
  // than relying on a first-match lookup.
  const realProjects = projects.filter(
    (p) => !isUnattributedProjectPath(p.path),
  );

  type Plan = {
    bucket: (typeof projects)[number];
    target?: (typeof projects)[number];
  };
  const plans: Plan[] = [];
  for (const bucket of buckets) {
    let target: (typeof projects)[number] | undefined;
    if (bucket.git_remote) {
      target = realProjects.find((p) => p.git_remote === bucket.git_remote);
    }
    plans.push({ bucket, target });
  }

  const mergeable = plans.filter((p) => p.target);
  const orphans = plans.filter((p) => !p.target);

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          dryRun,
          buckets: buckets.length,
          mergeable: mergeable.map((p) => ({
            from: p.bucket.path,
            into: p.target?.path,
            gitRemote: p.bucket.git_remote,
          })),
          orphans: orphans.map((p) => ({
            path: p.bucket.path,
            knowledge: p.bucket.knowledge_count,
            sessions: p.bucket.session_count,
          })),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`\nUnattributed buckets: ${buckets.length}`);
    console.log(`  mergeable (matched by git remote): ${mergeable.length}`);
    console.log(`  orphans (no confident match): ${orphans.length}\n`);
    for (const p of mergeable) {
      console.log(
        `  merge ${p.bucket.path} → ${p.target?.name ?? p.target?.path}`,
      );
    }
    for (const p of orphans) {
      console.log(
        `  keep  ${p.bucket.path} (${p.bucket.knowledge_count} knowledge, ${p.bucket.session_count} sessions)`,
      );
    }
  }

  if (mergeable.length === 0) {
    if (!asJson) console.log("\nNothing to consolidate.");
    return;
  }

  // Dry run (default, or explicit --dry-run): preview only, never mutate.
  if (dryRun) {
    if (!asJson) {
      console.log(
        `\nDry run — no changes made. Re-run with --yes to merge ${mergeable.length} bucket(s).`,
      );
    }
    return;
  }

  let merged = 0;
  for (const p of mergeable) {
    const target = p.target;
    if (!target) continue;
    try {
      mergeProjects(p.bucket.id, target.id);
      merged++;
    } catch (e) {
      console.error(
        `  failed to merge ${p.bucket.path}: ${(e as Error).message}`,
      );
    }
  }
  console.log(`\nConsolidated ${merged} bucket(s).`);
}

type RebuildResult = {
  projectPath: string;
  scannedDistillations: number;
  batches: number;
  detected: number;
  personsCreated: number;
  orgsCreated: number;
  otherCreated: number;
  relationsCreated: number;
  mergedIntoSelf: number;
  dedupMerged: number;
  candidates?: Array<{ type: string; name: string }>;
};

/**
 * Re-derive entities (people, orgs, services, tools) from a project's
 * distillation history. Delegates to the gateway's REST endpoint because the
 * extraction needs a worker LLM — only the running gateway holds the upstream
 * + auth. Resolves the gateway via LORE_REMOTE_URL, else the local port file.
 */
async function cmdReground(
  _args: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  const asJson = !!flags.json;
  const dryRun = !!flags["dry-run"];
  const all = !!flags.all;
  const skipConfirm = !!flags.yes;

  // Resolve a reachable gateway: explicit remote, else the local running one.
  let baseUrl = getRemoteUrl();
  if (!baseUrl) {
    const { readPortFile } = await import("../portfile");
    const port = readPortFile();
    if (port) baseUrl = `http://127.0.0.1:${port}`;
  }
  if (!baseUrl) {
    console.error(
      "Error: entity rebuild needs a running gateway (it makes LLM calls).\n" +
        "Start one with `lore` (or `lore start`), or set LORE_REMOTE_URL.",
    );
    process.exit(1);
    return;
  }

  // Build request body.
  const body: Record<string, unknown> = { dryRun };
  if (all) {
    body.all = true;
  } else {
    const projectPath = resolve((flags.project as string) ?? process.cwd());
    const { getGitRemote, normalizeRemoteUrl } = await import("@loreai/core");
    const gitRemote = getGitRemote(projectPath);
    if (gitRemote) body.git_remote = normalizeRemoteUrl(gitRemote) ?? gitRemote;
    body.path = projectPath;
  }

  // Confirm the apply path (LLM cost). Dry runs write nothing, so skip confirm.
  if (!dryRun && !skipConfirm) {
    const scope = all ? "ALL projects with history" : (body.path as string);
    const confirmed = await confirm(
      `\nRe-derive entities from distillation history for:\n  ${scope}\n` +
        `This runs LLM extraction over the history (may take a while and incur cost).`,
    );
    if (!confirmed) {
      console.log("Cancelled.");
      return;
    }
  }

  let resp: { dryRun: boolean; cancelled?: boolean; results: RebuildResult[] };
  try {
    resp = await remotePost(baseUrl, "/api/v1/entities/rebuild", body);
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
    return;
  }

  if (asJson) {
    console.log(JSON.stringify(resp, null, 2));
    return;
  }

  if (resp.dryRun) {
    for (const r of resp.results) {
      console.log(`\n${r.projectPath}`);
      console.log(
        `  scanned ${r.scannedDistillations} distillations in ${r.batches} batch(es); ${r.detected} mention(s) detected`,
      );
      const cands = r.candidates ?? [];
      if (cands.length === 0) {
        console.log("  no entities detected");
      } else {
        for (const c of cands) console.log(`  - [${c.type}] ${c.name}`);
      }
    }
    console.log("\nDry run — nothing was written. Re-run with --yes to apply.");
    return;
  }

  let people = 0;
  let total = 0;
  let merged = 0;
  let deduped = 0;
  let rels = 0;
  for (const r of resp.results) {
    console.log(`\n${r.projectPath}`);
    console.log(
      `  created ${r.personsCreated} person, ${r.orgsCreated} org, ${r.otherCreated} other; ` +
        `${r.relationsCreated} relation(s); ${r.mergedIntoSelf} folded into self; ${r.dedupMerged} deduped`,
    );
    people += r.personsCreated;
    total += r.personsCreated + r.orgsCreated + r.otherCreated;
    rels += r.relationsCreated;
    merged += r.mergedIntoSelf;
    deduped += r.dedupMerged;
  }
  console.log(
    `\n${resp.cancelled ? "Cancelled" : "Done"}: ${total} entities created (${people} people), ${rels} relation(s), ` +
      `${merged} folded into self, ${deduped} deduped across ${resp.results.length} project(s).`,
  );
}

/**
 * `lore data cache-stats [--project <path>]` — read the durable cache-bust
 * counters (issue #791 measure-first gate). Prints the per-cause tally plus a
 * summary highlighting the share of busts (and write-token cost) attributable
 * to a RELOCATABLE dynamic span in system[0] (the agent-owned host prompt) —
 * the headline number for the rare-vs-material decision.
 */
async function cmdCacheStats(
  _args: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  if (getRemoteUrl()) {
    console.error(
      "Error: cache-stats reads local counters only (not supported in remote mode).",
    );
    process.exit(1);
  }

  const { getCacheBustStats, summarizeCacheBustStats, ensureProject } =
    await import("@loreai/core");

  let projectID: string | undefined;
  let scopeLabel = "all projects";
  if (flags.project) {
    const projectPath = resolve(flags.project as string);
    projectID = ensureProject(projectPath);
    scopeLabel = projectPath;
  }

  const stats = getCacheBustStats(projectID);
  if (!stats.length) {
    console.log(`No cache-bust stats recorded yet (${scopeLabel}).`);
    return;
  }

  console.log(`Cache-bust stats (${scopeLabel})\n`);
  printTable(
    ["CAUSE", "RELOCATABLE", "TURNS", "WRITE_TOKENS"],
    stats.map((s) => [
      s.cause,
      s.relocatable ? "yes" : "no",
      String(s.turns),
      String(s.writeTokens),
    ]),
    [22, 12, 10, 14],
  );

  // Gate summary. The headline arithmetic lives in summarizeCacheBustStats
  // (pure, unit-tested in core) so the decision math is not buried in CLI glue.
  const g = summarizeCacheBustStats(stats);
  const pct = (n: number, d: number) =>
    d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "0.0%";

  console.log(`\nGate (issue #791):`);
  console.log(`  total turns:           ${g.totalTurns}`);
  console.log(
    `  busts:                 ${g.bustTurns} (${pct(g.bustTurns, g.totalTurns)} of turns, ${g.bustTokens} write tokens)`,
  );
  console.log(
    `  system[0] host busts:  ${g.hostTurns} (${pct(g.hostTurns, g.bustTurns)} of busts, ${g.hostTokens} write tokens)`,
  );
  console.log(
    `    relocatable:         ${g.relocatableTurns} (${pct(g.relocatableTurns, g.bustTurns)} of busts, ${g.relocatableTokens} write tokens)`,
  );
  console.log(
    `\n  verdict hint: relocatable system[0] busts = ${pct(g.relocatableTurns, g.bustTurns)} of busts / ${g.relocatableTokens} write tokens.` +
      ` Low on both → close as not-worth-it; material → build relocation.`,
  );
}

export async function commandData(
  positionals: string[],
  values: Record<string, unknown>,
): Promise<void> {
  const subcommand = positionals[0];
  const subArgs = positionals.slice(1);

  switch (subcommand) {
    case "list":
      await cmdList(subArgs, values);
      break;
    case "show":
      await cmdShow(subArgs, values);
      break;
    case "clear":
      await cmdClear(subArgs, values);
      break;
    case "delete":
      await cmdDelete(subArgs, values);
      break;
    case "move":
      await cmdMove(subArgs, values);
      break;
    case "split":
      await cmdSplit(subArgs, values);
      break;
    case "merge":
      await cmdMerge(subArgs, values);
      break;
    case "consolidate":
      await cmdConsolidate(subArgs, values);
      break;
    case "export":
      await cmdExport(subArgs, values);
      break;
    case "recover":
      await cmdRecover(subArgs, values);
      break;
    case "reground-entities":
      await cmdReground(subArgs, values);
      break;
    case "dedup":
      await cmdDedup(subArgs, values);
      break;
    case "contradictions":
      await cmdContradictions(subArgs, values);
      break;
    case "reindex":
      await cmdReindex(values);
      break;
    case "rerank":
      await cmdRerank();
      break;
    case "vacuum":
      await cmdVacuum();
      break;
    case "cache-stats":
      await cmdCacheStats(subArgs, values);
      break;
    case "help":
    case undefined:
      console.log(DATA_HELP);
      break;
    default:
      console.error(`Unknown subcommand "${subcommand}".`);
      console.log(DATA_HELP);
      process.exit(1);
  }
}
