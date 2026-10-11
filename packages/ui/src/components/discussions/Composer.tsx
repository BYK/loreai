/**
 * Reply box with an IndexedDB-backed draft. Text is saved on every edit and
 * restored on mount; it is only sent by an explicit submit (button or
 * Ctrl/Cmd+Enter) and the draft is dropped only after the server accepted it.
 */
import type { Component } from "solid-js";
import {
  createComputed,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";

import { Button } from "~/components/ui/button";
import { useWorkspace } from "~/routes/workspace";

export const Composer: Component<{
  draftKey: string;
  projectId: string;
  target: string | null;
  placeholder?: string;
  submitLabel: string;
  /** Allow submitting empty text (Save note without a comment). */
  allowEmpty?: boolean;
  autofocus?: boolean;
  onSubmit: (text: string) => Promise<void>;
  onCancel?: () => void;
  testId?: string;
}> = (props) => {
  const ws = useWorkspace();
  const drafts = ws.state.discussions.drafts;
  const [text, setText] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [restored, setRestored] = createSignal(false);
  let input: HTMLTextAreaElement | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let pending: string | null = null;
  // Props can come from a parent `<Show>` accessor that throws once the
  // parent unmounts (e.g. a successful submit clears the selection), so
  // draft writes after that use the last values seen while mounted.
  let draft = { key: "", projectId: "", target: null as string | null };
  createComputed(() => {
    draft = {
      key: props.draftKey,
      projectId: props.projectId,
      target: props.target,
    };
  });

  const flush = () => {
    clearTimeout(saveTimer);
    if (pending === null) return Promise.resolve();
    const value = pending;
    pending = null;
    const { key, projectId, target } = draft;
    return value.trim() === ""
      ? drafts.delete(key)
      : drafts.put({ key, projectId, target, body: { text: value } });
  };

  onMount(() => {
    void drafts.get(props.draftKey).then((draft) => {
      if (draft && text() === "") {
        setText(draft.body.text);
        setRestored(true);
      }
    });
    if (props.autofocus) input?.focus();
  });
  // Unmounting doesn't cancel the write; a tab being hidden or closed can
  // end the page before the debounce fires, so flush right away.
  const onHidden = () => {
    if (document.visibilityState === "hidden") void flush();
  };
  document.addEventListener("visibilitychange", onHidden);
  onCleanup(() => {
    document.removeEventListener("visibilitychange", onHidden);
    void flush();
  });

  function edit(value: string) {
    setText(value);
    setRestored(false);
    pending = value;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void flush(), 250);
  }

  async function submit() {
    const value = text().trim();
    if (busy() || (!value && !props.allowEmpty)) return;
    setBusy(true);
    setError(null);
    let sent = false;
    try {
      await flush();
      const { key } = draft;
      await props.onSubmit(value);
      sent = true;
      clearTimeout(saveTimer);
      pending = null;
      setText("");
      setRestored(false);
      await drafts.delete(key);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(
        sent ? `Sent, but the saved draft wasn't cleared: ${message}` : message,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      class="mt-2"
      data-testid={props.testId ?? "discussion-composer"}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <textarea
        ref={(el) => (input = el)}
        rows={2}
        class="block w-full resize-y rounded-md border border-line bg-bg px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        placeholder={props.placeholder ?? "Reply…"}
        aria-label={props.placeholder ?? "Reply"}
        value={text()}
        readOnly={busy()}
        aria-busy={busy()}
        onInput={(e) => edit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <div class="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted">
        <Button
          type="submit"
          size="sm"
          disabled={busy() || (!props.allowEmpty && text().trim() === "")}
          data-testid="composer-submit"
        >
          {props.submitLabel}
        </Button>
        <Show when={props.onCancel}>
          {(cancel) => (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => cancel()()}
            >
              Cancel
            </Button>
          )}
        </Show>
        <Show when={restored()}>
          <span data-testid="draft-restored">Draft restored · not sent</span>
        </Show>
        <Show when={error()}>
          {(err) => (
            <span class="text-danger" role="alert">
              {err()}
            </span>
          )}
        </Show>
      </div>
    </form>
  );
};
