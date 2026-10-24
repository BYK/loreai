import { AsyncLocalStorage } from "node:async_hooks";

/** Separate body consumption from the downstream HTTP response's finish event. */
export interface ResponseCompletionCallbacks {
  /** The response body reached EOF; the HTTP response may still be flushing. */
  onComplete?: () => void;
  onDiscard?: () => void;
  /** Node confirmed the downstream HTTP response finished successfully. */
  onResponseFinished?: () => void;
}

const nodeResponseFinishLifecycle = new AsyncLocalStorage<boolean>();

/** Mark work invoked by the node:http bridge, which can observe `finish`. */
export function withNodeResponseFinishLifecycle<T>(operation: () => T): T {
  return nodeResponseFinishLifecycle.run(true, operation);
}

/** Direct pipeline callers have no socket-level finish event to wait for. */
export function hasNodeResponseFinishLifecycle(): boolean {
  return nodeResponseFinishLifecycle.getStore() === true;
}

export const responseCompletionCallbacks = new WeakMap<
  Response,
  ResponseCompletionCallbacks
>();
// Keep the body-EOF notification distinct until the HTTP finish event arrives.
const responseCompletionNotified = new WeakSet<Response>();

export function takeResponseCompletionCallbacks(
  response: Response,
): ResponseCompletionCallbacks | undefined {
  const callbacks = responseCompletionCallbacks.get(response);
  if (callbacks) responseCompletionCallbacks.delete(response);
  return callbacks;
}

export function notifyResponseCompletion(response: Response): void {
  const callbacks = responseCompletionCallbacks.get(response);
  if (!callbacks || responseCompletionNotified.has(response)) return;
  responseCompletionNotified.add(response);
  callbacks.onComplete?.();
}

export function notifyResponseFinished(response: Response): void {
  notifyResponseCompletion(response);
  const callbacks = takeResponseCompletionCallbacks(response);
  responseCompletionNotified.delete(response);
  callbacks?.onResponseFinished?.();
}

export function discardResponseCompletion(response: Response): void {
  const callbacks = takeResponseCompletionCallbacks(response);
  responseCompletionNotified.delete(response);
  callbacks?.onDiscard?.();
}

export function transferResponseCompletionCallback(
  source: Response,
  target: Response,
): void {
  const callbacks = takeResponseCompletionCallbacks(source);
  if (callbacks) {
    responseCompletionCallbacks.set(target, callbacks);
    if (responseCompletionNotified.delete(source)) {
      responseCompletionNotified.add(target);
    }
  }
}
