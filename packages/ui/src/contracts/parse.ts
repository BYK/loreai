import * as v from "valibot";

import { ContractError, type ContractIssue } from "./error";

function toIssues(issues: readonly v.InferIssue<v.GenericSchema>[]): ContractIssue[] {
  return issues.map((issue) => ({
    path: v.getDotPath(issue) ?? "",
    message: issue.message,
    expected: issue.expected ?? undefined,
    received: issue.received,
  }));
}

/**
 * Validate a response body against a contract. Throws `ContractError`
 * listing every issue (no early abort) on mismatch.
 */
export function parseContract<S extends v.GenericSchema>(
  route: string,
  schema: S,
  input: unknown,
): v.InferOutput<S> {
  const result = v.safeParse(schema, input, { abortEarly: false });
  if (!result.success) throw new ContractError(route, toIssues(result.issues));
  return result.output;
}

export function safeParseContract<S extends v.GenericSchema>(
  route: string,
  schema: S,
  input: unknown,
): { ok: true; value: v.InferOutput<S> } | { ok: false; error: ContractError } {
  const result = v.safeParse(schema, input, { abortEarly: false });
  if (!result.success) {
    return { ok: false, error: new ContractError(route, toIssues(result.issues)) };
  }
  return { ok: true, value: result.output };
}
