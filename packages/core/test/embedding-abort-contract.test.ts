import { describe, expect, test, vi } from "vitest";
import {
  awaitEmbeddingOperation,
  createEmbeddingAbortGuard,
  EmbeddingAbortError,
} from "../src/embedding/contract";

describe("embedding abort contract", () => {
  test("observes an abort between the initial check and listener registration", async () => {
    const controller = new AbortController();
    const add = controller.signal.addEventListener.bind(controller.signal);
    vi.spyOn(controller.signal, "addEventListener").mockImplementation(
      (...args) => {
        controller.abort(new DOMException("disconnected", "AbortError"));
        return add(...args);
      },
    );
    const pending = new Promise<number>(() => {});
    const outcome = await Promise.race([
      awaitEmbeddingOperation(
        pending,
        createEmbeddingAbortGuard("ltm-query", { signal: controller.signal }),
      ).then(
        () => "resolved" as const,
        (error: unknown) => error,
      ),
      new Promise<"stuck">((resolve) =>
        setTimeout(() => resolve("stuck"), 200),
      ),
    ]);
    expect(outcome).toBeInstanceOf(EmbeddingAbortError);
    expect((outcome as EmbeddingAbortError).code).toBe("aborted");
  });
});
