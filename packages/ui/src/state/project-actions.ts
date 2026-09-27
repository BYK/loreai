/**
 * Project action writes (UI-08, #1823): rename, move sessions, clear,
 * delete and git-remote merge. Each method calls the mutation route and
 * then purges/reloads the cached projections so a deleted, cleared, or
 * merged project is never served stale from IndexedDB:
 *
 *  - rename  → projects list reload (the row survives, only `name` changed)
 *  - move    → purge source + target project caches, list reload
 *  - clear   → purge the project's cache, list reload (counts changed)
 *  - delete  → purge the project's cache + drop the project row itself
 *  - merge   → ownership changed globally: wipe every cached projection
 */
import type {
  ProjectClearResult,
  ProjectDeleteResult,
  ProjectRenameResult,
  ProjectsMergeResult,
  SessionSummary,
  SessionsMoveResult,
} from "~/contracts";
import type { KnowledgeEntry } from "~/contracts";
import type { ApiClient } from "~/lib/api";
import type { MessageBlock, Repository } from "~/db";
import type { ProjectSummary } from "~/contracts";

async function bestEffort(
  label: string,
  work: () => Promise<unknown>,
): Promise<void> {
  try {
    await work();
  } catch (reason) {
    console.warn(`${label} failed`, reason);
  }
}

export interface ProjectActionsDeps {
  client: ApiClient;
  tracked: <T>(read: () => Promise<T>) => Promise<T>;
  repos: {
    projects: Repository<ProjectSummary>;
    knowledge: Repository<KnowledgeEntry>;
    sessions: Repository<SessionSummary>;
    messageBlocks: Repository<MessageBlock>;
  };
  projects: {
    remove(id: string): Promise<void>;
    reload(): void;
  };
}

export function createProjectActionsState({
  client,
  tracked,
  repos,
  projects,
}: ProjectActionsDeps) {
  /**
   * Drop every cached projection scoped to `projectId`: knowledge rows,
   * session rows, each session's message blocks, and their collection
   * progress rows. Entities are global (no project scope) so they are left
   * alone. After this the next loader mount renders the loading state and
   * answers from the server — never from a stale cache.
   */
  async function purgeProjectCache(projectId: string): Promise<void> {
    const sessions = await repos.sessions.getScope(projectId);
    for (const session of sessions) {
      const key = new URLSearchParams({
        projectId,
        sessionId: session.session_id,
      }).toString();
      await repos.messageBlocks.putMany([], key, { replaceScope: true });
      await repos.messageBlocks.deleteCollection(key);
    }
    await repos.sessions.putMany([], projectId, { replaceScope: true });
    await repos.sessions.deleteCollection(projectId);
    await repos.knowledge.putMany([], projectId, { replaceScope: true });
    await repos.knowledge.deleteCollection(projectId);
  }

  async function rename(
    projectId: string,
    name: string,
  ): Promise<ProjectRenameResult> {
    const result = await tracked(() => client.renameProject(projectId, name));
    projects.reload();
    return result;
  }

  async function move(body: {
    session_ids: string[];
    from_project_id: string;
    to_project_id: string;
    include_children: boolean;
  }): Promise<SessionsMoveResult> {
    const result = await tracked(() =>
      client.moveSessions({
        session_ids: body.session_ids,
        from_project_id: body.from_project_id,
        to_project: { id: body.to_project_id },
        include_children: body.include_children,
      }),
    );
    await bestEffort("project cache purge", () =>
      purgeProjectCache(body.from_project_id),
    );
    if (body.to_project_id !== body.from_project_id) {
      await bestEffort("project cache purge", () =>
        purgeProjectCache(body.to_project_id),
      );
    }
    projects.reload();
    return result;
  }

  async function clear(projectId: string): Promise<ProjectClearResult> {
    const result = await tracked(() => client.clearProject(projectId));
    await bestEffort("project cache purge", () => purgeProjectCache(projectId));
    projects.reload();
    return result;
  }

  async function remove(projectId: string): Promise<ProjectDeleteResult> {
    const result = await tracked(() => client.deleteProject(projectId));
    await bestEffort("project cache purge", () => purgeProjectCache(projectId));
    await bestEffort("project cache eviction", () =>
      projects.remove(projectId),
    );
    projects.reload();
    return result;
  }

  async function merge(): Promise<ProjectsMergeResult> {
    const result = await tracked(() => client.mergeProjects());
    // Ownership changed globally — every per-project projection is suspect.
    await bestEffort("merge cache purge", () =>
      Promise.all([
        repos.projects.clear(),
        repos.knowledge.clear(),
        repos.sessions.clear(),
        repos.messageBlocks.clear(),
        repos.projects.clearCollections(),
        repos.knowledge.clearCollections(),
        repos.sessions.clearCollections(),
        repos.messageBlocks.clearCollections(),
      ]),
    );
    projects.reload();
    return result;
  }

  return { purgeProjectCache, rename, move, clear, remove, merge };
}

export type ProjectActionsState = ReturnType<typeof createProjectActionsState>;
