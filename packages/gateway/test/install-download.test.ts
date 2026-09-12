import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { afterAll, beforeAll, expect, it } from "vitest";
import { jsoncParserEsmPlugin } from "../script/jsonc-parser-plugin";
const installer = resolve(import.meta.dirname, "../../website/public/install");
const legacy = resolve(import.meta.dirname, "fixtures/install-v1.sh");
const root = realpathSync(mkdtempSync(join(tmpdir(), "lore-download-test-")));
let binary: Buffer;
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `import { installStandalone } from "../src/cli/install"; import { parseArgs } from "node:util";
 if(process.env.TEST_WINDOWS_HOME && process.env.USERPROFILE !== process.env.HOME) throw new Error("Windows HOME mismatch");
 if(process.argv.includes("--version")){console.log("0.42.0");}else{const {values}=parseArgs({allowPositionals:true,options:{install:{type:"boolean"},channel:{type:"string"},"source-sha256":{type:"string"},"observed-tombstone":{type:"string"},"no-modify-path":{type:"boolean"},"path-install-dir":{type:"string"}}});
 installStandalone({source:process.argv[1],channel:values.channel as "stable"|"nightly",expectedSha256:values["source-sha256"],observedTombstone:values["observed-tombstone"],noModifyPath:values["no-modify-path"]}).catch(error=>{console.error(error);process.exitCode=1;});}`,
      resolveDir: import.meta.dirname,
      loader: "ts",
    },
    bundle: true,
    plugins: [jsoncParserEsmPlugin(resolve(import.meta.dirname, ".."))],
    platform: "node",
    format: "cjs",
    write: false,
    banner: { js: "#!/usr/bin/env node" },
  });
  binary = Buffer.from(bundle.outputFiles[0].contents);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
