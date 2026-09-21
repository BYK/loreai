/**
 * Error types for the API client. `ApiError` lives here (not `~/lib/api.ts`)
 * because `ContractError` extends it and this directory must not import from
 * `~/lib` — the node-side contract test resolves it by relative path only.
 */
import "./config";
import { type } from "arktype";

/** The gateway's JSON error envelope: `{ type: "error", error: {...} }`. */
export const apiErrorBody = type({
  type: "'error'",
  error: {
    type: "string",
    message: "string",
  },
});

export type ApiErrorBody = typeof apiErrorBody.infer;

export type ApiErrorKind =
  | "unreachable"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "invalid"
  | "http";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  readonly path: string;

  constructor(
    kind: ApiErrorKind,
    path: string,
    message: string,
    status: number | null = null,
  ) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
    this.path = path;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export interface ContractIssue {
  path: string;
  message: string;
  expected?: string;
  received?: string;
}

/**
 * A 2xx response that failed contract validation. It IS an `ApiError` with
 * `kind: "invalid"` so the shell's existing error branching keeps working;
 * `path`/`route` carry the request path (without query string).
 */
export class ContractError extends ApiError {
  readonly name = "ContractError";
  readonly route: string;
  readonly issues: readonly ContractIssue[];

  constructor(route: string, issues: readonly ContractIssue[]) {
    super(
      "invalid",
      route,
      `Response from ${route} does not match the UI contract (${issues.length} issue(s))`,
      200,
    );
    this.route = route;
    this.issues = issues;
  }
}

export function isContractError(error: unknown): error is ContractError {
  return error instanceof ContractError;
}
