import { describe, expect, it } from "vitest";

import { BadRequest } from "../src/api-lists";
import { parseBooleanParam } from "../src/query-bool";

describe("parseBooleanParam", () => {
  it.each(["true", "TRUE", "1", "yes", "Y", "on"])(
    "accepts true spelling %s",
    (value) => {
      expect(
        parseBooleanParam(
          new URL(`http://localhost/?enabled=${value}`),
          "enabled",
          false,
        ),
      ).toBe(true);
    },
  );

  it.each(["false", "FALSE", "0", "no", "N", "off"])(
    "accepts false spelling %s",
    (value) => {
      expect(
        parseBooleanParam(
          new URL(`http://localhost/?enabled=${value}`),
          "enabled",
          true,
        ),
      ).toBe(false);
    },
  );

  it("uses the fallback for absent and empty values", () => {
    expect(
      parseBooleanParam(new URL("http://localhost/"), "enabled", true),
    ).toBe(true);
    expect(
      parseBooleanParam(
        new URL("http://localhost/?enabled="),
        "enabled",
        false,
      ),
    ).toBe(false);
  });

  it("rejects unknown values with a bad-request error", () => {
    expect(() =>
      parseBooleanParam(
        new URL("http://localhost/?enabled=maybe"),
        "enabled",
        false,
      ),
    ).toThrowError(
      new BadRequest(
        "invalid_request",
        "Invalid enabled: maybe (expected a boolean)",
      ),
    );
  });
});
