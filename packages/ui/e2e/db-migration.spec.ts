import { expect, test, type Page } from "@playwright/test";

const STORES = [
  "meta",
  "projects",
  "knowledge",
  "sessions",
  "messageBlocks",
  "collections",
  "drafts",
  "pendingChanges",
] as const;

async function deleteDatabase(page: Page) {
  await page.evaluate(async () => {
    const req = indexedDB.deleteDatabase("lore-ui");
    await new Promise<void>((resolve, reject) => {
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  });
}

async function createV1(page: Page) {
  await deleteDatabase(page);
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("lore-ui", 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore("meta", { keyPath: "key" });
        store.put({ key: "e2e-legacy", value: "kept" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
  });
}

async function openInfo(page: Page) {
  return page.evaluate(async () => {
    const names = (await indexedDB.databases()).find(
      (db) => db.name === "lore-ui",
    );
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("lore-ui");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const indexes: Record<string, string[]> = {};
    for (const name of Array.from(db.objectStoreNames)) {
      if (
        ["projects", "knowledge", "sessions", "messageBlocks"].includes(name)
      ) {
        const tx = db.transaction(name);
        indexes[name] = Array.from(tx.objectStore(name).indexNames);
      } else if (name === "drafts") {
        const tx = db.transaction(name);
        indexes[name] = Array.from(tx.objectStore(name).indexNames);
      } else if (name === "pendingChanges") {
        const tx = db.transaction(name);
        indexes[name] = Array.from(tx.objectStore(name).indexNames);
      }
    }
    const legacy = db.transaction("meta").objectStore("meta").get("e2e-legacy");
    const legacyValue = await new Promise<unknown>((resolve, reject) => {
      legacy.onsuccess = () => resolve(legacy.result);
      legacy.onerror = () => reject(legacy.error);
    });
    const stores = Array.from(db.objectStoreNames);
    db.close();
    return { version: names?.version, stores, indexes, legacyValue };
  });
}

test.describe("IndexedDB cache migrations and recovery", () => {
  test("upgrades v1 without dropping meta and creates the complete v2 schema", async ({
    page,
  }) => {
    await page.goto("/ui");
    await createV1(page);
    await page.reload();
    await expect(page.getByTestId("connection-status")).toBeVisible();
    const info = await openInfo(page);
    expect(info.version).toBe(2);
    expect(info.stores.sort()).toEqual([...STORES].sort());
    for (const name of ["projects", "knowledge", "sessions", "messageBlocks"]) {
      expect(info.indexes[name]?.sort()).toEqual(
        ["by-scope", "by-accessed", "by-stored"].sort(),
      );
    }
    expect(info.indexes.drafts).toEqual(["by-updated"]);
    expect(info.indexes.pendingChanges).toEqual(["by-created"]);
    expect(info.legacyValue).toEqual({ key: "e2e-legacy", value: "kept" });
  });

  test("server replaces a consumed stale cache record", async ({ page }) => {
    const projects = await (await page.request.get("/api/v1/projects")).json();
    const project = projects.find(
      (item: { name: string }) => item.name === "lore",
    );
    const entries = await (
      await page.request.get(`/api/v1/projects/${project.id}/knowledge`)
    ).json();
    const entry = entries[0];
    await page.goto("/ui");
    await deleteDatabase(page);
    await page.evaluate(
      ({ project, entry, count }) =>
        new Promise<void>((resolve, reject) => {
          const req = indexedDB.open("lore-ui", 2);
          req.onupgradeneeded = () => {
            const db = req.result;
            db.createObjectStore("meta", { keyPath: "key" });
            for (const name of [
              "projects",
              "knowledge",
              "sessions",
              "messageBlocks",
            ]) {
              const store = db.createObjectStore(name, { keyPath: "key" });
              store.createIndex("by-scope", "scope");
              store.createIndex("by-accessed", "accessedAt");
              store.createIndex("by-stored", "storedAt");
            }
            db.createObjectStore("collections", { keyPath: "key" });
            const drafts = db.createObjectStore("drafts", { keyPath: "key" });
            drafts.createIndex("by-updated", "updatedAt");
            const pending = db.createObjectStore("pendingChanges", {
              keyPath: "key",
            });
            pending.createIndex("by-created", "createdAt");
            const tx = req.transaction!;
            tx.objectStore("projects").put({
              key: project.id,
              scope: "all",
              value: { ...project, name: "STALE CACHED TITLE" },
              storedAt: Date.now(),
              accessedAt: 1,
            });
            tx.objectStore("knowledge").put({
              key: entry.id,
              scope: project.id,
              value: { ...entry, title: "STALE CACHED TITLE" },
              storedAt: Date.now(),
              accessedAt: 1,
            });
            tx.objectStore("collections").put({
              key: `knowledge:${project.id}`,
              store: "knowledge",
              scope: project.id,
              complete: true,
              count,
              nextCursor: null,
              fetchedAt: Date.now(),
            });
          };
          req.onsuccess = () => {
            req.result.close();
            resolve();
          };
          req.onerror = () => reject(req.error);
        }),
      { project, entry, count: entries.length },
    );
    await page.goto(`/ui/projects/${project.id}/knowledge`);
    await expect(
      page.getByTestId("knowledge-row").filter({ hasText: entry.title }),
    ).toBeVisible();
    await expect(page.getByText("STALE CACHED TITLE")).toHaveCount(0);
    await expect(page.getByTestId("stale-indicator")).toHaveCount(0);
    const accessed = await page.evaluate(async (id) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open("lore-ui");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const row = await new Promise<{ accessedAt?: number } | undefined>(
        (resolve, reject) => {
          const req = db
            .transaction("knowledge")
            .objectStore("knowledge")
            .get(id);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        },
      );
      db.close();
      return row?.accessedAt;
    }, entry.id);
    expect(accessed).toBeGreaterThan(1);
  });

  test("recreates a corrupted v2 database with server data", async ({
    page,
  }) => {
    await page.goto("/ui");
    await deleteDatabase(page);
    await page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const req = indexedDB.open("lore-ui", 2);
          req.onupgradeneeded = () => {
            req.result.createObjectStore("meta", { keyPath: "key" });
          };
          req.onsuccess = () => {
            req.result.close();
            resolve();
          };
          req.onerror = () => reject(req.error);
        }),
    );
    await page.reload();
    await expect(page.getByTestId("connection-status")).toBeVisible();
    expect((await openInfo(page)).stores.sort()).toEqual([...STORES].sort());
  });

  test("resets a future-version database and renders server data", async ({
    page,
  }) => {
    await page.goto("/ui");
    await deleteDatabase(page);
    await page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const req = indexedDB.open("lore-ui", 3);
          req.onupgradeneeded = () =>
            req.result.createObjectStore("meta", { keyPath: "key" });
          req.onsuccess = () => {
            req.result.close();
            resolve();
          };
          req.onerror = () => reject(req.error);
        }),
    );
    await page.reload();
    await expect(page.getByTestId("connection-status")).toBeVisible();
    expect((await openInfo(page)).version).toBe(2);
  });

  test("survives user-cleared site data during SPA navigation", async ({
    page,
  }) => {
    await page.goto("/ui");
    await expect(page.getByTestId("connection-status")).toBeVisible();
    await page.evaluate(async () => {
      const req = indexedDB.deleteDatabase("lore-ui");
      await new Promise<void>((resolve, reject) => {
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    });
    const navProject = page
      .getByTestId("nav-project")
      .filter({ hasText: "lore" });
    if (await navProject.isVisible()) {
      await navProject.click();
    } else {
      await page.getByTestId("open-nav").click();
      await page
        .getByTestId("nav-drawer")
        .getByTestId("nav-project")
        .filter({
          hasText: "lore",
        })
        .click();
    }
    await expect(page.getByTestId("health")).toContainText("knowledge");
    await expect(
      page.getByText(/Project not found or inaccessible|Something went wrong/),
    ).toHaveCount(0);
    await page.reload();
    await expect
      .poll(async () => {
        const databases = await page.evaluate(() => indexedDB.databases());
        return databases.find((db) => db.name === "lore-ui")?.version;
      })
      .toBe(2);
    expect((await openInfo(page)).version).toBe(2);
  });
});
