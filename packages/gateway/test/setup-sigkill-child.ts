import { commandSetup } from "../src/cli/setup";
import { _setTrustedFileCommitHookForTest } from "../src/cli/json-config";

const [agent, operation, rawCommit] = process.argv.slice(2);
const killAfterCommit = Number(rawCommit);
if (
  !["claude-code", "opencode", "pi"].includes(agent) ||
  (operation !== "setup" && operation !== "undo") ||
  !Number.isInteger(killAfterCommit)
) {
  throw new Error("Expected an agent, setup|undo, and a commit number.");
}

_setTrustedFileCommitHookForTest((_file, commit) => {
  if (commit === killAfterCommit) process.kill(process.pid, "SIGKILL");
});

await commandSetup(
  operation === "setup" ? [agent] : ["undo", agent],
  operation === "setup"
    ? { port: 3299, ...(agent === "opencode" ? { noPlugin: true } : {}) }
    : {},
);
