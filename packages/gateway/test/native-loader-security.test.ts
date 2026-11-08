import { afterEach, expect, test, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { Script } from "node:vm";

const loader = new Script(
  fs.readFileSync(
    new URL("../script/native-loader.cjs", import.meta.url),
    "utf8",
  ),
);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
function root() {
  const value = fs.mkdtempSync(join(tmpdir(), "native-loader-test-"));
  roots.push(value);
  return value;
}
function run(
  directory: string,
  overrides: Partial<typeof fs> = {},
  shared = new Map<string, unknown>(),
  main = true,
) {
  const assets: Record<string, string> = {
    "ort-manifest.json": JSON.stringify({
      "linux-x64": ["onnxruntime_binding.node"],
    }),
    "ort-linux-x64-onnxruntime_binding.node": "fixture-ort",
    "vec0-linux-x64.so": "fixture-vec",
  };
  const context: Record<string, unknown> = {
    Buffer,
    process: {
      pid: process.pid,
      platform: "linux",
      arch: "x64",
      getuid: process.getuid,
    },
    require: (name: string) => {
      if (name === "node:fs") return { ...fs, ...overrides };
      if (name === "node:path") return path;
      if (name === "node:os") return { tmpdir: () => directory };
      if (name === "node:crypto") return crypto;
      if (name === "node:sea")
        return {
          isSea: () => true,
          getRawAsset: (key: string) => {
            if (!(key in assets)) throw new Error("Missing fixture asset");
            return Buffer.from(assets[key]);
          },
        };
      if (name === "node:worker_threads")
        return {
          isMainThread: main,
          getEnvironmentData: (key: string) => shared.get(key),
          setEnvironmentData: (key: string, value: unknown) =>
            shared.set(key, value),
        };
      throw new Error("Unexpected fixture module");
    },
  };
  loader.runInNewContext(context);
  return context;
}

test("ignores an attacker-prepared PID tree and never follows its asset symlinks", () => {
  const directory = root();
  const outside = join(directory, "sentinel");
  fs.mkdirSync(outside);
  const sentinel = join(outside, "vec0.so");
  fs.writeFileSync(sentinel, "unchanged");
  const legacyParent = join(directory, "lore-native");
  fs.mkdirSync(legacyParent);
  fs.symlinkSync(outside, join(legacyParent, `pid-${process.pid}`), "junction");
  const context = run(directory);
  expect(fs.readFileSync(sentinel, "utf8")).toBe("unchanged");
  const vec = context.__LORE_VEC_EXTENSION_PATH__ as string;
  expect(fs.readFileSync(vec, "utf8")).toBe("fixture-vec");
  expect(dirname(dirname(vec))).toBe(fs.realpathSync(directory));
  expect(fs.statSync(dirname(vec)).mode & 0o077).toBe(0);
});

test.skipIf(!process.getuid)(
  "refuses a foreign-owned temporary parent before extracting",
  () => {
    const directory = root();
    const write = vi.fn(fs.writeFileSync);
    const context = run(directory, {
      lstatSync: ((path: fs.PathLike) => {
        const stat = fs.lstatSync(path);
        return String(path) === directory
          ? Object.assign(stat, { uid: process.getuid!() + 1 })
          : stat;
      }) as typeof fs.lstatSync,
      writeFileSync: write,
    });
    expect(context.__LORE_VEC_EXTENSION_PATH__).toBeUndefined();
    expect(context.__LORE_ORT_BINDING_PATH__).toBeUndefined();
    expect(write).not.toHaveBeenCalled();
  },
);

test("does not publish assets after their extraction directory is replaced", () => {
  const directory = root();
  const extraction = { path: "", replaced: false };
  const context = run(directory, {
    mkdtempSync: ((prefix: string) => {
      extraction.path = fs.mkdtempSync(prefix);
      return extraction.path;
    }) as typeof fs.mkdtempSync,
    closeSync: (fd) => {
      fs.closeSync(fd);
      if (!extraction.path || extraction.replaced) return;
      extraction.replaced = true;
      fs.renameSync(extraction.path, `${extraction.path}.retired`);
      fs.mkdirSync(extraction.path, { mode: 0o700 });
    },
  });
  expect(context.__LORE_VEC_EXTENSION_PATH__).toBeUndefined();
  expect(context.__LORE_ORT_BINDING_PATH__).toBeUndefined();
});

test("workers reuse only the authenticated private extraction without rewriting it", () => {
  const directory = root();
  const shared = new Map<string, unknown>();
  const main = run(directory, {}, shared);
  const write = vi.fn(fs.writeFileSync);
  const worker = run(directory, { writeFileSync: write }, shared, false);
  expect(worker.__LORE_VEC_EXTENSION_PATH__).toBe(
    main.__LORE_VEC_EXTENSION_PATH__,
  );
  expect(worker.__LORE_ORT_BINDING_PATH__).toBe(main.__LORE_ORT_BINDING_PATH__);
  expect(write).not.toHaveBeenCalled();
});

test.each(["replacement", "edit"])(
  "workers refuse asset %s even inside the original private directory",
  (action) => {
    const directory = root();
    const shared = new Map<string, unknown>();
    const main = run(directory, {}, shared);
    const vec = main.__LORE_VEC_EXTENSION_PATH__ as string;
    if (action === "replacement") {
      fs.renameSync(vec, `${vec}.original`);
      fs.writeFileSync(vec, "fixture-vec", { mode: 0o600 });
    } else fs.writeFileSync(vec, "hostile-vec");
    const worker = run(directory, {}, shared, false);
    expect(worker.__LORE_VEC_EXTENSION_PATH__).toBeUndefined();
    expect(worker.__LORE_ORT_BINDING_PATH__).toBe(
      main.__LORE_ORT_BINDING_PATH__,
    );
  },
);
