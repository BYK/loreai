import type { Accessor } from "solid-js";

import type { ProjectSummary, RecallResponse, RecallScope } from "~/contracts";
import type { ApiClient } from "~/lib/api";
import { createLoader, type Loader } from "~/lib/loader";
import { statusOf, type KeyStatus } from "./status";

export function createRecallState({
  client,
  tracked,
}: {
  client: ApiClient;
  tracked: <T>(read: () => Promise<T>) => Promise<T>;
}) {
  function search(
    source: Accessor<{
      project: ProjectSummary;
      q: string;
      scope: RecallScope;
    } | null>,
  ): { loader: Loader<RecallResponse>; status: Accessor<KeyStatus> } {
    const loader = createLoader(
      () => {
        const value = source();
        return value
          ? new URLSearchParams({
              projectId: value.project.id,
              q: value.q,
              scope: value.scope,
            }).toString()
          : null;
      },
      (_, signal) => {
        const value = source();
        if (!value) throw new Error("Recall query changed");
        return tracked(() =>
          client.recall(
            { q: value.q, project: value.project, scope: value.scope },
            signal,
          ),
        );
      },
    );
    return { loader, status: statusOf(loader) };
  }
  return { search };
}
