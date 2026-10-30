import { expect, test } from "vitest";
import { piTurnGroup, singlePendingPiTurn } from "../src/recall-turns";

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
