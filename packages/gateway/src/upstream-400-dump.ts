/** Temporary diagnostic branch: save every rejected upstream exchange locally. */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, log } from "@loreai/core";

export async function dumpUpstream400(
  url: string,
  requestHeaders: Record<string, string>,
  requestBody: string,
  response: Response,
): Promise<void> {
  if (response.status !== 400) return;
  try {
    const responseBody = await response.clone().text();
    const directory = join(dataDir(), "upstream-400");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${Date.now()}-${randomUUID()}.json`);
    writeFileSync(
      path,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        request: { url, headers: requestHeaders, body: requestBody },
        response: {
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers),
          body: responseBody,
        },
      }),
      { flag: "wx", mode: 0o600 },
    );
    log.warn(`upstream 400 exchange saved locally: ${path}`);
  } catch {
    log.warn("upstream 400 exchange capture failed");
  }
}
