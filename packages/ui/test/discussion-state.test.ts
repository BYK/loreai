import { describe, expect, it } from "vitest";

import { createDiscussionsState } from "~/state/discussions";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const page = (...ids: string[]) => ({
  discussions: ids.map((id) => ({ id })),
  next_cursor: null,
});

describe("discussion state", () => {
  it("keeps the latest source load when an older one resolves last", async () => {
    const calls: ReturnType<typeof deferred<ReturnType<typeof page>>>[] = [];
    const client = {
      listDiscussions: () => {
        const call = deferred<ReturnType<typeof page>>();
        calls.push(call);
        return call.promise;
      },
    } as never;
    const state = createDiscussionsState({
      client,
      tracked: (read) => read(),
      db: () => Promise.resolve(null),
    });
    const source = { kind: "session", id: "s1" } as const;

    const older = state.loadSource("p1", source);
    const newer = state.loadSource("p1", source);
    calls[1]!.resolve(page("d2", "d1"));
    await newer;
    calls[0]!.resolve(page("d1"));
    await older;

    expect(state.forSource("p1", source).map((d) => d.id)).toEqual([
      "d2",
      "d1",
    ]);
    expect(state.sourceState("p1", source).loading).toBe(false);
  });
});
