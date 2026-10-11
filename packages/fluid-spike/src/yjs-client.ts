import { WebSocket } from "ws";
import * as Y from "yjs";
import { YjsProvider } from "./yjs-provider.js";

export interface SpikeAgent {
  documentId: string;
  append(
    text: string,
    at?: number,
  ): { author: string; text: string; at: number };
  state(): unknown[];
  observations(): Array<{ text: string; seen: number; replies: number }>;
  close(): void;
}

async function tokenFor(
  gatewayUrl: string,
  documentId: string | undefined,
  participant: string,
): Promise<{ documentId: string; token: string }> {
  const response = await fetch(`${gatewayUrl}/api/v1/spike/yjs/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ documentId: documentId ?? "", participant }),
  });
  if (!response.ok)
    throw new Error(`Yjs token request failed: ${response.status}`);
  return (await response.json()) as { documentId: string; token: string };
}

async function connect(
  gatewayUrl: string,
  documentId: string | undefined,
  participant: string,
): Promise<SpikeAgent> {
  const credentials = await tokenFor(gatewayUrl, documentId, participant);
  const doc = new Y.Doc();
  const provider = new YjsProvider(
    credentials.documentId,
    participant,
    doc,
    (url) => new WebSocket(url) as never,
    gatewayUrl.replace(/^http/, "ws"),
    credentials.token,
  );
  await provider.ready;
  return {
    documentId: credentials.documentId,
    append: (text, at) => provider.append(text, at),
    state: () => provider.state(),
    observations: () => provider.observationList(),
    close: () => provider.close(),
  };
}

export function createDiscussion(gatewayUrl: string, participant = "agent") {
  return connect(gatewayUrl, undefined, participant);
}

export function joinDiscussion(
  gatewayUrl: string,
  documentId: string,
  participant = "agent",
) {
  return connect(gatewayUrl, documentId, participant);
}

export async function shareDiscussion(
  gatewayUrl: string,
  documentId: string,
  ownerToken: string,
  participant: string,
): Promise<void> {
  const response = await fetch(`${gatewayUrl}/api/v1/spike/yjs/share`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ documentId, participant }),
  });
  if (!response.ok)
    throw new Error(`Yjs share request failed: ${response.status}`);
}

export async function unshareDiscussion(
  gatewayUrl: string,
  documentId: string,
  ownerToken: string,
  participant: string,
): Promise<void> {
  const response = await fetch(`${gatewayUrl}/api/v1/spike/yjs/share`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ documentId, participant }),
  });
  if (!response.ok)
    throw new Error(`Yjs unshare request failed: ${response.status}`);
}
