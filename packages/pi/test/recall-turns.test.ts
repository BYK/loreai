import { expect, test } from "vitest";
import {
  piTurnGroup,
  singlePendingPiTurn,
  singlePiRequestOwner,
  trackPiRequestOwner,
  startPiTurn,
} from "../src/recall-turns";

test("a shared interceptor selects only one scoped pending owner across factories", () => {
  const gateway = `http://gateway-${crypto.randomUUID()}`;
  const first = piTurnGroup(gateway, "/a", "session-a", true)!;
  const second = piTurnGroup(gateway, "/b", "session-b", true)!;
  const turnA = { projectPath: "/a", sessionID: "session-a", turnID: "a" };
  const turnB = { projectPath: "/b", sessionID: "session-b", turnID: "b" };
  first.pending.set("a", turnA);
  expect(singlePendingPiTurn(gateway)).toEqual(turnA);
  second.pending.set("b", turnB);
  expect(singlePendingPiTurn(gateway)).toBeUndefined();
  expect(
    singlePendingPiTurn(
      gateway,
      new Headers({ "x-lore-project": "/a", "x-lore-session-id": "session-a" }),
    ),
  ).toEqual(turnA);
  first.ambiguous = true;
  expect(
    singlePendingPiTurn(gateway, new Headers({ "x-lore-project": "/a" })),
  ).toBeUndefined();
  expect(
    singlePendingPiTurn(
      gateway,
      new Headers({ "x-lore-project": "/b", "x-lore-session-id": "session-b" }),
    ),
  ).toEqual(turnB);
  expect(
    singlePendingPiTurn(
      gateway,
      new Headers({ "x-lore-project": "/b", "x-lore-session-id": "session-a" }),
    ),
  ).toBeUndefined();
});

test("live metadata ownership is scoped, updated, bounded and retired independently", () => {
  const gateway = `http://gateway-${crypto.randomUUID()}`;
  const metadata = {
    projectPath: "/a",
    sessionID: "session-a",
    gitRemote: "git-a",
    sessionTitle: "Title A",
  };
  const first = trackPiRequestOwner(gateway, "first", metadata);
  expect(singlePiRequestOwner(gateway)?.metadata).toEqual(metadata);
  const second = trackPiRequestOwner(gateway, "second", {
    ...metadata,
    projectPath: "/b",
    sessionID: "session-b",
  });
  expect(singlePiRequestOwner(gateway)).toBeUndefined();
  expect(
    singlePiRequestOwner(gateway, new Headers({ "x-lore-project": "/a" }))
      ?.ownerID,
  ).toBe("first");
  expect(
    singlePiRequestOwner(
      gateway,
      new Headers({ "x-lore-project": "/a", "x-lore-session-id": "session-b" }),
    ),
  ).toBeUndefined();
  second.update({ ...metadata, sessionTitle: "Different owner, same scope" });
  expect(
    singlePiRequestOwner(gateway, new Headers({ "x-lore-project": "/a" })),
  ).toBeUndefined();
  first.retire();
  expect(singlePiRequestOwner(gateway)?.metadata.sessionTitle).toBe(
    "Different owner, same scope",
  );
  first.retire();
  const overflow = Array.from({ length: 256 }, (_, index) =>
    trackPiRequestOwner(gateway, `extra-${index}`, {
      ...metadata,
      projectPath: `/extra-${index}`,
    }),
  );
  expect(
    singlePiRequestOwner(gateway, new Headers({ "x-lore-project": "/a" })),
  ).toBeUndefined();
  overflow.at(-1)!.retire();
  expect(
    singlePiRequestOwner(gateway, new Headers({ "x-lore-project": "/a" }))
      ?.ownerID,
  ).toBe("second");
  for (const owner of overflow) owner.retire();
  second.retire();
  expect(singlePiRequestOwner(gateway)).toBeUndefined();
});

test("a pending nonce belongs to the selected live factory", () => {
  const gateway = `http://gateway-${crypto.randomUUID()}`;
  const group = piTurnGroup(gateway, "/project", "session", true)!;
  const turn = {
    projectPath: "/project",
    sessionID: "session",
    turnID: "nonce",
  };
  startPiTurn(group, "first", turn);
  expect(singlePendingPiTurn(gateway, undefined, "first")).toEqual(turn);
  expect(singlePendingPiTurn(gateway, undefined, "other")).toBeUndefined();
});
