/** Common transport options shared by every SSE protocol handler. */
export interface SSEStreamOptions {
  signal?: AbortSignal;
  inactivityMs?: number;
}
