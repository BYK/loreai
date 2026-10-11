import { beforeEach, describe, expect, it } from "vitest";

import {
  resetSavedSearchesForTests,
  SAVED_SEARCHES_STORAGE_KEY,
  savedSearches,
} from "~/state/saved-searches";

describe("saved searches", () => {
  beforeEach(() => {
    localStorage.clear();
    resetSavedSearchesForTests();
  });

  it("persists create, edit, and delete operations", () => {
    const store = savedSearches();
    const created = store.save({ title: "Sessions", query: "type:session" });
    expect(store.list()).toEqual([created]);
    expect(
      JSON.parse(localStorage.getItem(SAVED_SEARCHES_STORAGE_KEY) ?? "[]"),
    ).toEqual([created]);

    store.update(created.id, {
      title: "Recent sessions",
      query: "type:session",
    });
    expect(store.list()[0]).toMatchObject({ title: "Recent sessions" });

    store.remove(created.id);
    expect(store.list()).toEqual([]);
  });

  it("ignores malformed stored values", () => {
    localStorage.setItem(SAVED_SEARCHES_STORAGE_KEY, '{"bad":true}');
    expect(savedSearches().list()).toEqual([]);
  });
});
