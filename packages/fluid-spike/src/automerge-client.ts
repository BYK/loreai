import {
  Repo,
  type AnyDocumentId,
  type DocHandle,
  type PeerId,
} from "@automerge/automerge-repo";
import { cbor } from "@automerge/automerge-repo/slim";
import { WebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket";

type Reply = { author: string; text: string; at: number };
type Document = { replies: Reply[] };

export interface AutomergeAgent {
  documentId: string;
  ownerToken?: string;
  append(
    text: string,
    at?: number,
  ): { author: string; text: string; at: number };
  state(): Reply[];
  observations(): Array<{ text: string; seen: number }>;
  onDisconnect(listener: () => void): () => void;
  onRevocation(listener: (documentId: string) => void): () => void;
  close(): Promise<void>;
}

async function tokenFor(
  gatewayUrl: string,
  documentId: string,
  participant: string,
  createIfMissing = false,
): Promise<{ documentId: string; token: string }> {
  const response = await fetch(`${gatewayUrl}/api/v1/spike/automerge/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ documentId, participant, createIfMissing }),
  });
  if (!response.ok)
    throw new Error(`Automerge token request failed: ${response.status}`);
  return (await response.json()) as { documentId: string; token: string };
}

function adapterFor(gatewayUrl: string, token: string) {
  const url = `${gatewayUrl.replace(/^http/, "ws")}/automerge-spike?token=${encodeURIComponent(token)}`;
  const configured =
    typeof process === "undefined"
      ? 5000
      : Number(process.env.LORE_SPIKE_AUTOMERGE_RETRY_INTERVAL_MS ?? 5000);
  const retryInterval =
    Number.isFinite(configured) && configured >= 0 ? configured : 5000;
  return new WebSocketClientAdapter(url, retryInterval);
}

function clientFor(
  repo: Repo,
  handle: DocHandle<Document>,
  participant: string,
  ownerToken?: string,
  adapter?: WebSocketClientAdapter,
): AutomergeAgent {
  const observed: Array<{ text: string; seen: number }> = [];
  const seen = new Set<string>();
  handle.on("change", ({ doc }) => {
    for (const reply of doc.replies ?? []) {
      if (!seen.has(reply.text)) {
        seen.add(reply.text);
        observed.push({
          text: reply.text,
          seen: performance.timeOrigin + performance.now(),
        });
      }
    }
  });
  return {
    documentId: handle.documentId,
    ownerToken,
    append(text, at = performance.timeOrigin + performance.now()) {
      handle.change((doc) => {
        doc.replies.push({
          author: participant,
          text,
          at,
        });
      });
      return { author: participant, text, at };
    },
    state: () => [...(handle.doc().replies ?? [])],
    observations: () => [...observed],
    onDisconnect(listener) {
      adapter?.socket?.addEventListener("close", listener);
      return () => adapter?.socket?.removeEventListener("close", listener);
    },
    onRevocation(listener) {
      const onMessage = ({ message }: { message: unknown }) => {
        const value =
          message instanceof Uint8Array ? cbor.decode(message) : message;
        if (
          typeof value === "object" &&
          value !== null &&
          "type" in value &&
          value.type === "share-revoked"
        ) {
          listener(handle.documentId);
        }
      };
      handle.on("ephemeral-message", onMessage);
      return () => handle.off("ephemeral-message", onMessage);
    },
    close: () => repo.shutdown(),
  };
}

export async function createDiscussion(
  gatewayUrl: string,
  participant = "agent",
): Promise<AutomergeAgent> {
  const repo = new Repo({ peerId: participant as PeerId });
  const handle = repo.create<Document>({ replies: [] });
  const credentials = await tokenFor(
    gatewayUrl,
    handle.documentId,
    participant,
    true,
  );
  const adapter = adapterFor(gatewayUrl, credentials.token);
  repo.networkSubsystem.addNetworkAdapter(adapter);
  await adapter.whenReady();
  return clientFor(repo, handle, participant, credentials.token, adapter);
}

export async function joinDiscussion(
  gatewayUrl: string,
  documentId: string,
  participant = "agent",
): Promise<AutomergeAgent> {
  const credentials = await tokenFor(gatewayUrl, documentId, participant);
  const adapter = adapterFor(gatewayUrl, credentials.token);
  const repo = new Repo({
    network: [adapter],
    peerId: participant as PeerId,
  });
  const handle = await repo.find<Document>(documentId as AnyDocumentId);
  await handle.whenReady();
  return clientFor(repo, handle, participant, undefined, adapter);
}

export async function shareDiscussion(
  gatewayUrl: string,
  documentId: string,
  ownerToken: string,
  participant: string,
): Promise<void> {
  const response = await fetch(`${gatewayUrl}/api/v1/spike/automerge/share`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ documentId, participant, token: ownerToken }),
  });
  if (!response.ok)
    throw new Error(`Automerge share failed: ${response.status}`);
}

export async function unshareDiscussion(
  gatewayUrl: string,
  documentId: string,
  ownerToken: string,
  participant: string,
): Promise<void> {
  const response = await fetch(`${gatewayUrl}/api/v1/spike/automerge/share`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ documentId, participant }),
  });
  if (!response.ok)
    throw new Error(`Automerge unshare failed: ${response.status}`);
}
