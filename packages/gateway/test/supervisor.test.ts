import { describe, expect, test } from "vitest";
import {
  SUPERVISED_CHILD_ENV,
  SUPERVISOR_PID_ENV,
  requestGracefulGatewayShutdown,
  shouldSuperviseGatewayCommand,
} from "../src/cli/supervisor";
import { SHUTDOWN_REQUEST_MESSAGE } from "../src/cli/supervision-protocol";
import { supervisedGatewayOwnerPid } from "../src/cli/supervision-protocol";

describe("shouldSuperviseGatewayCommand", () => {
  test("supervises only foreground start commands", () => {
    expect(shouldSuperviseGatewayCommand(["start"], {})).toBe(true);
    expect(shouldSuperviseGatewayCommand(["start", "--local"], {})).toBe(true);
    expect(shouldSuperviseGatewayCommand(["run"], {})).toBe(false);
    expect(shouldSuperviseGatewayCommand(["version"], {})).toBe(false);
  });

  test("recognizes start after supported leading options", () => {
    expect(
      shouldSuperviseGatewayCommand(["--local", "--port", "0", "start"]),
    ).toBe(true);
    expect(shouldSuperviseGatewayCommand(["--remote", "start", "run"])).toBe(
      false,
    );
  });

  test.each(["--bg", "--daemon", "--bg=true", "--daemon=true"])(
    "does not supervise daemon mode %s",
    (flag) => {
      expect(shouldSuperviseGatewayCommand(["start", flag], {})).toBe(false);
    },
  );

  test.each(["false", "f", "no", "n", "off", "0"])(
    "supervises Stricli's explicit false boolean %s",
    (value) => {
      expect(
        shouldSuperviseGatewayCommand(["start", `--bg=${value}`], {}),
      ).toBe(true);
      expect(
        shouldSuperviseGatewayCommand(["start", `--daemon=${value}`], {}),
      ).toBe(true);
    },
  );

  test("matches legacy truthiness when options precede start", () => {
    expect(
      shouldSuperviseGatewayCommand(["--local", "start", "--bg=false"], {}),
    ).toBe(false);
  });

  test("does not recursively supervise its child", () => {
    expect(
      shouldSuperviseGatewayCommand(["start"], {
        [SUPERVISED_CHILD_ENV]: "1",
        [SUPERVISOR_PID_ENV]: "4242",
      }),
    ).toBe(false);
  });

  test("never recursively supervises a marked child with a lost parent", () => {
    expect(
      shouldSuperviseGatewayCommand(["start"], {
        [SUPERVISED_CHILD_ENV]: "1",
        [SUPERVISOR_PID_ENV]: "4242",
      }),
    ).toBe(false);
  });

  test("accepts only the IPC-connected direct parent as process owner", () => {
    const env = {
      [SUPERVISED_CHILD_ENV]: "1",
      [SUPERVISOR_PID_ENV]: "4242",
    };
    expect(supervisedGatewayOwnerPid(env, 4242, true)).toBe(4242);
    expect(supervisedGatewayOwnerPid(env, 4243, true)).toBeNull();
    expect(supervisedGatewayOwnerPid(env, 4242, false)).toBeNull();
  });
});

test("graceful forwarding uses IPC instead of OS signal emulation", () => {
  const messages: unknown[] = [];
  const child = {
    connected: true,
    send(message: unknown) {
      messages.push(message);
      return true;
    },
  };

  expect(requestGracefulGatewayShutdown(child, "SIGTERM")).toBe(true);
  expect(messages).toEqual([
    { type: SHUTDOWN_REQUEST_MESSAGE, signal: "SIGTERM" },
  ]);
});
