import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  type Accessor,
} from "solid-js";

/** Clipboard receipts belong to the source that was copied, never its replacement. */
export function createClipboard(source: Accessor<unknown>) {
  const [pending, setPending] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const key = createMemo(source);
  let generation = 0;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reset = () => {
    generation++;
    clearTimeout(timer);
    setPending(false);
    setCopied(false);
    setError(null);
  };
  createEffect(on(key, reset));
  onCleanup(() => {
    disposed = true;
    generation++;
    clearTimeout(timer);
  });
  const copy = async (text: string) => {
    if (pending() || disposed) return;
    reset();
    const operation = generation;
    const value = key();
    const current = () =>
      !disposed && operation === generation && value === key();
    setPending(true);
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
      if (!current()) return;
      setCopied(true);
      timer = setTimeout(() => setCopied(false), 2000);
    } catch (cause) {
      if (!current()) return;
      const reason =
        cause instanceof Error && cause.message ? ` (${cause.message})` : "";
      setError(`Copy failed${reason}. Select and copy the text manually.`);
    } finally {
      if (current()) setPending(false);
    }
  };
  return { pending, copied, error, copy, reset };
}
