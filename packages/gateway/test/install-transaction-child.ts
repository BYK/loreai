import { join } from "node:path";
import {
  _setInstallPublicationHookForTest,
  stageInstallFile,
  commitInstallTransaction,
} from "../src/cli/lib/install-transaction";
const [home, phase] = process.argv.slice(2);
if (phase === "profile") {
  const { installStandalone } = await import("../src/cli/install");
  _setInstallPublicationHookForTest((at, path) => {
    if (at === "quarantined" && path === join(home, ".profile"))
      process.exit(17);
  });
  await installStandalone({
    home,
    source: join(home, "candidate"),
    channel: "stable",
    env: {},
  });
  process.exit(0);
}
const files = [
  stageInstallFile(join(home, "binary"), "new binary", 0o700),
  stageInstallFile(join(home, "receipt"), "new receipt", 0o600),
];
_setInstallPublicationHookForTest((at) => {
  if (at === phase) process.exit(17);
});
commitInstallTransaction(
  join(home, "journal"),
  files,
  () => {},
  () => {},
  undefined,
  "old epoch",
);
