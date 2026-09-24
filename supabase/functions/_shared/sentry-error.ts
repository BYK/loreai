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

/** Keep only fixed error text and remove any breadcrumb payloads. */
export function scrubErrorEvent<T extends PrivacySafeErrorEvent>(event: T): T {
  event.message = "edge function error";
  for (const exception of event.exception?.values ?? []) {
    exception.value = "edge function error";
  }
  event.breadcrumbs = undefined;
  return event;
}
