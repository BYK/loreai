import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const resultDir = resolve(
  process.env.SPIKE_RESULTS_DIR ?? "../../../spike-results",
);
const packageName = "@automerge/automerge-repo";
const distTags = JSON.parse(
  execFileSync("npm", ["view", packageName, "dist-tags", "--json"], {
    encoding: "utf8",
  }),
);
const versions = JSON.parse(
  execFileSync("npm", ["view", packageName, "versions", "--json"], {
    encoding: "utf8",
  }),
);
const stable2x = versions
  .filter((version) => /^2\.\d+\.\d+$/.test(version))
  .sort((left, right) => {
    const a = left.split(".").map(Number);
    const b = right.split(".").map(Number);
    return b[0] - a[0] || b[1] - a[1] || b[2] - a[2];
  })[0];
const report = { package: packageName, distTags, latestStable2x: stable2x };
await mkdir(resultDir, { recursive: true });
await writeFile(
  resolve(resultDir, "automerge-repo-dist-tags.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));
