/**
 * Runtime resolution of the native ONNX Runtime addon shipped as a per-platform
 * npm package (`@loreai/onnxruntime-<os>-<arch>`), the esbuild distribution
 * model. See `packages/gateway/script/ort-platform-package.ts` for the build /
 * publish side — the package name computed here MUST match the names published
 * there (both are pinned to the literal `@loreai/onnxruntime-<os>-<arch>` shape
 * by tests on each side).
 *
 * The npm gateway worker bundle uses this to prefer native ONNX Runtime over the
 * bundled WASM fallback: if the platform package is installed (npm did so via
 * `optionalDependencies` gated by `os`/`cpu`), `require.resolve` finds its
 * addon at runtime — no postinstall, npm-12-safe — and the worker points
 * transformers.js at it. When it isn't installed (dist-only / unsupported
 * platform), resolution returns null and the worker falls back to WASM.
 */
import { createRequire } from "node:module";
import { availableParallelism, cpus } from "node:os";

/** The npm target key for a platform: `<process.platform>-<process.arch>`
 *  (e.g. "linux-x64", "darwin-arm64", "win32-arm64"). Matches the package name
 *  suffix exactly — no OS-name translation (win32 stays win32). */
export function ortPlatformTarget(
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  return `${platform}-${arch}`;
}

/** The per-platform native-ORT package name, e.g. `@loreai/onnxruntime-linux-x64`. */
export function ortNativePackageName(
  target: string = ortPlatformTarget(),
): string {
  return `@loreai/onnxruntime-${target}`;
}

/** The addon file within a platform package (its shared-library siblings sit
 *  next to it, resolved by $ORIGIN / @loader_path / Windows DLL search). */
export const ORT_NATIVE_BINDING_FILE = "onnxruntime_binding.node";

/**
 * Resolve the absolute path to the native ONNX Runtime addon for the running
 * platform, or `null` if the matching `@loreai/onnxruntime-<target>` package
 * isn't installed / resolvable. `fromPath` is the resolving module's location
 * (pass `__filename` from the worker — real in CJS, provided by Bun in ESM) so
 * resolution walks up from the installed gateway's `node_modules`.
 *
 * Never throws: an unresolvable package is the expected dist-only case and must
 * degrade to the WASM fallback, not crash embedding.
 */
export function resolveNativeOrtBindingPath(fromPath: string): string | null {
  try {
    const req = createRequire(fromPath);
    return req.resolve(`${ortNativePackageName()}/${ORT_NATIVE_BINDING_FILE}`);
  } catch {
    return null;
  }
}

/**
 * Intra-op thread count to hand native ONNX Runtime, or `undefined` to leave
 * ORT's own default in place.
 *
 * Native ORT sizes its intra-op pool to `std::thread::hardware_concurrency()`
 * (the HOST physical-core count), which is cgroup-CPU-blind. In a CPU-quota'd
 * container (Docker/Railway/K8s) it oversubscribes: each intra-op thread carries
 * its own memory arena, so a 1-vCPU container on a 32-core host spawns ~32
 * threads → wasted RSS (the axis PR #1168's memory clamp doesn't cover) plus
 * context-switch thrash against the quota.
 *
 * `os.availableParallelism()` is cgroup-CPU-aware (libuv `uv_available_parallelism`:
 * cgroup v2 `cpu.max`, v1 CFS quota, `sched_getaffinity`). We cap ONLY when the
 * process is genuinely restricted — `availableParallelism() < os.cpus().length`
 * (the logical-core count `os.cpus()` reports from the host). On an unconstrained
 * host the two are equal, so we return `undefined` and never touch ORT's default;
 * critically, this also avoids RAISING the thread count above ORT's physical-core
 * default on a hyper-threaded host (where logical > physical). So this is a
 * strict no-op except inside a CPU-limited container, where it returns the
 * quota-sized count (floored at 1) to stop the oversubscription.
 */
export function nativeIntraOpThreads(
  parallelism: number = availableParallelism(),
  logicalCpus: number = cpus().length,
): number | undefined {
  const avail =
    Number.isFinite(parallelism) && parallelism >= 1
      ? Math.floor(parallelism)
      : 1;
  const total =
    Number.isFinite(logicalCpus) && logicalCpus >= 1
      ? Math.floor(logicalCpus)
      : avail;
  return avail < total ? avail : undefined;
}
