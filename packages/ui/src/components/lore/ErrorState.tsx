import type { JSX } from "solid-js";

import { isApiError } from "~/lib/api";
import { StateCard } from "./StateCard";

export function errorStateFor(
  error: unknown,
  what: string,
  retry: () => void,
  extra?: { firstPage?: () => void },
): JSX.Element {
  if (isApiError(error) && error.kind === "unauthorized")
    return (
      <StateCard kind="locked" title={`${what} hidden by the gateway`}>
        Only the machine running the gateway can access this view.
      </StateCard>
    );
  if (isApiError(error) && error.kind === "not_found")
    return <StateCard kind="error" title={`${what} not found`} />;
  if (isApiError(error) && error.status === 400)
    return (
      <StateCard
        kind="error"
        title="This page link is no longer valid"
        action={
          extra?.firstPage ? (
            <button
              class="text-xs text-accent underline"
              onClick={extra.firstPage}
            >
              First page
            </button>
          ) : (
            <button class="text-xs text-accent underline" onClick={retry}>
              Retry
            </button>
          )
        }
      />
    );
  if (isApiError(error) && error.kind === "unreachable")
    return (
      <StateCard kind="error" title="Gateway unreachable">
        Start the gateway with <code>lore start</code>.
      </StateCard>
    );
  return (
    <StateCard
      kind="error"
      title={`${what} unavailable`}
      action={
        <button class="text-xs text-accent underline" onClick={retry}>
          Retry
        </button>
      }
    >
      {isApiError(error) ? error.message : String(error)}
    </StateCard>
  );
}
