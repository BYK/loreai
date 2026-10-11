import type { Component } from "solid-js";
import { For, Show } from "solid-js";

import type { KnowledgeFiles as KnowledgeFilesData } from "~/contracts";
import { repoFileUrl } from "~/lib/repo-links";
import type { Loader } from "~/lib/loader";
import { Badge } from "~/components/ui/badge";
import { errorStateFor } from "./ErrorState";
import { StateCard } from "./StateCard";

export const KnowledgeFiles: Component<{
  loader: Loader<KnowledgeFilesData>;
}> = (props) => {
  const data = () => props.loader.data();
  const supportsGitHub = () =>
    repoFileUrl(data()?.git_remote ?? null, data()?.commit ?? null, "file") !==
    null;

  return (
    <section class="mt-4" aria-labelledby="knowledge-files-heading">
      <h3 id="knowledge-files-heading" class="mb-1 font-semibold">
        Files
      </h3>
      <Show
        when={data()}
        fallback={
          <Show
            when={props.loader.error()}
            fallback={
              <StateCard kind="loading" title="Loading files" compact />
            }
          >
            {errorStateFor(props.loader.error(), "Files", props.loader.reload)}
          </Show>
        }
      >
        {(value) => (
          <>
            <Show
              when={value().files.length > 0}
              fallback={
                <p class="m-0 text-muted">
                  No files recorded for this entry on this gateway.
                </p>
              }
            >
              <ul class="m-0 list-none space-y-2 p-0">
                <For each={value().files}>
                  {(file) => {
                    const link = () =>
                      repoFileUrl(
                        value().git_remote,
                        value().commit,
                        file.path,
                      );
                    return (
                      <li class="flex min-w-0 flex-wrap items-center gap-2">
                        <code class="min-w-0 break-all rounded-sm bg-chrome px-1.5 py-0.5 font-mono text-[11px]">
                          {file.path}
                        </code>
                        <Show when={file.recorded}>
                          <Badge variant="outline">recorded with entry</Badge>
                        </Show>
                        <Show when={file.verified}>
                          <Badge variant="teal">
                            cited in content · verified on last check
                          </Badge>
                        </Show>
                        <Show when={link()}>
                          {(repo) => (
                            <a
                              class="text-accent underline"
                              href={repo().href}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              GitHub{" "}
                              <span class="text-muted">{repo().label}</span>
                            </a>
                          )}
                        </Show>
                      </li>
                    );
                  }}
                </For>
              </ul>
            </Show>
            <Show when={value().files.length > 0}>
              <Show
                when={supportsGitHub()}
                fallback={
                  <p class="mb-0 mt-2 text-muted">
                    Repository links are available for GitHub remotes.
                  </p>
                }
              >
                <p class="mb-0 mt-2 text-muted">
                  {value().commit
                    ? "Links point at the commit the session was on when this version was written; it may not be pushed."
                    : "No commit recorded — links open the default branch, which may have changed."}
                </p>
              </Show>
            </Show>
            <Show when={value().omitted > 0}>
              <p class="mb-0 mt-2 text-muted">
                {value().omitted} recorded{" "}
                {value().omitted === 1 ? "path" : "paths"} not shown — outside
                this repository or not a repository-relative path.
              </p>
            </Show>
          </>
        )}
      </Show>
    </section>
  );
};
