// Minimal custom Yjs provider: y-protocols sync + awareness over one WebSocket.
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

export function connect(url: string, doc: Y.Doc, user: { id: string }) {
  const awareness = new awarenessProtocol.Awareness(doc);
  awareness.setLocalStateField("user", user);
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const send = (encoder: encoding.Encoder) => {
    if (ws.readyState === WebSocket.OPEN)
      ws.send(encoding.toUint8Array(encoder));
  };
  ws.onopen = () => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, doc);
    send(encoder);
  };
  ws.onmessage = (event) => {
    const decoder = decoding.createDecoder(
      new Uint8Array(event.data as ArrayBuffer),
    );
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_SYNC) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, doc, ws);
      if (encoding.length(encoder) > 1) send(encoder);
    } else if (type === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(
        awareness,
        decoding.readVarUint8Array(decoder),
        ws,
      );
    }
  };
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === ws) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    send(encoder);
  });
  return { ws, awareness };
}

const doc = new Y.Doc();
const replies = doc.getArray<Y.Map<unknown>>("replies");
Object.assign(globalThis, {
  spikeSize: { connect, doc, replies, YMap: Y.Map },
});
