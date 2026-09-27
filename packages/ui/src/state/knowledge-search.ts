import type { Accessor } from "solid-js";

import type { KnowledgeSearchResponse } from "~/contracts";
import type { ApiClient } from "~/lib/api";
import { createLoader, type Loader } from "~/lib/loader";
import { statusOf, type KeyStatus } from "./status";

export function createKnowledgeSearchState({
  client,
  tracked,
}: {
  client: ApiClient;
  tracked: <T>(read: () => Promise<T>) => Promise<T>;
}) {
  function search(
    source: Accessor<{ q: string; project: string | null } | null>,
  ): {
    loader: Loader<KnowledgeSearchResponse>;
    status: Accessor<KeyStatus>;
  } {
    const loader = createLoader(
      () => {
        const value = source();
        return value
          ? new URLSearchParams({
              q: value.q,
              project: value.project ?? "",
            }).toString()
          : null;
      },
      (_, signal) => {
        const value = source();
        if (!value) throw new Error("Knowledge search query changed");
        return tracked(() =>
          client.searchKnowledge(
            {
              q: value.q,
              limit: 50,
              project: value.project ?? undefined,
            },
            signal,
          ),
        );
      },
    );
    return { loader, status: statusOf(loader) };
  }

  return { search };
}
