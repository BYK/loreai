import "@automerge/automerge";
import {
  createDiscussion,
  joinDiscussion,
  shareDiscussion,
  type AutomergeAgent,
} from "./automerge-client";

const query = new URLSearchParams(location.search);
const gatewayUrl = `http://127.0.0.1:${query.get("port") ?? "8787"}`;
const participant = query.get("author") ?? "alice";
let active: AutomergeAgent | undefined;

window.spike = {
  async create() {
    await active?.close();
    active = await createDiscussion(gatewayUrl, participant);
    return active.documentId;
  },
  async load(documentId) {
    await active?.close();
    active = await joinDiscussion(gatewayUrl, documentId, participant);
  },
  async share(documentId, name) {
    if (!active?.ownerToken)
      throw new Error("Only the owner may share the document");
    await shareDiscussion(gatewayUrl, documentId, active.ownerToken, name);
  },
  append(_author, text, at) {
    return active?.append(text, at);
  },
  observations() {
    return active?.observations() ?? [];
  },
  finalState() {
    return active?.state() ?? [];
  },
  async ready() {},
  dispose() {
    void active?.close();
    active = undefined;
  },
};
