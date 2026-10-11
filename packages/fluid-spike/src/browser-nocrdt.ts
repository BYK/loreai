import {
  createDiscussion,
  joinDiscussion,
  type NoCrdtAgent,
} from "./nocrdt-client";

const query = new URLSearchParams(location.search);
const gatewayUrl = `http://127.0.0.1:${query.get("port") ?? "8787"}`;
const participant = query.get("author") ?? "alice";
let active: NoCrdtAgent | undefined;

window.spike = {
  async create() {
    active?.close();
    active = await createDiscussion(gatewayUrl, participant);
    return active.documentId;
  },
  async load(documentId) {
    active?.close();
    active = await joinDiscussion(gatewayUrl, documentId, participant);
  },
  async share(documentId, name) {
    if (!active?.ownerToken)
      throw new Error("Only the owner may share the discussion");
    const response = await fetch(`${gatewayUrl}/api/v1/spike/nocrdt/share`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        documentId,
        participant: name,
        token: active.ownerToken,
      }),
    });
    if (!response.ok)
      throw new Error(`No-CRDT share failed: ${response.status}`);
  },
  append(author, text, at) {
    return active?.append(text, author, at);
  },
  observations() {
    return active?.observations() ?? [];
  },
  finalState() {
    return active?.state() ?? [];
  },
  async ready() {},
  dispose() {
    active?.close();
    active = undefined;
  },
};
