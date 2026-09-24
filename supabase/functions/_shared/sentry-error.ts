/**
 * Normalize a captured value into a privacy-safe Error. Error messages and
 * Supabase message/hint fields may contain credentials or user data, so never
 * forward them. Keep only the original Error's stack frames for diagnosis.
 */
export function toError(err: unknown): Error {
  const error = new Error("edge function error");
  if (err instanceof Error && typeof err.stack === "string") {
    try {
      // V8 stacks start with Error.prototype.toString(), which may span
      // multiple lines when the original message contains newlines.
      const originalHeader = Error.prototype.toString.call(err);
      if (err.stack.startsWith(originalHeader)) {
        const frames = err.stack
          .slice(originalHeader.length)
          .replace(/^\n/, "");
        if (frames) error.stack = `${error.name}: ${error.message}\n${frames}`;
      }
    } catch {
      // Retain the safe local stack if reading the original stack fails.
    }
  }
  return error;
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
