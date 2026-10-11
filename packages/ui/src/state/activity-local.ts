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
  const pendingRecords = new Map<string, ActivityStateRecord>();
  const pendingFolders = new Map<string, ActivityFolderRecord | null>();
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
      for (const [key, record] of pendingRecords) recordMap[key] = record;
      const folderMap = new Map(folders.map((folder) => [folder.key, folder]));
      for (const [key, folder] of pendingFolders) {
        if (folder) folderMap.set(key, folder);
        else folderMap.delete(key);
      }
      setSnapshot({ records: recordMap, folders: [...folderMap.values()] });
      setLoaded(true);
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

  function updateRecord(
    key: string,
    transition: (record: ActivityStateRecord) => ActivityStateRecord,
  ) {
    let next!: ActivityStateRecord;
    setSnapshot((current) => {
      next = transition(current.records[key] ?? { key });
      return {
        ...current,
        records: { ...current.records, [key]: next },
      };
    });
    pendingRecords.set(key, next);
    trackWrite(
      ready.then(async (db) => {
        if (db) await db.put("activityState", next);
      }),
    );
  }

  function replaceFolders(next: ActivityFolderRecord[]) {
    const previous = snapshot().folders;
    const nextMap = new Map(next.map((folder) => [folder.key, folder]));
    const previousMap = new Map(previous.map((folder) => [folder.key, folder]));
    for (const key of new Set([...previousMap.keys(), ...nextMap.keys()])) {
      pendingFolders.set(key, nextMap.get(key) ?? null);
    }
    setSnapshot((current) => ({ ...current, folders: next }));
    trackWrite(
      ready.then(async (db) => {
        if (!db) return;
        const tx = db.transaction("activityFolders", "readwrite");
        for (const [key, folder] of pendingFolders) {
          if (folder) await tx.store.put(folder);
          else await tx.store.delete(key);
        }
        await tx.done;
      }),
    );
  }

  return {
    snapshot,
    loaded,
    ready,
    flush: () => Promise.all(pendingWrites).then(() => undefined),
    record: (key: string) => snapshot().records[key] ?? { key },
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
      replaceFolders(
        createFolder(snapshot().folders, name, id, createdAt ?? Date.now()),
      );
      return id;
    },
    renameFolder(key: string, name: string) {
      replaceFolders(renameFolder(snapshot().folders, key, name));
    },
    deleteFolder(key: string) {
      replaceFolders(deleteFolder(snapshot().folders, key));
    },
    moveToFolder(keys: readonly string[], folderId: string) {
      replaceFolders(moveToFolder(snapshot().folders, keys, folderId));
    },
  };
}

export type ActivityLocalState = ReturnType<typeof createActivityLocalState>;
