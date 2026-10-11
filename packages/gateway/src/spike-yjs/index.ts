import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { db, withTransaction } from "@loreai/core";
import {
  recordSpikeAttribution,
  registerSpikeRevocationHandler,
  verifySpikeToken,
} from "../spike-shared";

type Peer = { socket: WebSocket; participant: string };
type DocumentState = {
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  peers: Set<Peer>;
  nextSequence: number;
};

const UPDATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS yjs_spike_updates (
    doc_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    "update" BLOB NOT NULL,
    participant TEXT NOT NULL,
    PRIMARY KEY (doc_id, seq)
  );
  CREATE TABLE IF NOT EXISTS yjs_spike_clients (
    doc_id TEXT NOT NULL,
    client_id INTEGER NOT NULL,
    participant TEXT NOT NULL,
    PRIMARY KEY (doc_id, client_id)
  );
`;
const MESSAGE_SYNC = 0;
const SYNC_STEP2 = 1;
const SYNC_UPDATE = 2;

function bytes(data: WebSocket.RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data);
}

function bindUpdateClients(
  documentId: string,
  participant: string,
  update: Uint8Array,
): boolean {
  const decoded = Y.decodeUpdate(update);
  const clientIds = new Set<number>();
  for (const struct of decoded.structs) clientIds.add(struct.id.client);
  for (const clientId of decoded.ds.clients.keys()) clientIds.add(clientId);
  if (clientIds.size === 0) return true;

  const connection = db();
  let authorized = true;
  withTransaction(() => {
    for (const clientId of clientIds) {
      const bound = connection
        .query(
          "SELECT participant FROM yjs_spike_clients WHERE doc_id = ? AND client_id = ?",
        )
        .get(documentId, clientId) as { participant: string } | undefined;
      if (bound && bound.participant !== participant) {
        authorized = false;
        return;
      }
    }
    for (const clientId of clientIds) {
      connection
        .query(
          "INSERT OR IGNORE INTO yjs_spike_clients (doc_id, client_id, participant) VALUES (?, ?, ?)",
        )
        .run(documentId, clientId, participant);
      const bound = connection
        .query(
          "SELECT participant FROM yjs_spike_clients WHERE doc_id = ? AND client_id = ?",
        )
        .get(documentId, clientId) as { participant: string } | undefined;
      if (!bound || bound.participant !== participant) {
        authorized = false;
        return;
      }
    }
  });
  return authorized;
}

function incomingSyncUpdate(frame: Uint8Array): Uint8Array | undefined {
  const decoder = decoding.createDecoder(frame);
  if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return undefined;
  const syncMessageType = decoding.readVarUint(decoder);
  if (syncMessageType !== SYNC_STEP2 && syncMessageType !== SYNC_UPDATE) {
    return undefined;
  }
  return decoding.readVarUint8Array(decoder);
}

function makeDocument(documentId: string): DocumentState {
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  db().exec(UPDATE_SCHEMA);
  const rows = db()
    .query(
      'SELECT seq AS sequence, "update" AS update_blob FROM yjs_spike_updates WHERE doc_id = ? ORDER BY seq',
    )
    .all(documentId) as Array<{ sequence: number; update_blob: Uint8Array }>;
  for (const row of rows) Y.applyUpdate(doc, new Uint8Array(row.update_blob));
  const state: DocumentState = {
    doc,
    awareness,
    peers: new Set(),
    nextSequence: (rows.at(-1)?.sequence ?? 0) + 1,
  };
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    const peer = [...state.peers].find(
      (candidate) => candidate.socket === origin,
    );
    if (!peer) return;
    const sequence = state.nextSequence++;
    withTransaction(() => {
      db()
        .query(
          'INSERT INTO yjs_spike_updates (doc_id, seq, "update", participant) VALUES (?, ?, ?, ?)',
        )
        .run(documentId, sequence, update, peer.participant);
      recordSpikeAttribution(
        "yjs",
        documentId,
        sequence,
        peer.participant,
        null,
      );
      if (sequence % 500 === 0) {
        const snapshot = Y.encodeStateAsUpdate(doc);
        db()
          .query("DELETE FROM yjs_spike_updates WHERE doc_id = ?")
          .run(documentId);
        db()
          .query(
            "INSERT INTO yjs_spike_updates (doc_id, seq, \"update\", participant) VALUES (?, ?, ?, 'system')",
          )
          .run(documentId, sequence, snapshot);
      }
    });
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    const frame = encoding.toUint8Array(encoder);
    for (const other of state.peers) {
      if (other !== peer && other.socket.readyState === WebSocket.OPEN) {
        other.socket.send(frame);
      }
    }
  });
  awareness.on(
    "update",
    (
      {
        added,
        updated,
        removed,
      }: {
        added: number[];
        updated: number[];
        removed: number[];
      },
      origin: unknown,
    ) => {
      const ids = [...added, ...updated, ...removed];
      if (ids.length === 0) return;
      const update = awarenessProtocol.encodeAwarenessUpdate(awareness, ids);
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 1);
      encoding.writeVarUint8Array(encoder, update);
      const frame = encoding.toUint8Array(encoder);
      for (const peer of state.peers) {
        if (
          peer.socket !== origin &&
          peer.socket.readyState === WebSocket.OPEN
        ) {
          peer.socket.send(frame);
        }
      }
    },
  );
  return state;
}

function reject(socket: Duplex, status: number): void {
  socket.end(
    `HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : "Forbidden"}\r\n` +
      "Content-Length: 0\r\nConnection: close\r\n\r\n",
  );
}

export function createYjsService(_server: Server): {
  handlesUpgrade(request: IncomingMessage, socket: Duplex): boolean;
  stop(): Promise<void>;
} {
  db().exec(UPDATE_SCHEMA);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const documents = new Map<string, DocumentState>();
  const unregisterRevocation = registerSpikeRevocationHandler(
    "yjs",
    (documentId, participant) => {
      documents.get(documentId)?.peers.forEach((peer) => {
        if (peer.participant === participant) {
          peer.socket.close(1008, "Share revoked");
        }
      });
    },
  );

  wss.on(
    "connection",
    (
      socket: WebSocket,
      _request: IncomingMessage,
      claims: { documentId: string; participant: string },
    ) => {
      const { documentId, participant } = claims;
      let state = documents.get(documentId);
      if (!state) {
        state = makeDocument(documentId);
        documents.set(documentId, state);
      }
      const peer: Peer = { socket, participant };
      state.peers.add(peer);
      socket.on("message", (message: WebSocket.RawData) => {
        try {
          const frame = bytes(message);
          const decoder = decoding.createDecoder(frame);
          const messageType = decoding.readVarUint(decoder);
          if (messageType === MESSAGE_SYNC) {
            const update = incomingSyncUpdate(frame);
            if (update && !bindUpdateClients(documentId, participant, update)) {
              socket.close(
                1008,
                "Yjs client ID belongs to another participant",
              );
              return;
            }
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, MESSAGE_SYNC);
            syncProtocol.readSyncMessage(decoder, encoder, state.doc, socket);
            if (encoding.length(encoder) > 1)
              socket.send(encoding.toUint8Array(encoder));
          } else if (messageType === 1) {
            awarenessProtocol.applyAwarenessUpdate(
              state.awareness,
              decoding.readVarUint8Array(decoder),
              socket,
            );
          }
        } catch {
          socket.close(1003, "Invalid Yjs frame");
        }
      });
      socket.on("close", () => {
        state?.peers.delete(peer);
      });
      const sync = encoding.createEncoder();
      encoding.writeVarUint(sync, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(sync, state.doc);
      socket.send(encoding.toUint8Array(sync));
      const clientIds = [...state.awareness.getStates().keys()];
      if (clientIds.length > 0) {
        const awareness = encoding.createEncoder();
        encoding.writeVarUint(awareness, 1);
        encoding.writeVarUint8Array(
          awareness,
          awarenessProtocol.encodeAwarenessUpdate(state.awareness, clientIds),
        );
        socket.send(encoding.toUint8Array(awareness));
      }
    },
  );

  return {
    handlesUpgrade(request, socket) {
      const url = new URL(request.url ?? "/", "http://gateway.local");
      if (!url.pathname.startsWith("/yjs-spike/")) return false;
      const documentId = decodeURIComponent(
        url.pathname.slice("/yjs-spike/".length),
      );
      const token = url.searchParams.get("token") ?? "";
      const claims = verifySpikeToken(token, "yjs", documentId);
      if (!claims) {
        reject(socket, 403);
        return true;
      }
      wss.handleUpgrade(
        request,
        socket,
        Buffer.alloc(0),
        (webSocket: WebSocket) => {
          wss.emit("connection", webSocket, request, claims);
        },
      );
      return true;
    },
    async stop() {
      unregisterRevocation();
      for (const state of documents.values()) {
        for (const peer of state.peers) peer.socket.terminate();
        state.awareness.destroy();
        state.doc.destroy();
      }
      for (const socket of wss.clients) socket.terminate();
      documents.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
