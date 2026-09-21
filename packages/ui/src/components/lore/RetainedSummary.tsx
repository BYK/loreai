import type { Component } from "solid-js";
import { Show, createSignal } from "solid-js";

import type { DistillationDetail, DistillationSummary } from "~/contracts";
import { formatWhen } from "~/lib/format";

export const RetainedSummary: Component<{
  distillation: DistillationSummary;
  load: (id: string) => Promise<DistillationDetail>;
}> = (props) => {
  const [state, setState] = createSignal<{
    loading: boolean;
    error: string | null;
    detail: DistillationDetail | null;
  }>({
    loading: false,
    error: null,
    detail: null,
  });

  const load = async () => {
    const current = state();
    if (current.loading || current.detail) return;
    setState({ loading: true, error: null, detail: null });
    try {
      const detail = await props.load(props.distillation.id);
      setState({ loading: false, error: null, detail });
    } catch (error) {
      setState({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
        detail: null,
      });
    }
  };

  return (
    <details
      class="mt-1"
      data-testid={`retained-summary-${props.distillation.id}`}
      onToggle={(event) => {
        if (event.currentTarget.open) void load();
      }}
    >
      <summary class="cursor-pointer text-accent">
        gen {props.distillation.generation},{" "}
        {formatWhen(props.distillation.created_at)} · Show retained summary
      </summary>
      <Show when={state().loading}>
        <p class="my-2 text-xs text-muted">Loading…</p>
      </Show>
      <Show when={state().error}>
        {(error) => <p class="my-2 text-xs text-danger">{error()}</p>}
      </Show>
      <Show when={state().detail}>
        {(detail) => (
          <>
            <p class="my-2 text-xs text-muted">
              Lore&apos;s summary of the expired messages — not what anyone said
              · exact message not recorded.
            </p>
            <pre class="rich-text-plain mt-2 whitespace-pre-wrap font-mono text-xs leading-relaxed">
              {detail().observations}
            </pre>
          </>
        )}
      </Show>
    </details>
  );
};
