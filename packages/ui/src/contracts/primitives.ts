/**
 * Shared scalar primitives for the `/api/v1` contracts.
 *
 * Rules for every contract in this directory:
 *  - ArkType ignores undeclared keys by default, so the gateway (and core
 *    behind it) stays authoritative on the record shape and later API
 *    versions can add fields without breaking this client;
 *  - no `catch`/`fallback`/coercion anywhere: a mistyped or missing required
 *    field is a contract violation, never a silently repaired one;
 *  - relative imports only — the gateway's node-side contract test imports
 *    this directory by path and the root tsconfig has no `~` alias.
 */
import "./config";
import { type } from "arktype";

/** Core stores timestamps as epoch milliseconds (`INTEGER` columns). */
export const epochMs = type("number.integer >= 0");

export const nonNegInt = type("number.integer >= 0");

export const nonEmptyString = type("string > 0");
