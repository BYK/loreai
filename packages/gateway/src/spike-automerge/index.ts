import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import * as Automerge from "@automerge/automerge";
import {
  Repo,
  type DocumentId,
  type PeerId,
  type SessionId,
  type StorageAdapterInterface,
} from "@automerge/automerge-repo";
import { cbor } from "@automerge/automerge-repo/slim";
import { NodeWSServerAdapter } from "@automerge/automerge-repo-network-websocket";
import * as WebSocket from "ws";
import { db, withTransaction } from "@loreai/core";
import {
  hasSpikeShare,
  registerSpikeRevocationHandler,
  verifySpikeToken,
  type SpikeClaims,
} from "../spike-shared";

const STORAGE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS automerge_spike_chunks (
    key TEXT PRIMARY KEY,
    key_path TEXT NOT NULL,
    data BLOB NOT NULL
  );
  CREATE TABLE IF NOT EXISTS automerge_spike_actors (
    document_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    participant TEXT NOT NULL,
    PRIMARY KEY (document_id, actor)
  );
  CREATE TABLE IF NOT EXISTS automerge_spike_attribution (
    document_id TEXT NOT NULL,
    change_hash TEXT NOT NULL,
    actor TEXT NOT NULL,
    participant TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (document_id, change_hash)
  );
