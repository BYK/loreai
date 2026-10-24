import { Icon } from "~/components/shell/Icon";
import { Combobox } from "@kobalte/core/combobox";
import { createMemo, createSignal, Show } from "solid-js";
import type { Component } from "solid-js";

import type { ProjectSummary } from "~/contracts";
import { fuzzyRank, FUZZY_MIN_QUERY, normalizeFuzzy } from "~/lib/fuzzy";

const label = (project: ProjectSummary) => project.name || project.path;

/** Search loaded projects while keeping selection tied to an explicit ID. */
export const ProjectPicker: Component<{
  projects: ProjectSummary[];
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
}> = (props) => {
  const [query, setQuery] = createSignal("");
  const selected = createMemo(() =>
    props.projects.find((project) => project.id === props.value),
  );
  const hits = createMemo(() => {
    const q = normalizeFuzzy(query());
    // A selected label is not an active search; opening it offers all targets.
    if (selected() || !q) {
      return props.projects.map((item) => ({ item, exact: true }));
    }
    if (q.length < FUZZY_MIN_QUERY) {
      return props.projects
        .filter((project) =>
          [project.name ?? "", project.path].some((key) =>
            normalizeFuzzy(key).includes(q),
          ),
        )
        .map((item) => ({ item, exact: true }));
    }
    return fuzzyRank(query(), props.projects, (project) => [
      project.name ?? "",
      project.path,
    ]);
  });
  const approximate = createMemo(
    () =>
      new Set(
        hits()
          .filter((hit) => !hit.exact)
          .map((hit) => hit.item.id),
      ),
  );

  return (
    <Combobox<ProjectSummary>
      options={hits().map((hit) => hit.item)}
      optionValue="id"
      optionLabel={label}
      optionTextValue={label}
      value={selected() ?? null}
      onChange={(project) => props.onChange(project?.id ?? null)}
      onInputChange={setQuery}
      defaultFilter={() => true}
      triggerMode="input"
      noResetInputOnBlur
      allowsEmptyCollection
      modal={false}
      disabled={props.disabled}
      placeholder="Search projects by name or path"
      itemComponent={(item) => (
        <Combobox.Item
          item={item.item}
          data-project-id={item.item.rawValue.id}
          // Options use virtual focus: keep mouse focus on the input until selection.
          onMouseDown={(event) => event.preventDefault()}
          class="m-0 cursor-default rounded px-2.5 py-2 text-sm outline-hidden data-[highlighted]:bg-soft data-[selected]:bg-chrome"
        >
          <Combobox.ItemLabel class="flex items-center justify-between gap-2 font-medium">
            <span class="truncate">{label(item.item.rawValue)}</span>
            <Show when={approximate().has(item.item.rawValue.id)}>
              <span class="shrink-0 text-[11px] font-normal text-muted">
                Approximate match
              </span>
            </Show>
          </Combobox.ItemLabel>
          <Combobox.ItemDescription
            class="block truncate text-xs text-muted"
            title={item.item.rawValue.path}
          >
            {item.item.rawValue.path}
          </Combobox.ItemDescription>
        </Combobox.Item>
      )}
    >
      <Combobox.Label class="mb-1.5 block text-xs font-medium">
        Target project
      </Combobox.Label>
      <Combobox.Control class="flex h-10 w-full items-center rounded-md border border-input bg-transparent focus-within:ring-2 focus-within:ring-ring">
        <Combobox.Input
          class="h-full min-w-0 flex-1 bg-transparent px-3 text-sm outline-hidden placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-50"
          // Native edits revoke the old choice; programmatic label updates do not.
          onInput={() => props.onChange(null)}
          on:keydown={(event) => {
            // Candidate navigation/confirmation belongs to the native IME,
            // not the combobox or the surrounding dialog.
            if (event.isComposing || event.keyCode === 229) {
              event.stopPropagation();
              return;
            }
            // Mark Escape before document listeners run. Kobalte still closes
            // the popup, while the parent dialog respects defaultPrevented.
            if (
              event.key === "Escape" &&
              event.currentTarget.getAttribute("aria-expanded") === "true"
            ) {
              event.preventDefault();
            }
          }}
        />
        <Combobox.Trigger
          aria-label="Show target projects"
          class="h-full px-3 text-muted outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          <Icon name="chevron" class="rotate-90" />
        </Combobox.Trigger>
      </Combobox.Control>
      {/* Keep the popup inside the parent dialog's focus and accessibility scope. */}
      <Combobox.Content class="z-50 w-[var(--kb-popper-anchor-width)] overflow-hidden rounded-md border border-line bg-surface text-text shadow-md">
        <Show when={hits().length === 0}>
          <div role="status" class="p-3 text-sm text-muted">
            No matching projects.
          </div>
        </Show>
        <Combobox.Listbox class="m-0 max-h-60 overflow-y-auto overscroll-contain p-1" />
      </Combobox.Content>
    </Combobox>
  );
};
