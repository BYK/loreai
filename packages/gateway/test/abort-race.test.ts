import { describe, expect, it } from "vitest";

import { responseAgainstAbort } from "../src/abort-race";
import { responseCompletionCallbacks } from "../src/response-completion";

describe("responseAgainstAbort", () => {
  it("discards completion work on a late bodyless response", async () => {
    const controller = new AbortController();
    const abortReason = new Error("client disconnected");
    let resolveUpstream!: (response: Response) => void;
    const upstream = new Promise<Response>((resolve) => {
      resolveUpstream = resolve;
    });
    let discarded = false;
    const lateResponse = new Response(null);
    responseCompletionCallbacks.set(lateResponse, {
      onDiscard: () => {
        discarded = true;
      },
    });

    const response = responseAgainstAbort(() => upstream, controller.signal);
    controller.abort(abortReason);
    await expect(response).rejects.toBe(abortReason);

    resolveUpstream(lateResponse);
    await Promise.resolve();
    expect(responseCompletionCallbacks.has(lateResponse)).toBe(false);
    expect(discarded).toBe(true);
  });
});
