import { test } from "node:test";
import assert from "node:assert/strict";
import { readJournalState } from "../src/lib/quest-journal.ts";

await test("valid URL choices independently override native initial choices", () => {
  assert.deepEqual(
    readJournalState(new URLSearchParams("chapter=knowledge&task=sqlite"), {
      chapter: "conversation",
      entry: "forms",
      task: "webhook",
    }),
    { chapter: "knowledge", entry: "forms", task: "sqlite" },
  );
});

await test("unknown, empty and object-property-like choices fall back safely", () => {
  for (const query of [
    "chapter=__proto__&entry=constructor&task=toString",
    "chapter=%22%5D%3Cscript%3E&entry=&task=javascript%3Aalert(1)",
  ]) {
    assert.deepEqual(readJournalState(new URLSearchParams(query)), {
      chapter: "conversation",
      entry: "webhook",
      task: "webhook",
    });
  }
});

await test("unrelated search parameters never become journal state", () => {
  assert.deepEqual(
    readJournalState(
      new URLSearchParams("agent=pi&view=usage&campaign=spring"),
    ),
    { chapter: "conversation", entry: "webhook", task: "webhook" },
  );
});
