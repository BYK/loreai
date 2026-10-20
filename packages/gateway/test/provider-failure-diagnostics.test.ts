import { describe, expect, test } from "vitest";
import {
  responsesValidationCheck,
  upstreamRejectionDiagnostic,
} from "../src/provider-failure-diagnostics";

describe("provider failure diagnostics", () => {
  test("identifies the failing stream check without exposing dynamic values", () => {
    expect(
      responsesValidationCheck(
        new Error(
          "Responses output_item.done changed item identity for index PRIVATE",
        ),
      ),
    ).toBe("output_identity_changed");
    expect(
      responsesValidationCheck(
        new Error("invalid Responses content_part.done for index PRIVATE"),
      ),
    ).toBe("content_part_done_order");
    expect(
      responsesValidationCheck(
        new Error("unsupported Responses reasoning event PRIVATE"),
      ),
    ).toBe("reasoning_event_unsupported");
    expect(responsesValidationCheck(new Error("PRIVATE"))).toBe("unknown");
  });

  test("reports reviewed upstream codes and hints, never raw provider text", () => {
    expect(
      upstreamRejectionDiagnostic(
        JSON.stringify({
          error: {
            code: "unsupported_api_for_model",
            message: "PRIVATE model not supported",
          },
        }),
      ),
    ).toBe("body=json code=unsupported_api_for_model hints=unsupported,model");
    expect(
      upstreamRejectionDiagnostic(
        JSON.stringify({
          error: {
            code: "PRIVATE",
            message: "PRIVATE tool schema has too many parameters",
          },
        }),
      ),
    ).toBe("body=json code=unrecognized hints=tool,schema,limit");
    expect(upstreamRejectionDiagnostic("PRIVATE")).toBe("body=json_invalid");
    expect(upstreamRejectionDiagnostic("null")).toBe("body=other");
  });
});
