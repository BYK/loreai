import {
  _setSetupExternalEffectHookForTest,
  commandSetup,
} from "../src/cli/setup";

const [killPhase] = process.argv.slice(2);
if (
  killPhase !== "after-installed-journal" &&
  killPhase !== "before-journal-cleanup"
) {
  throw new Error("Expected an external-effect crash phase.");
}

_setSetupExternalEffectHookForTest((phase) => {
  if (phase === killPhase) {
    process.kill(process.pid, "SIGKILL");
  }
});

await commandSetup(["opencode"], { port: 3299 });