`;

const SERVER_PEER_ID = "lore-spike-server" as PeerId;

function initializeStorageSchema(): void {
  db().exec(STORAGE_SCHEMA);
  const columns = db()
    .query("PRAGMA table_info(automerge_spike_chunks)")
    .all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "key_path")) {
    db().exec(
      "ALTER TABLE automerge_spike_chunks ADD COLUMN key_path TEXT NOT NULL DEFAULT ''",
    );
    const rows = db()
      .query("SELECT key FROM automerge_spike_chunks WHERE key_path = ''")
      .all() as Array<{ key: string }>;
    const update = db().query(
      "UPDATE automerge_spike_chunks SET key_path = ? WHERE key = ?",
    );
    for (const row of rows) {
      update.run((JSON.parse(row.key) as string[]).join("\u0001"), row.key);
    }
  }
  db().exec(
    "CREATE INDEX IF NOT EXISTS idx_automerge_spike_chunks_key_path ON automerge_spike_chunks (key_path)",
  );
}

function keyPath(key: string[]): string {
  return key.join("\u0001");
}

function prefixQuery(prefix: string[]): {
  sql: string;
  values: [string, string, string];
} {
  const path = keyPath(prefix);
  return {
    sql: "key_path = ? OR (key_path >= ? AND key_path < ?)",
    values: [path, `${path}\u0001`, `${path}\u0002`],
  };
}

export class SqliteStorageAdapter implements StorageAdapterInterface {
  constructor() {
    initializeStorageSchema();
  }

  async load(key: string[]): Promise<Uint8Array | undefined> {
    const row = db()
      .query("SELECT data FROM automerge_spike_chunks WHERE key = ?")
      .get(JSON.stringify(key)) as { data: Uint8Array } | undefined;
    return row ? new Uint8Array(row.data) : undefined;
  }

  async save(key: string[], data: Uint8Array): Promise<void> {
    db()
      .query(
        "INSERT INTO automerge_spike_chunks (key, key_path, data) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET key_path = excluded.key_path, data = excluded.data",
      )
      .run(JSON.stringify(key), keyPath(key), data);
  }

  async remove(key: string[]): Promise<void> {
    db()
      .query("DELETE FROM automerge_spike_chunks WHERE key = ?")
      .run(JSON.stringify(key));
  }

  async loadRange(
    prefix: string[],
  ): Promise<Array<{ key: string[]; data: Uint8Array | undefined }>> {
    const range = prefixQuery(prefix);
    const rows = db()
      .query(`SELECT key, data FROM automerge_spike_chunks WHERE ${range.sql}`)
      .all(...range.values) as Array<{ key: string; data: Uint8Array }>;
    return rows.map((row) => ({
      key: JSON.parse(row.key) as string[],
      data: new Uint8Array(row.data),
    }));
  }

  async removeRange(prefix: string[]): Promise<void> {
    const range = prefixQuery(prefix);
    db()
      .query(`DELETE FROM automerge_spike_chunks WHERE ${range.sql}`)
      .run(...range.values);
  }
}

function bindChanges(
  documentId: string,
  senderId: string,
  participant: string,
  message: Parameters<typeof Automerge.decodeSyncMessage>[0],
  trackedDocuments: Map<string, Automerge.Doc<Record<string, unknown>>>,
  syncStates: Map<
    string,
    Map<string, ReturnType<typeof Automerge.initSyncState>>
  >,
): boolean {
  const decoded = Automerge.decodeSyncMessage(message);
  const currentDocument =
    trackedDocuments.get(documentId) ??
    Automerge.init<Record<string, unknown>>();
  const documentSyncStates =
    syncStates.get(documentId) ??
    new Map<string, ReturnType<typeof Automerge.initSyncState>>();
  const currentSyncState =
    documentSyncStates.get(senderId) ?? Automerge.initSyncState();
  const [nextDocument, nextSyncState] = Automerge.receiveSyncMessage(
    Automerge.clone(currentDocument),
    currentSyncState,
    message,
  );
  const changes = Automerge.getChanges(currentDocument, nextDocument).map(
    (change) => Automerge.decodeChange(change),
  );
  if (decoded.changes.length === 0 && changes.length === 0) {
    trackedDocuments.set(documentId, nextDocument);
    documentSyncStates.set(senderId, nextSyncState);
    syncStates.set(documentId, documentSyncStates);
    return true;
  }
  const connection = db();
  let authorized = true;
  withTransaction(() => {
    for (const change of changes) {
      const bound = connection
        .query(
          "SELECT participant FROM automerge_spike_actors WHERE document_id = ? AND actor = ?",
        )
        .get(documentId, change.actor) as { participant: string } | undefined;
      if (bound && bound.participant !== participant) {
        authorized = false;
        return;
      }
    }
    for (const change of changes) {
      connection
        .query(
          "INSERT OR IGNORE INTO automerge_spike_actors (document_id, actor, participant) VALUES (?, ?, ?)",
        )
        .run(documentId, change.actor, participant);
      connection
        .query(
          "INSERT OR IGNORE INTO automerge_spike_attribution (document_id, change_hash, actor, participant, at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(documentId, change.hash, change.actor, participant, Date.now());
      const bound = connection
        .query(
          "SELECT participant FROM automerge_spike_actors WHERE document_id = ? AND actor = ?",
        )
        .get(documentId, change.actor) as { participant: string } | undefined;
      if (!bound || bound.participant !== participant) {
        authorized = false;
        return;
      }
    }
  });
  if (authorized) {
    trackedDocuments.set(documentId, nextDocument);
    documentSyncStates.set(senderId, nextSyncState);
    syncStates.set(documentId, documentSyncStates);
  }
  return authorized;
}

function reject(socket: Duplex): void {
  socket.end(
    "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
  );
}

export function createAutomergeService(_server: Server): {
  handlesUpgrade(request: IncomingMessage, socket: Duplex): boolean;
  stop(): Promise<void>;
} {
  initializeStorageSchema();
  const wss = new WebSocket.WebSocketServer({
    noServer: true,
    maxPayload: 2 * 1024 * 1024,
  });
  const participantBySocket = new WeakMap<WebSocket.WebSocket, string>();
  const claimsBySocket = new WeakMap<WebSocket.WebSocket, SpikeClaims>();
  const peerBySocket = new WeakMap<WebSocket.WebSocket, string>();
  const peerParticipants = new Map<string, string>();
  const peerSockets = new Map<string, WebSocket.WebSocket>();
  const trackedDocuments = new Map<
    string,
    Automerge.Doc<Record<string, unknown>>
  >();
  const syncStates = new Map<
    string,
    Map<string, ReturnType<typeof Automerge.initSyncState>>
  >();
  const sockets = new Set<WebSocket.WebSocket>();
  type AdapterSocket = Parameters<NodeWSServerAdapter["receiveMessage"]>[1];
  wss.on("connection", (socket: WebSocket.WebSocket) => {
    sockets.add(socket);
    socket.once("message", (data: WebSocket.RawData) => {
      try {
        const value = cbor.decode(new Uint8Array(data as ArrayBuffer)) as {
          type?: string;
          senderId?: string;
        };
        const participant = participantBySocket.get(socket);
        if (
          value.type !== "join" ||
          !participant ||
          typeof value.senderId !== "string" ||
          peerSockets.has(value.senderId)
        ) {
          socket.close(1008, "Invalid or already-connected peer identity");
          return;
        }
        peerParticipants.set(value.senderId, participant);
        peerBySocket.set(socket, value.senderId);
        peerSockets.set(value.senderId, socket);
      } catch {
        socket.close(1003, "Invalid Automerge message");
      }
    });
    socket.on("close", () => {
      sockets.delete(socket);
      const peerId = peerBySocket.get(socket);
      if (peerId && peerSockets.get(peerId) === socket) {
        peerSockets.delete(peerId);
        peerParticipants.delete(peerId);
        for (const documentSyncStates of syncStates.values()) {
          documentSyncStates.delete(peerId);
        }
      }
    });
  });
  class AuthorizedWSServerAdapter extends NodeWSServerAdapter {
    override send(message: Parameters<NodeWSServerAdapter["send"]>[0]): void {
      const value = message as {
        documentId?: string;
        senderId?: string;
        targetId?: string;
        type?: string;
      };
      const participant = peerParticipants.get(value.targetId ?? "");
      const isServerRevocationEvent =
        value.type === "ephemeral" && value.senderId === SERVER_PEER_ID;
      if (
        value.documentId &&
        (!participant ||
          (!hasSpikeShare("automerge", value.documentId, participant) &&
            !isServerRevocationEvent))
      ) {
        return;
      }
      super.send(message);
    }

    override receiveMessage(
      messageBytes: Uint8Array,
      socket: AdapterSocket,
    ): void {
      try {
        const message = cbor.decode(messageBytes) as {
          documentId?: string;
          senderId?: string;
          type?: string;
          data?: Parameters<typeof Automerge.decodeSyncMessage>[0];
        };
        const participant = peerParticipants.get(message.senderId ?? "");
        if (
          message.documentId &&
          (!participant ||
            !hasSpikeShare("automerge", message.documentId, participant))
        ) {
          socket.close(1008, "Document access denied");
          return;
        }
        if (
          message.type === "sync" &&
          message.documentId &&
          message.data &&
          message.senderId &&
          participant
        ) {
          const accepted = bindChanges(
            message.documentId,
            message.senderId,
            participant,
            message.data,
            trackedDocuments,
            syncStates,
          );
          if (!accepted) {
            socket.close(
              1008,
              "Automerge actor belongs to another participant",
            );
            return;
          }
        }
      } catch {
        socket.close(1003, "Invalid Automerge message");
        return;
      }
      super.receiveMessage(messageBytes, socket);
    }
  }
  const adapter = new AuthorizedWSServerAdapter(wss);
  const repo = new Repo({
    network: [adapter],
    storage: new SqliteStorageAdapter(),
    peerId: SERVER_PEER_ID,
    shareConfig: {
      announce: async () => false,
      access: async (peerId, documentId) => {
        const participant = peerParticipants.get(peerId);
        return Boolean(
          participant &&
          documentId &&
          hasSpikeShare("automerge", documentId, participant),
        );
      },
    },
  });
  const unregisterRevocation = registerSpikeRevocationHandler(
    "automerge",
    (documentId, participant) => {
      for (const [peerId, peerParticipant] of peerParticipants) {
        if (peerParticipant === participant) {
          syncStates.get(documentId)?.delete(peerId);
          const revocationMessage = Object.assign(
            {
              type: "ephemeral",
              senderId: SERVER_PEER_ID,
              targetId: peerId as PeerId,
              documentId: documentId as DocumentId,
              data: new Uint8Array(cbor.encode({ type: "share-revoked" })),
            },
            { count: 1, sessionId: randomUUID() as SessionId },
          );
          adapter.send(revocationMessage);
        }
      }
      for (const socket of sockets) {
        const claims = claimsBySocket.get(socket);
        if (
          participantBySocket.get(socket) === participant &&
          claims?.documentId === documentId
        ) {
          socket.close(1008, "Share revoked");
        }
      }
    },
  );

  return {
    handlesUpgrade(request, socket) {
      const url = new URL(request.url ?? "/", "http://gateway.local");
      if (url.pathname !== "/automerge-spike") return false;
      const token = url.searchParams.get("token") ?? "";
      const claims = verifySpikeToken(token, "automerge", undefined, false);
      if (
        !claims ||
        !hasSpikeShare("automerge", claims.documentId, claims.participant)
      ) {
        reject(socket);
        return true;
      }
      wss.handleUpgrade(
        request,
        socket,
        Buffer.alloc(0),
        (webSocket: WebSocket.WebSocket) => {
          participantBySocket.set(webSocket, claims.participant);
          claimsBySocket.set(webSocket, claims);
          wss.emit("connection", webSocket, request);
        },
      );
      return true;
    },
    async stop() {
      unregisterRevocation();
      try {
        await repo.shutdown();
      } finally {
        for (const socket of sockets) socket.close();
        await new Promise<void>((resolve) => wss.close(() => resolve()));
      }
    },
  };
}
