import { describe, expect, it } from "vitest";
import {
  captureReturnedError,
  scrubErrorEvent,
  setFailureSiteTag,
  toError,
} from "../../../supabase/functions/_shared/sentry-error";

describe("Deno Sentry error normalization", () => {
  it("redacts messages from Errors, strings, and Supabase error objects", () => {
    const error = new Error(
      "safe first line\nprovider_token=private-token user@example.com",
    );
    error.stack =
      "Error: safe first line\nprovider_token=private-token user@example.com\n" +
      "    at upstream (https://api.invalid/?token=stack-token)";
    const normalized = toError(error);
    expect(normalized).not.toBe(error);
    expect(normalized.message).toBe("edge function error");
    expect(normalized.stack).toContain("toError");
    expect(normalized.stack).not.toContain("private-token");
    expect(normalized.stack).not.toContain("user@example.com");
    expect(normalized.stack).not.toContain("stack-token");

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

  it("captures returned SDK errors at their fixed failure site", async () => {
    const error = { message: "lookup failed" };
    const captured: Array<[unknown, string]> = [];
    const capture = async (value: unknown, failureSite: string) => {
      captured.push([value, failureSite]);
    };

    await captureReturnedError(
      error,
      "github-discover.lookup-lore-email",
      capture,
    );
    await captureReturnedError(
      null,
      "github-discover.lookup-lore-email",
      capture,
    );

    expect(captured).toEqual([[error, "github-discover.lookup-lore-email"]]);
  });

  it("tags separate failures with fixed, safe call-site IDs", () => {
    const tags: Array<[string, string]> = [];
    const scope = {
      setTag(key: string, value: string) {
        tags.push([key, value]);
      },
    };

    setFailureSiteTag(scope, "github-discover.list-contributors");
    setFailureSiteTag(scope, "github-discover.lookup-lore-users");

    expect(tags).toEqual([
      ["failure_site", "github-discover.list-contributors"],
      ["failure_site", "github-discover.lookup-lore-users"],
    ]);
  });
});
