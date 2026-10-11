import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";

const doc = new Y.Doc();
const replies = doc.getArray<Y.Map<unknown>>("replies");
Object.assign(globalThis, {
  spikeSize: {
    doc,
    replies,
    YMap: Y.Map,
    connect: (url: string, room: string) =>
      new WebsocketProvider(url, room, doc),
  },
});
