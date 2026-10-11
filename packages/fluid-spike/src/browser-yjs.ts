import * as Y from "yjs";
import { YjsProvider } from "./yjs-provider";

const query = new URLSearchParams(location.search);
const gatewayUrl = `http://127.0.0.1:${query.get("port") ?? "8787"}`;
const participant = query.get("author") ?? "alice";
let provider: YjsProvider | undefined;
let ownerToken: string | undefined;

async function credentials(
  documentId?: string,
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

function connect(result: { documentId: string; token: string }): void {
  provider?.close();
  const doc = new Y.Doc();
  provider = new YjsProvider(
    result.documentId,
    participant,
    doc,
    (url) => new WebSocket(url) as never,
    gatewayUrl.replace(/^http/, "ws"),
    result.token,
  );
}

window.spike = {
  async create() {
    const result = await credentials();
    ownerToken = result.token;
    connect(result);
    await provider?.ready;
    return result.documentId;
  },
  async load(documentId) {
    const result = await credentials(documentId);
    connect(result);
    await provider?.ready;
  },
  async share(documentId, name) {
    if (!ownerToken) throw new Error("Only the document owner may share it");
    const response = await fetch(`${gatewayUrl}/api/v1/spike/yjs/share`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        documentId,
        participant: name,
        token: ownerToken,
      }),
    });
    if (!response.ok) throw new Error(`Yjs share failed: ${response.status}`);
  },
  append(_author, text, at) {
    return provider?.append(text, at);
  },
  observations() {
    return (
      provider?.observationList().map(({ text, seen }) => ({ text, seen })) ??
      []
    );
  },
  finalState() {
    return provider?.state() ?? [];
  },
  async ready() {
    await provider?.ready;
  },
  dispose() {
    provider?.close();
    provider = undefined;
  },
};
