import { acquireLifecycleLock } from "../src/lifecycle-lock";

const [phase, lockPath] = process.argv.slice(2);
if (
  !lockPath ||
  ![
    "crash-initialize",
    "crash-recovery",
    "crash-release",
    "acquire-release",
  ].includes(phase)
) {
  throw new Error("Expected a lifecycle crash phase and lock path");
}

const kill = () => process.kill(process.pid, "SIGKILL");
const lock = await acquireLifecycleLock("upgrade", {
  lockPath,
  timeoutMs: 5_000,
  _afterLockDirectoryCreated: phase === "crash-initialize" ? kill : undefined,
  _afterLockRecoveryValidated: phase === "crash-recovery" ? kill : undefined,
  _afterLockOwnerRemoved: phase === "crash-release" ? kill : undefined,
});

lock.release();

if (phase !== "acquire-release") {
  throw new Error(`Crash injection did not fire for ${phase}`);
}
