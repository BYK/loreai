import "./config";
import { type, type Type } from "arktype";

import { ContractError, type ContractIssue } from "./error";

function toIssues(errors: type.errors): ContractIssue[] {
  return errors.map((e) => ({
    path: e.path.map(String).join("."),
    message: e.message,
    expected: e.expected,
    received: e.actual,
  }));
}

/**
 * Validate a response body against a contract. Throws `ContractError`
 * listing every issue on mismatch. On success the input object is returned
 * as-is (ArkType does not clone valid data — intentional).
 */
export function parseContract<T>(
  route: string,
  schema: Type<T>,
  input: unknown,
): T {
  const out = schema(input);
  if (out instanceof type.errors) {
    throw new ContractError(route, toIssues(out));
  }
  // ArkType types the call result as its morph-resolution wrapper; once
  // ArkErrors is excluded it is exactly `T`.
  return out as T;
}

export function safeParseContract<T>(
  route: string,
  schema: Type<T>,
  input: unknown,
): { ok: true; value: T } | { ok: false; error: ContractError } {
  const out = schema(input);
  if (out instanceof type.errors) {
    return {
      ok: false,
      error: new ContractError(route, toIssues(out)),
    };
  }
  return { ok: true, value: out as T };
}
