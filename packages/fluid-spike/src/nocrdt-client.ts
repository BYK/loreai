export interface NoCrdtAgent {
  documentId: string;
  ownerToken: string;
  append(
    text: string,
    author?: string,
    at?: number,
  ): Promise<{ author: string; text: string; at: number }>;
  state(): unknown[];
  observations(): Array<{ text: string; seen: number }>;
  onDisconnect(listener: () => void): () => void;
  close(): void;
}

async function issueToken(
  gatewayUrl: string,
  documentId: string | undefined,
  participant: string,
): Promise<{ documentId: string; token: string }> {
  const response = await fetch(`${gatewayUrl}/api/v1/spike/nocrdt/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ documentId: documentId ?? "", participant }),
  });
  if (!response.ok)
    throw new Error(`No-CRDT token request failed: ${response.status}`);
  return (await response.json()) as { documentId: string; token: string };
}

export async function joinDiscussion(
  gatewayUrl: string,
  documentId: string | undefined,
  participant = "agent",
): Promise<NoCrdtAgent> {
  const credentials = await issueToken(gatewayUrl, documentId, participant);
  const state: unknown[] = [];
  const observed: Array<{ text: string; seen: number }> = [];
  const controller = new AbortController();
  const disconnectListeners = new Set<() => void>();
  const notifyDisconnected = () => {
    for (const listener of disconnectListeners) listener();
  };
  let connectedResolve!: () => void;
  const ready = new Promise<void>((resolve) => (connectedResolve = resolve));
  let lastSequence = 0;
  const streamUrl = `${gatewayUrl}/api/v1/spike/nocrdt/discussions/${encodeURIComponent(credentials.documentId)}/events`;
  const connected = (async () => {
    while (!controller.signal.aborted) {
      try {
        const url = new URL(streamUrl);
        url.searchParams.set("token", credentials.token);
        url.searchParams.set("lastEventId", String(lastSequence));
        const response = await fetch(url, {
          signal: controller.signal,
        });
        if (response.status === 403 && lastSequence > 0) {
          notifyDisconnected();
          return;
        }
        if (!response.ok || !response.body) {
          throw new Error(`No-CRDT event stream failed: ${response.status}`);
        }
        connectedResolve();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!controller.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) {
            notifyDisconnected();
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split("\n\n");
          buffer = blocks.pop() ?? "";
          for (const block of blocks) {
            const line = block
              .split("\n")
              .find((entry) => entry.startsWith("data: "));
            if (!line) continue;
            const reply = JSON.parse(line.slice(6)) as {
              text: string;
              sequence: number;
              author: string;
              participant: string;
              at: number;
            };
            lastSequence = Math.max(lastSequence, reply.sequence);
            state.push(reply);
            observed.push({
              text: reply.text,
              seen: performance.timeOrigin + performance.now(),
            });
          }
        }
      } catch {
        if (controller.signal.aborted) return;
      }
      if (!controller.signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  })();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ready,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("No-CRDT SSE connection timeout")),
          10_000,
        );
      }),
    ]);
  } catch (error) {
    controller.abort();
    throw error;
  }
  if (timeoutId) clearTimeout(timeoutId);
  return {
    documentId: credentials.documentId,
    ownerToken: credentials.token,
    async append(
      text,
      author = participant,
      at = performance.timeOrigin + performance.now(),
    ) {
      const response = await fetch(
        `${gatewayUrl}/api/v1/spike/nocrdt/discussions/${encodeURIComponent(credentials.documentId)}/replies`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ text, author, at, token: credentials.token }),
        },
      );
      if (!response.ok)
        throw new Error(`No-CRDT append failed: ${response.status}`);
      await response.json();
      return { author: participant, text, at };
    },
    state: () => [...state],
    observations: () => [...observed],
    onDisconnect(listener) {
      disconnectListeners.add(listener);
      return () => disconnectListeners.delete(listener);
    },
    close: () => {
      controller.abort();
      void connected.catch(() => {});
    },
  };
}

export function createDiscussion(gatewayUrl: string, participant = "agent") {
  return joinDiscussion(gatewayUrl, undefined, participant);
}
