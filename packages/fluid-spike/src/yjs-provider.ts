import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

export type SocketLike = {
  readyState: number;
  binaryType?: string;
  addEventListener(
    type: "open" | "close" | "message" | "error",
    listener: (
      event: Event | MessageEvent<ArrayBuffer> | CloseEvent | ErrorEvent,
    ) => void,
  ): void;
  send(data: Uint8Array): void;
  close(): void;
};

export class YjsProvider {
  readonly awareness: awarenessProtocol.Awareness;
  private socket!: SocketLike;
  private readonly socketFactory: (url: string) => SocketLike;
  private readonly url: string;
  private readyResolve!: () => void;
  private readyPromise = new Promise<void>(
    (resolve) => (this.readyResolve = resolve),
  );
  private stopped = false;
  private readonly disconnectListeners = new Set<(code: number) => void>();
  private readonly observations: Array<{
    text: string;
    seen: number;
    replies: number;
  }> = [];
  private readonly seen = new Set<string>();

  constructor(
    readonly documentId: string,
    readonly participant: string,
    readonly doc: Y.Doc,
    socketFactory: (url: string) => SocketLike,
    gatewayUrl: string,
    token: string,
  ) {
    this.awareness = new awarenessProtocol.Awareness(doc);
    this.awareness.setLocalStateField("participant", participant);
    this.socketFactory = socketFactory;
    this.url = `${gatewayUrl.replace(/\/$/, "")}/yjs-spike/${encodeURIComponent(documentId)}?token=${encodeURIComponent(token)}`;
    this.connect();
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === this.socket || this.socket.readyState !== 1) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.socket.send(encoding.toUint8Array(encoder));
    });
    this.awareness.on(
      "update",
      ({
        added,
        updated,
        removed,
      }: {
        added: number[];
        updated: number[];
        removed: number[];
      }) => {
        const ids = [...added, ...updated, ...removed];
        if (ids.length === 0 || this.socket.readyState !== 1) return;
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, ids),
        );
        this.socket.send(encoding.toUint8Array(encoder));
      },
    );
    doc.getArray("replies").observe(() => {
      const replies = doc.getArray("replies").toArray() as Array<{
        text?: string;
      }>;
      for (const reply of replies) {
        if (typeof reply.text === "string" && !this.seen.has(reply.text)) {
          this.seen.add(reply.text);
          this.observations.push({
            text: reply.text,
            seen: performance.timeOrigin + performance.now(),
            replies: replies.length,
          });
        }
      }
    });
  }

  private connect(): void {
    if (this.stopped) return;
    const socket = this.socketFactory(this.url);
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(encoder, this.doc);
      socket.send(encoding.toUint8Array(encoder));
      const awareness = encoding.createEncoder();
      encoding.writeVarUint(awareness, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        awareness,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, [
          this.awareness.clientID,
        ]),
      );
      socket.send(encoding.toUint8Array(awareness));
    });
    socket.addEventListener("message", (event) => {
      if (!("data" in event) || typeof event.data === "string") return;
      const data = new Uint8Array(event.data);
      try {
        const decoder = decoding.createDecoder(data);
        const type = decoding.readVarUint(decoder);
        if (type === MESSAGE_SYNC) {
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, MESSAGE_SYNC);
          syncProtocol.readSyncMessage(decoder, encoder, this.doc, socket);
          if (encoding.length(encoder) > 1) {
            socket.send(encoding.toUint8Array(encoder));
          }
          this.readyResolve();
        } else if (type === MESSAGE_AWARENESS) {
          awarenessProtocol.applyAwarenessUpdate(
            this.awareness,
            decoding.readVarUint8Array(decoder),
            socket,
          );
        }
      } catch {
        socket.close();
      }
    });
    socket.addEventListener("error", () => {});
    socket.addEventListener("close", (event) => {
      const code = "code" in event ? event.code : 0;
      for (const listener of this.disconnectListeners) listener(code);
      if (this.stopped) return;
      if (code === 1008) return;
      this.readyPromise = new Promise<void>((resolve) => {
        this.readyResolve = resolve;
      });
      setTimeout(() => this.connect(), 50);
    });
  }

  get ready(): Promise<void> {
    return this.readyPromise;
  }

  state(): unknown[] {
    return this.doc.getArray("replies").toArray();
  }

  append(
    text: string,
    at = performance.timeOrigin + performance.now(),
  ): {
    author: string;
    text: string;
    at: number;
  } {
    this.doc.getArray("replies").push([{ author: this.participant, text, at }]);
    return { author: this.participant, text, at };
  }

  observationList(): Array<{ text: string; seen: number; replies: number }> {
    return [...this.observations];
  }

  close(): void {
    this.stopped = true;
    this.socket.close();
    this.awareness.destroy();
    this.doc.destroy();
  }

  onDisconnect(listener: (code: number) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }
}
