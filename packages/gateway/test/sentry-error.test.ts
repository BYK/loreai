import { describe, expect, it } from "vitest";
import {
  scrubErrorEvent,
  toError,
} from "../../../supabase/functions/_shared/sentry-error";

describe("Deno Sentry error normalization", () => {
  it("redacts messages from Errors, strings, and Supabase error objects", () => {
    const error = new Error(
      "safe first line\nprovider_token=private-token user@example.com",
    );
    const normalized = toError(error);
    expect(normalized).not.toBe(error);
    expect(normalized.message).toBe("edge function error");
    expect(normalized.stack).not.toContain("private-token");
    expect(normalized.stack).not.toContain("user@example.com");

    expect(toError("string error").message).toBe("edge function error");
    expect(toError({ message: "provider_token=private-token" }).message).toBe(
      "edge function error",
    );
    expect(toError({ hint: "private@example.com" }).message).toBe(
      "edge function error",
    );
  });

  it.each([null, undefined])("uses a generic message for %s", (value) => {
    expect(toError(value).message).toBe("edge function error");
  });

  it("scrubs event text and drops breadcrumbs", () => {
    const event = {
      message: "provider_token=private-token",
      exception: {
        values: [{ value: "user@example.com: request failed" }],
      },
      breadcrumbs: [{ message: "console output with private data" }],
    };

    expect(scrubErrorEvent(event)).toEqual({
      message: "edge function error",
      exception: { values: [{ value: "edge function error" }] },
      breadcrumbs: undefined,
    });
  });
});