function fixture(protocol = true, windows = false) {
  const dir = mkdtempSync(join(root, "case-"));
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  const os = windows
    ? "windows"
    : process.platform === "darwin"
      ? "darwin"
      : "linux";
  const arch = windows ? "x64" : process.arch === "arm64" ? "arm64" : "x64";
  const name = `lore-${os}-${arch}${windows ? ".exe" : ""}`;
  if (windows) {
    writeFileSync(
      join(bin, "uname"),
      '#!/bin/bash\nif [[ "$1" == -s ]]; then echo MINGW64_NT; else echo x86_64; fi\n',
      { mode: 0o755 },
    );
    writeFileSync(join(bin, "cygpath"), '#!/bin/bash\nprintf "%s\\n" "$2"\n', {
      mode: 0o755,
    });
  }
  const archive = gzipSync(binary);
  writeFileSync(join(dir, "archive"), archive);
  writeFileSync(
    join(dir, "manifest"),
    JSON.stringify({
      annotations: { version: "0.42.0-nightly" },
      layers: [
        {
          digest: `sha256:${sha(archive)}`,
          annotations: { "org.opencontainers.image.title": `${name}.gz` },
        },
        ...(protocol
          ? [
              {
                digest: `sha256:${sha(Buffer.from("1\n"))}`,
                annotations: {
                  "org.opencontainers.image.title": "install-protocol-v1",
                },
              },
            ]
          : []),
      ],
    }),
  );
  writeFileSync(join(dir, "binary"), binary);
  const checksums =
    [
      ...(protocol ? [`${sha(Buffer.from("1\n"))}  install-protocol-v1`] : []),
      `${sha(binary)}  ${name}`,
      `${sha(archive)}  ${name}.gz`,
    ].join("\n") + "\n";
  writeFileSync(join(dir, "checksums"), checksums);
  writeFileSync(
    join(dir, "release"),
    JSON.stringify({
      tag_name: "0.42.0",
      assets: [
        {
          name: "lore-checksums.txt",
          digest: `sha256:${sha(Buffer.from(checksums))}`,
          browser_download_url:
            "https://github.com/BYK/loreai/releases/download/0.42.0/lore-checksums.txt",
        },
      ],
    }),
  );
  writeFileSync(
    join(bin, "curl"),
    `#!/bin/bash
set -eu
case "$*" in
 *ghcr.io/token*) printf '{"token":"test-token"}' ;;
 *ghcr.io/v2/byk/loreai/manifests/*) cat "$TEST_DIR/manifest" ;;
 *ghcr.io/v2/byk/loreai/blobs/*) printf 'https://example.invalid/archive.gz' ;;
 *raw.githubusercontent.com*) cat "$TEST_LEGACY" ;;
 *api.github.com*) cat "$TEST_DIR/release" ;;
 *lore-checksums.txt*) cat "$TEST_DIR/checksums" ;;
 *.gz*)
  if [[ "\${TEST_UNINSTALL:-}" == 1 ]]; then
   mkdir -p "$HOME/.lore"; chmod 700 "$HOME/.lore"
   printf '{"version":1,"token":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","createdAt":"2026-09-08T00:00:00.000Z"}\\n' > "$HOME/.lore/uninstalled.json"
   chmod 600 "$HOME/.lore/uninstalled.json"
  fi
  cat "$TEST_DIR/archive" ;;
 *) cat "$TEST_DIR/binary" ;;
esac
`,
    { mode: 0o755 },
  );
  return {
    home,
    dir,
    env: {
      ...process.env,
      HOME: home,
      LORE_CONFIG_DIR: join(home, ".lore"),
      LORE_INSTALL_DIR: join(home, ".local/bin"),
      LORE_VERSION: "0.42.0",
      TEST_LEGACY: legacy,
      TEST_DIR: dir,
      PATH: `${bin}:${process.env.PATH}`,
      SHELL: "/bin/bash",
    },
  };
}
function run(
  f: ReturnType<typeof fixture>,
  env: NodeJS.ProcessEnv = f.env,
  script = readFileSync(installer),
) {
  return spawnSync("/bin/bash", ["-s", "--", "--no-modify-path"], {
    input: script,
    cwd: f.home,
    env,
    encoding: "utf8",
    timeout: 30000,
  });
}
it("pipes the verified bootstrap into the actual TypeScript installer", () => {
  const f = fixture();
  const result = run(f);
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(join(f.home, ".local/bin/lore"))).toEqual(binary);
  expect(readFileSync(join(f.home, ".lore/install-path"), "utf8")).toMatch(
    /^lore-install-receipt-v3/,
  );
  expect(existsSync(join(f.home, ".lore/embeddings-vendored"))).toBe(false);
});
it("keeps releases without the new protocol installable through verified legacy code", () => {
  const f = fixture(false);
  const result = run(f);
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(join(f.home, ".local/bin/lore"))).toEqual(binary);
});
it("rejects a tampered legacy installer before execution", () => {
  const f = fixture(false);
  const path = join(f.dir, "bad-legacy");
  writeFileSync(path, 'touch "$HOME/executed"\n');
  const result = run(f, { ...f.env, TEST_LEGACY: path });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Legacy installer checksum mismatch");
  expect(existsSync(join(f.home, "executed"))).toBe(false);
});
it("rejects tampered release bytes before executing the candidate", () => {
  const f = fixture();
  writeFileSync(
    join(f.dir, "archive"),
    gzipSync(Buffer.from('#!/bin/sh\ntouch "$HOME/executed"\n')),
  );
  const result = run(f);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("checksum mismatch");
  expect(existsSync(join(f.home, "executed"))).toBe(false);
});
for (const protocol of [true, false])
  it(`preserves uninstall during download (protocol=${protocol})`, () => {
    const f = fixture(protocol);
    const result = run(f, { ...f.env, TEST_UNINSTALL: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Uninstall generation changed");
    expect(existsSync(join(f.home, ".local/bin/lore"))).toBe(false);
  });

it("installs a protocol-enabled nightly using the OCI payload digest", () => {
  const f = fixture();
  const result = run(f, { ...f.env, LORE_VERSION: "nightly" });
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(join(f.home, ".local/bin/lore"))).toEqual(binary);
  expect(readFileSync(join(f.home, ".lore/channel"), "utf8")).toBe("nightly");
});
it("rejects a modified nightly blob before executing it", () => {
  const f = fixture();
  writeFileSync(
    join(f.dir, "archive"),
    gzipSync(Buffer.from('#!/bin/sh\ntouch "$HOME/executed"\n')),
  );
  const result = run(f, { ...f.env, LORE_VERSION: "nightly" });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("OCI blob digest mismatch");
  expect(existsSync(join(f.home, "executed"))).toBe(false);
});

it("hands customized Git Bash HOME to the native Windows runtime", () => {
  const f = fixture(true, true);
  const env = {
    ...f.env,
    USERPROFILE: join(f.dir, "other-home"),
    TEST_WINDOWS_HOME: "1",
  };
  const mutant = Buffer.from(
    readFileSync(installer, "utf8").replace(
      '  export USERPROFILE=$(cygpath -w "$HOME")\n',
      "",
    ),
  );
  const rejected = run(f, env, mutant);
  expect(rejected.status).not.toBe(0);
  expect(rejected.stderr).toContain("Windows HOME mismatch");
  const result = run(f, env);
  expect(result.status, result.stderr).toBe(0);
  expect(existsSync(join(f.home, ".lore/install-path"))).toBe(true);
});
