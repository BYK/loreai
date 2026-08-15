import {
  preflightRemoval,
  removePath,
  removePathBlocks,
} from "../src/cli/uninstall";

const [operation, home, target, installDir] = process.argv.slice(2);
if ((operation !== "profile" && operation !== "purge") || !home || !target) {
  throw new Error(
    "Expected profile|purge, home, target, and optional install directory.",
  );
}

if (operation === "profile") {
  if (!installDir)
    throw new Error("Profile crash requires an install directory.");
  removePathBlocks(installDir, () => {}, home, {
    beforeProfilePublish: (path) => {
      if (path === target) process.kill(process.pid, "SIGKILL");
    },
  });
} else {
  const identity = preflightRemoval(target, true, home);
  removePath(target, true, identity, home, {
    afterQuarantine: () => process.kill(process.pid, "SIGKILL"),
  });
}
