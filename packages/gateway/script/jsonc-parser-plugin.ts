import type * as esbuild from "esbuild";
import { createRequire } from "node:module";
import { join } from "node:path";

/**
 * Bundle jsonc-parser through its static ESM entry.
 *
 * The package's default UMD entry performs factory-scoped relative requires
 * such as `./impl/format`. Esbuild cannot discover those calls, leaving broken
 * runtime lookups in otherwise self-contained npm and SEA bundles.
 */
export function jsoncParserEsmPlugin(packageDir: string): esbuild.Plugin {
  const jsoncParserEsmEntry = createRequire(
    join(packageDir, "package.json"),
  ).resolve("jsonc-parser/lib/esm/main.js");

  return {
    name: "jsonc-parser-esm",
    setup(build) {
      build.onResolve({ filter: /^jsonc-parser$/ }, () => ({
        path: jsoncParserEsmEntry,
      }));
    },
  };
}
