/**
 * Normalize a captured value into a privacy-safe Error. Error messages,
 * Supabase fields, and even custom stack frames may contain credentials or user
 * data, so never forward the original value. The new Error supplies a local
 * stack that identifies this capture boundary without copying source payloads.
 */
export function toError(_err: unknown): Error {
  return new Error("edge function error");
}

export interface PrivacySafeErrorEvent {
  message?: string;
  exception?: { values?: Array<{ value?: string | null }> } | null;
  breadcrumbs?: unknown[];
}

export type EdgeFunctionName =
  | "github-discover"
  | "github-provision"
  | "send-invite-email";

export type FailureSite =
  | `${EdgeFunctionName}.unhandled`
  | "github-discover.verify-token-owner"
  | "github-discover.list-repositories"
  | "github-discover.list-contributors"
  | "github-discover.lookup-lore-users"
  | "github-discover.create-invite"
  | "github-discover.lookup-lore-email"
  | "github-discover.lookup-github-email"
  | "github-discover.send-invite-email"
  | "github-provision.fetch-memberships"
  | "github-provision.provision-membership"
  | "send-invite-email.lookup-lore-email"
  | "send-invite-email.lookup-invite"
  | "send-invite-email.send-smtp";

/** Attach the static operation identifier without exposing source stack data. */
export function setFailureSiteTag(
  scope: { setTag(key: string, value: string): unknown },
  failureSite: FailureSite,
): void {
  scope.setTag("failure_site", failureSite);
}

/** Capture returned SDK errors as well as thrown failures at their fixed origin. */
export async function captureReturnedError(
  error: unknown,
  failureSite: FailureSite,
  capture: (error: unknown, failureSite: FailureSite) => Promise<void>,
): Promise<void> {
  if (error !== null && error !== undefined) await capture(error, failureSite);
}

/** Keep only fixed error text and remove any breadcrumb payloads. */
export function scrubErrorEvent<T extends PrivacySafeErrorEvent>(event: T): T {
  event.message = "edge function error";
  for (const exception of event.exception?.values ?? []) {
    exception.value = "edge function error";
  }
  event.breadcrumbs = undefined;
  return event;
}
