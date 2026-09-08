import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

// No workspace dependencies: CI runs this with stock /bin/bash and real BSD
// utilities on macOS. Linux also emulates devfs's misleading path metadata.
const installer =
  process.env.LORE_TEST_INSTALLER ??
  fileURLToPath(new URL("../public/install", import.meta.url));
const source = readFileSync(installer, "utf8");
const boundary = source.indexOf("\ncanonical_home=");
assert.ok(boundary > 0);
const functions = source.slice(0, boundary);
const bash = "/bin/bash";
const executable = (path, body) =>
  writeFileSync(path, `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o755 });

function fixture(t, drift = "both") {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "lore-installer-portability-")),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(bin);
  const binary = Buffer.from('#!/bin/sh\necho "1.2.3"\n');
  const archive = gzipSync(binary);
  writeFileSync(join(root, "archive"), archive);
  const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const checksums =
    ["x64", "arm64"]
      .flatMap((arch) => [
        `${sha(binary)}  lore-darwin-${arch}`,
        `${sha(archive)}  lore-darwin-${arch}.gz`,
      ])
      .join("\n") + "\n";
  writeFileSync(join(root, "checksums"), checksums);
  writeFileSync(
    join(root, "release"),
    JSON.stringify({
      tag_name: "1.2.3",
      assets: [
        {
          name: "lore-checksums.txt",
          digest: `sha256:${sha(checksums)}`,
          browser_download_url:
            "https://github.com/BYK/loreai/releases/download/1.2.3/lore-checksums.txt",
        },
      ],
    }),
  );
  executable(
    join(bin, "curl"),
    `case "$*" in
    *api.github.com*) cat "$TEST_ROOT/release" ;;
    *lore-checksums.txt*) cat "$TEST_ROOT/checksums" ;;
    *.gz*) cat "$TEST_ROOT/archive" ;;
    *) exit 1 ;;
  esac`,
  );
  executable(join(bin, "sync"), ":");
  if (process.platform !== "darwin") {
    executable(join(bin, "wc"), `printf '%8s\\n' "$(/usr/bin/wc "$@")"`);
    executable(
      join(bin, "date"),
      `
      if [[ "$1" == -r ]]; then
        seconds=$2; shift 2
        exec /usr/bin/date -d "@$seconds" "$@"
      fi
      exec /usr/bin/date "$@"`,
    );
    executable(
      join(bin, "uname"),
      `case "$1" in
      -s) echo Darwin ;; -m) echo arm64 ;; *) exit 1 ;; esac`,
    );
    executable(
      join(bin, "stat"),
      `
      flags=$1 format=$2
      shift 2
      format=\${format//%Lp/%a}
      format=\${format//%z/%s}
      format=\${format//%m/%Y}
      format=\${format//%c/%Z}
      if [[ "$format" == %p ]]; then format=%a; fi
      if [[ $# == 0 ]]; then
        # BSD stat with no pathname uses fstat(0), even for a write-only fd.
        exec /usr/bin/stat -Lc "$format" /dev/fd/0
      fi
      if [[ "$1" == /dev/fd/* ]]; then
        if [[ "$TEST_DRIFT" != mode && "$format" == %d:%i ]]; then
          printf '999999:%s\\n' "$(/usr/bin/stat -Lc %i "$1")"
          exit
        fi
        if [[ "$format" == %a ]]; then echo 400; exit; fi
      fi
      case "$flags" in
        -Lf) exec /usr/bin/stat -Lc "$format" "$@" ;;
        -f) exec /usr/bin/stat -c "$format" "$@" ;;
        *) exit 1 ;;
      esac`,
    );
    // A devfs node is not the target inode for pathname chmod either.
    executable(
      join(bin, "chmod"),
      `
      case "\${2:-}" in /dev/fd/*) exit 0 ;; esac
      exec /usr/bin/chmod "$@"`,
    );
  }
  return {
    home,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
      TEST_ROOT: root,
      TEST_DRIFT: drift,
      LORE_VERSION: "1.2.3",
    },
  };
}

await test("retains full device identity and fails closed on unavailable fd metadata", (t) => {
  const f = fixture(t);
  const state = join(f.home, ".lore");
  mkdirSync(state, { mode: 0o700 });
  const result = run(
    f,
    `${functions}
    trap - EXIT
    exec 8<"$HOME/.lore"
    expected=$(stable_file_identity "$HOME/.lore")
    [[ "$(stable_fd_identity 8)" == "$expected" ]]
    exec 8<&-
    if stable_fd_identity 8; then exit 31; fi
    if fd_has_exact_mode 8 700; then exit 32; fi
    exec 8<"$HOME/.lore"
    stat() {
      if [[ $# == 2 && "$2" == %d:%i ]]; then
        printf '999999:%s\\n' "$(command stat -f %i "$HOME/.lore")"
      else command stat "$@"; fi
    }
    secure_lifecycle_state_dir "$HOME/.lore"
  `,
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /changed while it was opened/);
  assert.deepEqual(readdirSync(state), []);
});

await test("fd and path exact-mode checks reject special permission bits", (t) => {
  const f = fixture(t);
  const result = run(
    f,
    `${functions}
    trap - EXIT
    mkdir -m 1700 "$HOME/private"
    exec 8<"$HOME/private"
    if path_has_exact_mode "$HOME/private" 700; then exit 31; fi
    if fd_has_exact_mode 8 700; then exit 32; fi
    chmod 700 "$HOME/private"
    path_has_exact_mode "$HOME/private" 700
    fd_has_exact_mode 8 700
  `,
  );
  assert.equal(result.status, 0, result.stderr);
});

await test("owner records retain exact token and process identity length limits", (t) => {
  const f = fixture(t);
  const cases = [
    ...[31, 32, 255, 256, 257].map((length) => ({
      token: "a".repeat(length),
      identity: `unverified:${"a".repeat(length)}`,
      valid: length >= 32 && length <= 256,
    })),
    ...[255, 256, 1020, 1024, 1025].map((length) => ({
      token: "a".repeat(32),
      identity: `linux:boot:${"1".repeat(length - 11)}`,
      valid: length <= 1024,
    })),
  ];
  const args = cases.flatMap(({ token, identity, valid }, index) => {
    const path = join(f.home, `owner-${index}.json`);
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        token,
        pid: 123,
        operation: "hosted-install",
        createdAt: "2026-08-12T00:00:00.000Z",
        processStartedAt: "2026-08-12T00:00:00.000Z",
        processIdentity: identity,
      }) + "\n",
      { mode: 0o600 },
    );
    return [path, valid ? "true" : "false", token, identity];
  });
  const result = run(
    f,
    `owner_cases=("$@")
    set --
    ${functions}
    set -- "\${owner_cases[@]}"
    checked=0
    while (( $# > 0 )); do
      if inspect_lifecycle_owner_record "$1"; then
        [[ "$2" == true ]] || exit 31
        [[ "$inspected_lock_token" == "$3" && "$inspected_lock_pid" == 123 &&
           "$inspected_lock_process_identity" == "$4" ]] || exit 32
      else
        [[ "$2" == false ]] || exit 33
      fi
      checked=$((checked + 1))
      shift 4
    done
    [[ $checked == ${cases.length} ]]
  `,
    ...args,
  );
  assert.equal(result.status, 0, result.stderr);
});

await test("nested subshell cleanup cannot release the parent's lock", (t) => {
  const f = fixture(t);
  const result = run(
    f,
    `${functions}
    unset BASHPID
    canonical_home=$(pwd -P)
    acquire_lifecycle_lock
    (release_lifecycle_lock; release_lifecycle_initialization_claim)
    [[ -f "$HOME/.lore/lifecycle.lock/owner.json" ]]
    release_lifecycle_lock
    [[ ! -e "$HOME/.lore/lifecycle.lock" ]]
  `,
  );
  assert.equal(result.status, 0, result.stderr);
});

for (const renameDuringGuard of ["none", "before-cd", "after-cd"]) {
  await test(`stale lock guards stay in their original directory (rename=${renameDuringGuard})`, (t) => {
    const f = fixture(t);
    const state = join(f.home, ".lore");
    const lock = join(state, "lifecycle.lock");
    const token = "a".repeat(64);
    mkdirSync(state, { mode: 0o700 });
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(
      join(lock, "owner.json"),
      JSON.stringify({
        version: 1,
        token,
        pid: 2147483647,
        operation: "hosted-install",
        createdAt: "2026-08-12T00:00:00.000Z",
        processStartedAt: "2026-08-12T00:00:00.000Z",
        processIdentity: `unverified:${token}`,
      }) + "\n",
      { mode: 0o600 },
    );
    const injection =
      renameDuringGuard !== "none"
        ? `
      cd() {
        ${renameDuringGuard === "after-cd" ? 'builtin cd "$@" || return 1' : ""}
        if [[ "$*" == *"$HOME/.lore/lifecycle.lock" ]]; then
          command mv "$HOME/.lore/lifecycle.lock" "$HOME/.lore/old-lock"
          command mkdir -m 700 "$HOME/.lore/lifecycle.lock"
        fi
        ${renameDuringGuard === "before-cd" ? 'builtin cd "$@" || return 1' : ""}
      }
    `
        : "";
    const result = run(
      f,
      `${functions}
      ${injection}
      canonical_home=$(pwd -P)
      acquire_lifecycle_lock
      release_lifecycle_lock
    `,
    );
    if (renameDuringGuard !== "none") {
      assert.notEqual(result.status, 0);
      assert.deepEqual(readdirSync(lock), []);
      assert.equal(
        existsSync(join(state, "old-lock/lifecycle.lock")),
        renameDuringGuard === "after-cd",
      );
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(lock), false);
      assert.ok(
        existsSync(
          join(state, `.lifecycle.lock.claim.${token}/lifecycle.lock`),
        ),
      );
    }
  });
}

function run(f, code, ...args) {
  return spawnSync(bash, ["-c", code, "installer-test", ...args], {
    cwd: f.home,
    env: f.env,
    encoding: "utf8",
    timeout: 30_000,
  });
}

for (const drift of ["both", "mode"]) {
  await test(`installs with real descriptor identity/mode (${drift})`, (t) => {
    const f = fixture(t, drift);
    mkdirSync(join(f.home, ".lore"), { mode: 0o755 });
    const result = run(f, 'source "$1" --no-modify-path', installer);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(f.home, ".local/bin/lore")));
    assert.match(
      readFileSync(join(f.home, ".lore/install-path"), "utf8"),
      /^lore-install-receipt-v3\n/,
    );
    assert.equal(statSync(join(f.home, ".lore")).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(join(f.home, ".lore")).sort(), [
      "channel",
      "install-path",
    ]);
  });
}

await test("installs and releases locks without Bash 4 BASHPID", (t) => {
  const f = fixture(t);
  const result = run(
    f,
    'unset BASHPID; source "$1" --no-modify-path',
    installer,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(join(f.home, ".lore")).sort(), [
    "channel",
    "install-path",
  ]);
});

await test("installs when Bash reads the script from a pipe", (t) => {
  const f = fixture(t);
  const result = spawnSync(bash, ["-s", "--", "--no-modify-path"], {
    cwd: f.home,
    env: f.env,
    input: source,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(join(f.home, ".lore")).sort(), [
    "channel",
    "install-path",
  ]);
});

await test("owner descriptor validation failure retains its diagnostic and cleans up", (t) => {
  const f = fixture(t);
  const result = run(
    f,
    `${functions}
    stat() {
      if [[ $# == 2 && "$2" == %p ]]; then
        mode=$(command stat "$@") || return 1
        if (( (8#$mode & 07777) == 0600 )); then
          printf '100644\\n'
          return 0
        fi
      fi
      command stat "$@"
    }
    canonical_home=$(pwd -P)
    acquire_lifecycle_lock
  `,
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Could not stage Lore lifecycle lock owner/);
  assert.deepEqual(readdirSync(join(f.home, ".lore")), []);
});

for (const when of ["before-cd", "during-chmod"]) {
  await test(`rejects directory replacement ${when} without chmod of successor`, (t) => {
    const f = fixture(t);
    const state = join(f.home, ".lore");
    mkdirSync(state, { mode: 0o755 });
    const injection =
      when === "before-cd"
        ? `cd() {
          command mv "$TEST_STATE" "$TEST_STATE.old"
          command mkdir -m 755 "$TEST_STATE"
          builtin cd "$@"
        }`
        : `chmod() {
          command mv "$TEST_STATE" "$TEST_STATE.old"
          command mkdir -m 755 "$TEST_STATE"
          command chmod "$@"
        }`;
    f.env.TEST_STATE = state;
    const result = run(
      f,
      `${functions}\n${injection}\nsecure_lifecycle_state_dir "$TEST_STATE"`,
    );
    assert.notEqual(result.status, 0);
    assert.ok(existsSync(`${state}.old`), result.stderr);
    assert.equal(statSync(state).mode & 0o777, 0o755);
    assert.equal(
      statSync(`${state}.old`).mode & 0o777,
      when === "before-cd" ? 0o755 : 0o700,
    );
    assert.deepEqual(readdirSync(state), []);
  });
}
