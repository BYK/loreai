// Vitest globalSetup: make sure src/ui-assets.generated.ts exists so tests
// that import server.ts / ui-static.ts resolve even when the UI has never
// been built on this checkout (an empty manifest → /ui answers 503).
import { ensureUiAssetsModule } from "../../script/ui-assets";

export default function setup(): void {
  ensureUiAssetsModule();
}
