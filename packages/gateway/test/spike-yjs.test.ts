import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import { db } from "@loreai/core";
import { createGatewayApp } from "../src/app";
import { loadConfig } from "../src/config";
import {
  grantSpikeShare,
  issueSpikeDocument,
  issueSpikeToken,
} from "../src/spike-shared";
import { createYjsService } from "../src/spike-yjs";
import { writeParticipantResult } from "./spike-participants-result";

describe("Yjs comparison service", () => {
  let server: Server | undefined;
  let stopService: (() => Promise<void>) | undefined;
  const sockets: WebSocket[] = [];
  const previousVariant = process.env.LORE_SPIKE_VARIANT;

  afterEach(async () => {
    for (const socket of sockets) socket.terminate();
    sockets.length = 0;
    await stopService?.();
    if (server?.listening) {
      server.close();
      await once(server, "close");
    }
    stopService = undefined;
    server = undefined;
    if (previousVariant === undefined) delete process.env.LORE_SPIKE_VARIANT;
    else process.env.LORE_SPIKE_VARIANT = previousVariant;
  });

  it("attests update participants, rejects D2, and closes a revoked peer", async () => {
    server = createServer();
    const service = createYjsService(server);
    stopService = () => service.stop();
    server.on("upgrade", (request, socket) => {
      service.handlesUpgrade(request, socket);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing test port");
    const owner = issueSpikeDocument("yjs", "alice");
    const d2 = issueSpikeDocument("yjs", "alice");
    grantSpikeShare("yjs", owner.documentId, "agent");
    const ownerToken = issueSpikeToken("yjs", owner.documentId, "alice");
    const agentToken = issueSpikeToken("yjs", owner.documentId, "agent");
    const ownerSocket = new WebSocket(
      `ws://127.0.0.1:${address.port}/yjs-spike/${owner.documentId}?token=${encodeURIComponent(ownerToken)}`,
    );
    sockets.push(ownerSocket);
    ownerSocket.on("error", () => {});
    await once(ownerSocket, "open");
    const ownerDoc = new Y.Doc();
    ownerDoc.clientID = 12345;
    ownerDoc
      .getArray("replies")
      .push([{ author: "alice", text: "alice#seed", at: Date.now() }]);
    sendUpdate(ownerSocket, ownerDoc);
    await eventually(() => {
      const row = db()
        .query(
          "SELECT participant FROM yjs_spike_clients WHERE doc_id = ? AND client_id = ?",
        )
        .get(owner.documentId, ownerDoc.clientID) as
        | { participant: string }
        | undefined;
      return row?.participant === "alice";
    });
    const wsUrl = `ws://127.0.0.1:${address.port}/yjs-spike/${owner.documentId}?token=${encodeURIComponent(agentToken)}`;
    const socket = new WebSocket(wsUrl);
    sockets.push(socket);
    socket.on("error", () => {});
    let agentFrameCount = 0;
    socket.on("message", () => {
      agentFrameCount += 1;
    });
    await once(socket, "open");

    const denied = new WebSocket(
      `ws://127.0.0.1:${address.port}/yjs-spike/${d2.documentId}?token=${encodeURIComponent(agentToken)}`,
    );
    sockets.push(denied);
    denied.on("error", () => {});
    const deniedStatus = await new Promise<number>((resolve) => {
      denied.once("unexpected-response", (_request, response) => {
        resolve(response.statusCode ?? 0);
      });
      denied.once("open", () => resolve(101));
    });
    expect(deniedStatus).toBe(403);
    denied.terminate();

    const forgedDoc = new Y.Doc();
    forgedDoc.clientID = 54321;
    forgedDoc
      .getArray("replies")
      .push([{ author: "alice", text: "agent#forged", at: Date.now() }]);
    sendUpdate(socket, forgedDoc);
    await eventually(() => {
      const row = db()
        .query(
          "SELECT participant FROM yjs_spike_clients WHERE doc_id = ? AND client_id = ?",
        )
        .get(owner.documentId, forgedDoc.clientID) as
        | { participant: string }
        | undefined;
      return row?.participant === "agent";
    });
    const stored = db()
      .query(
        'SELECT "update" AS update_blob, participant FROM yjs_spike_updates WHERE doc_id = ? AND participant = ? ORDER BY seq DESC LIMIT 1',
      )
      .get(owner.documentId, "agent") as {
      update_blob: Uint8Array;
      participant: string;
    };
    const received = new Y.Doc();
    Y.applyUpdate(received, new Uint8Array(stored.update_blob));
    expect(stored.participant).toBe("agent");
    expect(received.getArray("replies").toArray()).toEqual([
      { author: "alice", text: "agent#forged", at: expect.any(Number) },
    ]);
    process.env.LORE_SPIKE_VARIANT = "yjs";
    const app = createGatewayApp(loadConfig());
    const attribution = await app.fetch(
      new Request(
        `http://gateway.local/api/v1/spike/yjs/attribution/${owner.documentId}`,
        { headers: { Authorization: `Bearer ${agentToken}` } },
      ),
      { peerAddress: "127.0.0.1" },
    );
    expect(attribution.status).toBe(200);
    const attributionEntries = (await attribution.json()) as {
      entries: Array<{ clientId: number; participant: string }>;
    };
    expect(attributionEntries.entries).toContainEqual({
      clientId: ownerDoc.clientID,
      participant: "alice",
    });
    expect(attributionEntries.entries).toContainEqual({
      clientId: forgedDoc.clientID,
      participant: "agent",
    });

    const impersonationSocket = new WebSocket(wsUrl);
    sockets.push(impersonationSocket);
    impersonationSocket.on("error", () => {});
    await once(impersonationSocket, "open");
    const impersonatedDoc = new Y.Doc();
    impersonatedDoc.clientID = ownerDoc.clientID;
    impersonatedDoc
      .getArray("replies")
      .push([{ author: "agent", text: "agent#actor-spoof", at: Date.now() }]);
    const persistedBeforeImpersonation = db()
      .query("SELECT COUNT(*) AS count FROM yjs_spike_updates WHERE doc_id = ?")
      .get(owner.documentId) as { count: number };
    const impersonationClosed = once(impersonationSocket, "close");
    sendUpdate(impersonationSocket, impersonatedDoc);
    const [closeCode] = await impersonationClosed;
    expect(closeCode).toBe(1008);
    const persistedAfterImpersonation = db()
      .query("SELECT COUNT(*) AS count FROM yjs_spike_updates WHERE doc_id = ?")
      .get(owner.documentId) as { count: number };
    expect(persistedAfterImpersonation.count).toBe(
      persistedBeforeImpersonation.count,
    );

    const disconnected = once(socket, "close");
    const unshareRequest = new Request(
      "http://gateway.local/api/v1/spike/yjs/share",
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentId: owner.documentId,
          participant: "agent",
          token: issueSpikeToken("yjs", owner.documentId, "alice"),
        }),
      },
    );
    const started = performance.now();
    const unshared = await app.fetch(unshareRequest, {
      peerAddress: "127.0.0.1",
    });
    expect(unshared.status).toBe(200);
    await disconnected;
    const revocationMs = performance.now() - started;
    expect(revocationMs).toBeLessThan(1000);
    const framesAtRevocation = agentFrameCount;
    ownerDoc
      .getArray("replies")
      .push([{ author: "alice", text: "after-revocation", at: Date.now() }]);
    sendUpdate(ownerSocket, ownerDoc);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(agentFrameCount).toBe(framesAtRevocation);
    await writeParticipantResult("yjs", {
      checks: {
        serverAttestedAttribution: {
          pass: true,
          clientId: forgedDoc.clientID,
          participant: "agent",
          mechanism:
            "Yjs client IDs are first-seen-bound to the authenticated participant and exposed through the share-checked attribution route",
        },
        forgedAuthor: {
          pass: true,
          mechanism:
            "the client author remains data, but stored participant metadata exposes the mismatch",
        },
        readScoping: {
          pass: true,
          mechanism: "share-checked token is required on WebSocket upgrade",
        },
        actorImpersonation: {
          pass: true,
          closeCode,
          mechanism:
            "an update containing Alice's already-bound client ID is rejected with close code 1008",
        },
        revocation: {
          pass: true,
          latencyMs: revocationMs,
          mechanism:
            "t0 is immediately before unshare; t1 is the agent WebSocket close event",
          noPostRevocationEditReceived: true,
        },
      },
      mechanism:
        "First-seen Yjs clientID bindings attribute edits to authenticated participants. Updates are unsigned, so this is first-seen attribution rather than cryptographic authorship.",
    });
    ownerSocket.close();
    ownerDoc.destroy();
    impersonatedDoc.destroy();
    socket.terminate();
    impersonationSocket.terminate();
    forgedDoc.destroy();
    received.destroy();
  });
});

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for persisted Yjs update");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function sendUpdate(socket: WebSocket, doc: Y.Doc): void {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0);
  syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(doc));
  socket.send(encoding.toUint8Array(encoder));
}
