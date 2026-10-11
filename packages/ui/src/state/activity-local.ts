import { createSignal } from "solid-js";

import type { ActivityFolderRecord, ActivityStateRecord, LoreUiDb } from "~/db";

export interface ActivityLocalSnapshot {
  records: Readonly<Record<string, ActivityStateRecord>>;
  folders: readonly ActivityFolderRecord[];
}

const EMPTY_SNAPSHOT: ActivityLocalSnapshot = { records: {}, folders: [] };

export function markRead(
  record: ActivityStateRecord,
  total: number,
  now: number,
): ActivityStateRecord {
  return { ...record, read_total: Math.max(0, total), read_at: now };
}

export function markReadTo(
  record: ActivityStateRecord,
  total: number,
  now: number,
): ActivityStateRecord {
  return {
    ...record,
    read_total: Math.max(record.read_total ?? 0, total, 0),
    read_at: now,
  };
}

export function markUnread(
  record: ActivityStateRecord,
  now: number,
): ActivityStateRecord {
  return { ...record, read_total: 0, read_at: now };
}

export function archive(
  record: ActivityStateRecord,
  now: number,
): ActivityStateRecord {
  return { ...record, archived_at: now };
}

export function unarchive(record: ActivityStateRecord): ActivityStateRecord {
  const { archived_at: _, ...next } = record;
  return next;
}

export function pin(
  record: ActivityStateRecord,
  now: number,
): ActivityStateRecord {
  return { ...record, pinned_at: now };
}

export function unpin(record: ActivityStateRecord): ActivityStateRecord {
  const { pinned_at: _, ...next } = record;
  return next;
}

export function folderNameError(
  name: string,
  folders: readonly ActivityFolderRecord[],
  excludeId?: string,
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Folder name is required";
  if (
    folders.some(
      (folder) =>
        folder.key !== excludeId &&
        folder.name.toLowerCase() === trimmed.toLowerCase(),
    )
  ) {
    return "A folder with this name already exists";
  }
  return null;
}

export function createFolder(
  folders: readonly ActivityFolderRecord[],
  name: string,
  key: string = crypto.randomUUID(),
  createdAt = Date.now(),
): ActivityFolderRecord[] {
  const error = folderNameError(name, folders);
  if (error) throw new Error(error);
  return [
    ...folders,
    { key, name: name.trim(), keys: [], created_at: createdAt },
  ];
}

export function renameFolder(
  folders: readonly ActivityFolderRecord[],
  key: string,
  name: string,
): ActivityFolderRecord[] {
  const error = folderNameError(name, folders, key);
  if (error) throw new Error(error);
  return folders.map((folder) =>
    folder.key === key ? { ...folder, name: name.trim() } : folder,
  );
}

export function deleteFolder(
  folders: readonly ActivityFolderRecord[],
  key: string,
): ActivityFolderRecord[] {
  return folders.filter((folder) => folder.key !== key);
}

export function moveToFolder(
  folders: readonly ActivityFolderRecord[],
  keys: readonly string[],
  folderId: string,
): ActivityFolderRecord[] {
  if (!folders.some((folder) => folder.key === folderId)) {
    throw new Error("Folder not found");
  }
  const selected = new Set(keys);
  return folders.map((folder) => ({
    ...folder,
    keys:
      folder.key === folderId
        ? [...new Set([...folder.keys, ...keys])]
        : folder.keys.filter((key) => !selected.has(key)),
  }));
}

