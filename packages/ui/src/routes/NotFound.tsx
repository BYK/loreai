import type { Component } from "solid-js";
import { createMemo, Show } from "solid-js";
import { A, useLocation } from "@solidjs/router";

import { Shell } from "~/components/shell/Shell";
import { Icon } from "~/components/shell/Icon";
import { workspacePath } from "~/components/shell/navigation";
import { Button } from "~/components/ui/button";
import { projectHref, workspaceSearchHref } from "~/lib/href";
import { useWorkspace } from "./workspace";

/** Unknown routes retain the workspace and offer only confirmed destinations. */
export const NotFound: Component = () => {
  const location = useLocation();
  const workspace = useWorkspace();
  const project = createMemo(() => {
    const segment = workspacePath(location.pathname).match(
      /^\/projects\/([^/]+)(?:\/|$)/,
    )?.[1];
    if (!segment) return undefined;
    try {
      return workspace.projectById(decodeURIComponent(segment));
    } catch {
      return undefined;
    }
  });

  return (
    <Shell
      mobilePane="detail"
      pageLabel="Page not found"
      searchProjectId={project()?.id}
      detail={
        <div class="flex min-h-full items-center justify-center px-5 py-12 sm:px-8 sm:py-16">
          <section
            class="w-full max-w-lg text-center"
            aria-labelledby="not-found-title"
            data-testid="not-found"
          >
            <div
              class="relative mx-auto mb-7 flex size-20 items-center justify-center rounded-2xl border border-line bg-bg"
              aria-hidden="true"
            >
              <Icon name="book" class="size-9 text-muted" />
              <span class="absolute -bottom-2 -right-2 flex size-9 items-center justify-center rounded-xl border border-line bg-accent-soft text-accent-soft-text">
                <Icon name="search" class="size-[18px]" />
              </span>
            </div>
            <p class="mb-3 text-xs font-medium uppercase tracking-[0.16em] text-muted">
              Error 404
            </p>
            <h1
              id="not-found-title"
              class="text-balance text-[28px] font-semibold leading-tight tracking-tight text-heading sm:text-[34px]"
            >
              Page not found
            </h1>
            <p class="mx-auto mt-4 max-w-sm text-pretty text-sm leading-6 text-muted">
              The link may be outdated, or the address may be incorrect. Choose
              a destination below to keep exploring.
            </p>
            <div class="mt-7 flex flex-col justify-center gap-3 sm:flex-row">
              <Button as={A} href="/" class="h-11 px-5">
                <Icon name="folder" />
                Browse projects
              </Button>
              <Button
                as={A}
                href={workspaceSearchHref("")}
                variant="outline"
                class="h-11 px-5"
              >
                <Icon name="search" />
                Search knowledge
              </Button>
            </div>
            <Show when={project()}>
              {(current) => (
                <div class="mt-8 border-t border-line pt-6">
                  <p class="mb-3 text-xs text-muted">
                    Continue in this project
                  </p>
                  <Button
                    as={A}
                    href={projectHref(current().id)}
                    aria-label={`Return to project: ${current().name || current().path}`}
                    variant="outline"
                    class="h-auto min-h-16 w-full justify-start gap-3 whitespace-normal px-4 py-3 text-left"
                  >
                    <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-soft text-muted">
                      <Icon name="folder" />
                    </span>
                    <span class="min-w-0 flex-1">
                      <span class="block break-words text-sm font-medium [overflow-wrap:anywhere]">
                        {current().name || current().path}
                      </span>
                      <span class="mt-0.5 block text-xs font-normal text-muted">
                        Return to project
                      </span>
                    </span>
                    <Icon name="chevron" class="text-muted" />
                  </Button>
                </div>
              )}
            </Show>
          </section>
        </div>
      }
    />
  );
};
