// TypeScript inference cost of the 15 contract schemas per library:
// `tsc --noEmit --extendedDiagnostics` over the adapter (checked as JS) plus a
// probe file that materialises the inferred output type of every schema.
// Run: `npm run bench:ts`. Not part of CI.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LIBS = (
  process.env.BENCH_LIBS ?? "zod,zod-mini,valibot,typebox,arktype"
).split(",");
const here = new URL(".", import.meta.url).pathname;
const tsc = join(here, "../../../node_modules/typescript/bin/tsc");

const SCHEMAS = [
  "project",
  "knowledgeEntry",
  "knowledgeVersion",
  "sessionSummary",
  "message",
  "distillationSummary",
  "distillationDetail",
  "sessionDetail",
  "knowledgePage",
  "apiError",
  "account",
  "teams",
  "sharing",
  "syncStatus",
  "globalStats",
];

const OUTPUT_TYPE = {
  zod: (s) => `import("zod").infer<typeof S.${s}>`,
  "zod-mini": (s) => `import("zod/mini").infer<typeof S.${s}>`,
  valibot: (s) => `import("valibot").InferOutput<typeof S.${s}>`,
  typebox: (s) => `import("@sinclair/typebox").Static<typeof S.${s}>`,
  arktype: (s) => `(typeof S.${s})["infer"]`,
};

function parseDiagnostics(text) {
  const pick = (label) => {
    const m = text.match(new RegExp(`^${label}:\\s+([\\d.,]+)`, "m"));
    return m ? Number(m[1].replace(/,/g, "")) : null;
  };
  return {
    types: pick("Types"),
    instantiations: pick("Instantiations"),
    memoryMb: pick("Memory used")
      ? Math.round(pick("Memory used") / 1024)
      : null,
    checkS: pick("Check time"),
    totalS: pick("Total time"),
  };
}

const results = [];
for (const lib of LIBS) {
  const dir = mkdtempSync(join(tmpdir(), `ui-bench-ts-${lib}-`));
  const probe = SCHEMAS.map(
    (s) =>
      `export type T_${s} = ${OUTPUT_TYPE[lib](s)};\nexport const c_${s}: T_${s} = S.parse(S.${s}, {});`,
  ).join("\n");
  writeFileSync(
    join(dir, "probe.ts"),
    `import * as S from "${join(here, "schemas", `${lib}.mjs`)}";\n${probe}\n`,
  );
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        allowJs: true,
        checkJs: false,
        noEmit: true,
        skipLibCheck: true,
        types: [],
        baseUrl: here,
        paths: {
          zod: [join(here, "node_modules/zod")],
          "zod/*": [join(here, "node_modules/zod/*")],
          valibot: [join(here, "node_modules/valibot")],
          "@sinclair/typebox": [join(here, "node_modules/@sinclair/typebox")],
          "@sinclair/typebox/*": [
            join(here, "node_modules/@sinclair/typebox/*"),
          ],
          arktype: [join(here, "node_modules/arktype")],
        },
      },
      files: ["probe.ts"],
    }),
  );
  let out;
  try {
    out = execFileSync(
      process.execPath,
      [tsc, "-p", dir, "--extendedDiagnostics"],
      {
        encoding: "utf8",
      },
    );
  } catch (e) {
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  const errors = (out.match(/error TS\d+/g) ?? []).length;
  const row = { lib, ...parseDiagnostics(out), tsErrors: errors };
  results.push(row);
  console.error(JSON.stringify(row));
  if (process.env.BENCH_VERBOSE) console.error(out);
  rmSync(dir, { recursive: true, force: true });
}
console.table(results);
