/**
 * Prepare UI assets for a source checkout.
 *
 * Published gateway packages already contain the staged UI. A workspace
 * checkout, however, can load the gateway through the raw Bun shim used by
 * the OpenCode/Pi source plugins before anyone has run a gateway build. Keep
 * that development-only convenience out of the normal runtime by loading the
 * staging script only when it is present next to the gateway source tree.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface UiBootstrapResult {
  /** True when this process found a source-checkout staging script. */
  attempted: boolean;
  /** Number of identity assets staged, or zero when staging failed/was absent. */
  files: number;
  /** Content-derived UI build ID when staging succeeded. */
  buildId: string | null;
  /** A source-build failure is non-fatal to the gateway, but must be visible. */
  error?: string;
}

interface UiAssetStager {
  stageUiAssets(options: {
    build: "always" | "if-missing" | "never";
  }): Promise<{ files: number; buildId: string | null }>;
}

let preparation: Promise<UiBootstrapResult> | undefined;

function sourceStagerUrl(): URL | null {
  try {
    const url = new URL("../script/ui-assets.ts", import.meta.url);
    return url.protocol === "file:" && existsSync(fileURLToPath(url))
      ? url
      : null;
  } catch {
    // SEA and packaged installations do not expose the workspace script.
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Stage the UI when the gateway is running from the Lore workspace.
 *
 * The promise is process-wide so concurrent plugin instances cannot race on
 * the shared dist/ui directory. Startup only stages an existing
 * packages/ui/dist build; the explicit workspace build command remains
 * responsible for compiling the UI.
 */
export function prepareSourceUiAssets(): Promise<UiBootstrapResult> {
  if (preparation) return preparation;

  const attempt = (async (): Promise<UiBootstrapResult> => {
    const script = sourceStagerUrl();
    if (!script) {
      return { attempted: false, files: 0, buildId: null };
    }

    try {
      const stager = (await import(script.href)) as UiAssetStager;
      const result = await stager.stageUiAssets({ build: "never" });
      return {
        attempted: true,
        files: result.files,
        buildId: result.buildId,
      };
    } catch (error) {
      return {
        attempted: true,
        files: 0,
        buildId: null,
        error: errorMessage(error),
      };
    }
  })();

  // Successful preparation is process-wide, but a failed attempt must not
  // strand a source-loaded plugin until the process restarts. The inner
  // operation normally converts staging errors into a result so callers can
  // continue without a UI; the rejection branch also covers unexpected
  // loader/runtime failures.
  preparation = attempt.then(
    (result) => {
      if (result.error) preparation = undefined;
      return result;
    },
    (error: unknown) => {
      preparation = undefined;
      throw error;
    },
  );
  return preparation;
}
