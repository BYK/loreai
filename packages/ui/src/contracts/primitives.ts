/**
 * Shared scalar primitives for the `/api/v1` contracts.
 *
 * Rules for every contract in this directory:
 *  - objects are `looseObject`: unknown keys are preserved, so the gateway
 *    (and core behind it) stays authoritative on the record shape and later
 *    API versions can add fields without breaking this client;
 *  - no `catch`/`fallback`/coercion anywhere: a mistyped or missing required
 *    field is a contract violation, never a silently repaired one;
 *  - relative imports only — the gateway's node-side contract test imports
 *    this directory by path and the root tsconfig has no `~` alias.
 */
import * as v from "valibot";

/** Core stores timestamps as epoch milliseconds (`INTEGER` columns). */
export const epochMs = v.pipe(v.number(), v.integer(), v.minValue(0));

export const nonNegInt = v.pipe(v.number(), v.integer(), v.minValue(0));

export const nonEmptyString = v.pipe(v.string(), v.minLength(1));