export function createActivityLocalState(
  getDb: () => Promise<LoreUiDb | null>,
) {
  const [snapshot, setSnapshot] =
    createSignal<ActivityLocalSnapshot>(EMPTY_SNAPSHOT);
  const [loaded, setLoaded] = createSignal(false);
  const recordTransitions = new Map<
    string,
    Array<(record: ActivityStateRecord) => ActivityStateRecord>
  >();
  const folderTransitions: Array<
    (folders: readonly ActivityFolderRecord[]) => ActivityFolderRecord[]
  > = [];
  const pendingWrites = new Set<Promise<void>>();

  const ready = getDb()
    .then(async (db) => {
      const [records, folders] = db
        ? await Promise.all([
            db.getAll("activityState"),
            db.getAll("activityFolders"),
          ])
        : [[], []];
      const recordMap = Object.fromEntries(
        records.map((record) => [record.key, record]),
      );
      const changed = new Map<string, ActivityStateRecord>();
      for (const [key, transitions] of recordTransitions) {
        let record = recordMap[key] ?? { key };
        for (const transition of transitions) record = transition(record);
        recordMap[key] = record;
        changed.set(key, record);
      }
      const nextFolders = folderTransitions.reduce<ActivityFolderRecord[]>(
        (current, transition) => {
          try {
            return transition(current);
          } catch {
            return current;
          }
        },
        folders,
      );
      let replayWrite: Promise<void> | undefined;
      if (db && (changed.size > 0 || folderTransitions.length > 0)) {
        const tx = db.transaction(
          ["activityState", "activityFolders"],
          "readwrite",
        );
        const ops: Promise<unknown>[] = [];
        for (const record of changed.values()) {
          ops.push(tx.objectStore("activityState").put(record));
        }
        if (folderTransitions.length > 0) {
          const nextKeys = new Set(nextFolders.map((folder) => folder.key));
          for (const folder of folders) {
            if (!nextKeys.has(folder.key)) {
              ops.push(tx.objectStore("activityFolders").delete(folder.key));
            }
          }
          for (const folder of nextFolders) {
            ops.push(tx.objectStore("activityFolders").put(folder));
          }
        }
        replayWrite = Promise.all([...ops, tx.done]).then(() => undefined);
      }
      setSnapshot({ records: recordMap, folders: nextFolders });
      setLoaded(true);
      recordTransitions.clear();
      folderTransitions.length = 0;
      if (replayWrite) {
        trackWrite(replayWrite);
        await replayWrite;
      }
      return db;
    })
    .catch(() => {
      setLoaded(true);
      return null;
    });

  function trackWrite(write: Promise<void>) {
    const tracked = write.catch(() => undefined);
    pendingWrites.add(tracked);
    void tracked.then(() => pendingWrites.delete(tracked));
  }

  function applyBatch(
    transitions: readonly {
      key: string;
      transition: (record: ActivityStateRecord) => ActivityStateRecord;
    }[],
  ) {
    if (transitions.length === 0) return;
    const current = snapshot();
    const records = { ...current.records };
    const changed = new Map<string, ActivityStateRecord>();
    for (const { key, transition } of transitions) {
      const next = transition(changed.get(key) ?? records[key] ?? { key });
      records[key] = next;
      changed.set(key, next);
      if (!loaded()) {
        const queued = recordTransitions.get(key) ?? [];
        queued.push(transition);
        recordTransitions.set(key, queued);
      }
    }
    setSnapshot({ ...current, records });
    if (loaded()) {
      trackWrite(
        ready.then(async (db) => {
          if (!db) return;
          const tx = db.transaction("activityState", "readwrite");
          for (const record of changed.values()) await tx.store.put(record);
          await tx.done;
        }),
      );
    }
  }

  function updateRecord(
    key: string,
    transition: (record: ActivityStateRecord) => ActivityStateRecord,
  ) {
    applyBatch([{ key, transition }]);
  }

  function updateFolders(
    transition: (
      folders: readonly ActivityFolderRecord[],
    ) => ActivityFolderRecord[],
  ) {
    if (!loaded()) folderTransitions.push(transition);
    const previous = snapshot().folders;
    let next = previous as ActivityFolderRecord[];
    try {
      next = transition(previous);
    } catch (error) {
      if (loaded()) throw error;
    }
    setSnapshot((current) => ({ ...current, folders: next }));
    if (loaded()) {
      trackWrite(
        ready.then(async (db) => {
          if (!db) return;
          const tx = db.transaction("activityFolders", "readwrite");
          const nextKeys = new Set(next.map((folder) => folder.key));
          for (const folder of previous) {
            if (!nextKeys.has(folder.key)) await tx.store.delete(folder.key);
          }
          for (const folder of next) await tx.store.put(folder);
          await tx.done;
        }),
      );
    }
  }

  return {
    snapshot,
    loaded,
    ready,
    flush: () =>
      ready.then(() => Promise.all(pendingWrites)).then(() => undefined),
    record: (key: string) => snapshot().records[key] ?? { key },
    applyBatch,
    markRead: (key: string, total: number, now = Date.now()) =>
      updateRecord(key, (record) => markRead(record, total, now)),
    markReadTo: (key: string, total: number, now = Date.now()) =>
      updateRecord(key, (record) => markReadTo(record, total, now)),
    markUnread: (key: string, now = Date.now()) =>
      updateRecord(key, (record) => markUnread(record, now)),
    archive: (key: string, now = Date.now()) =>
      updateRecord(key, (record) => archive(record, now)),
    unarchive: (key: string) => updateRecord(key, unarchive),
    pin: (key: string, now = Date.now()) =>
      updateRecord(key, (record) => pin(record, now)),
    unpin: (key: string) => updateRecord(key, unpin),
    createFolder(name: string, key?: string, createdAt?: number) {
      const id = key ?? crypto.randomUUID();
      const timestamp = createdAt ?? Date.now();
      updateFolders((folders) => createFolder(folders, name, id, timestamp));
      return id;
    },
    renameFolder(key: string, name: string) {
      updateFolders((folders) => renameFolder(folders, key, name));
    },
    deleteFolder(key: string) {
      updateFolders((folders) => deleteFolder(folders, key));
    },
    moveToFolder(keys: readonly string[], folderId: string) {
      const selected = [...keys];
      updateFolders((folders) => moveToFolder(folders, selected, folderId));
    },
  };
}

export type ActivityLocalState = ReturnType<typeof createActivityLocalState>;
