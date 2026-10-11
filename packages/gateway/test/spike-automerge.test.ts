import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import * as Automerge from "@automerge/automerge";
import { Repo, type PeerId } from "@automerge/automerge-repo";
import { cbor } from "@automerge/automerge-repo/slim";
import { WebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket";
import { db } from "@loreai/core";
import { createGatewayApp } from "../src/app";
import { loadConfig } from "../src/config";
import {
  grantSpikeShare,
  issueSpikeToken,
  registerSpikeDocument,
  verifySpikeToken,
} from "../src/spike-shared";
import {
  createAutomergeService,
  SqliteStorageAdapter,
} from "../src/spike-automerge";
import { writeParticipantResult } from "./spike-participants-result";

describe("Automerge comparison service", () => {
  let server: Server | undefined;
  let stopService: (() => Promise<void>) | undefined;
  let repos: Repo[] = [];
  const previousVariant = process.env.LORE_SPIKE_VARIANT;

  afterEach(async () => {
    await Promise.allSettled(repos.map((repo) => repo.shutdown()));
    repos = [];
    try {
      await stopService?.();
    } finally {
      if (server?.listening) {
        server.close();
        await once(server, "close");
      }
      stopService = undefined;
      server = undefined;
      if (previousVariant === undefined) delete process.env.LORE_SPIKE_VARIANT;
      else process.env.LORE_SPIKE_VARIANT = previousVariant;
    }
  });

  it("authenticates peer IDs, denies unshared docs, and closes a revoked peer", async () => {
    server = createServer();
    const service = createAutomergeService(server);
    stopService = () => service.stop();
    server.on("upgrade", (request, socket) => {
      service.handlesUpgrade(request, socket);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing test port");
    const base = `http://127.0.0.1:${address.port}`;
    const aliceRepo = new Repo({ peerId: "alice" as PeerId });
    repos.push(aliceRepo);
    type TestDocument = {
      replies: Array<{ author: string; text: string; at: number }>;
    };
    const ownerHandle = aliceRepo.create<TestDocument>({ replies: [] });
    const unsharedHandle = aliceRepo.create<TestDocument>({ replies: [] });
    registerSpikeDocument("automerge", ownerHandle.documentId, "alice");
    registerSpikeDocument("automerge", unsharedHandle.documentId, "alice");
    const ownerToken = issueSpikeToken(
      "automerge",
      ownerHandle.documentId,
      "alice",
    );
    const ownerAdapter = connectRepo(aliceRepo, base, ownerToken);
    await ownerAdapter.whenReady();
    const aliceBefore = ownerHandle.doc();
    ownerHandle.change((doc) => {
      doc.replies.push({
        author: "alice",
        text: "alice#seed",
        at: Date.now(),
      });
    });
    const aliceChange = Automerge.getChanges(aliceBefore, ownerHandle.doc())[0];
    if (!aliceChange) throw new Error("Alice change was not created");
    const decodedAliceChange = Automerge.decodeChange(aliceChange);

    grantSpikeShare("automerge", ownerHandle.documentId, "agent");
    const agentToken = issueSpikeToken(
      "automerge",
      ownerHandle.documentId,
      "agent",
    );
    expect(
      verifySpikeToken(agentToken, "automerge", unsharedHandle.documentId),
    ).toBeUndefined();
    expect(
      db()
        .query(
          "SELECT 1 FROM comparison_spike_shares WHERE variant = 'automerge' AND document_id = ? AND participant = 'agent'",
        )
        .get(unsharedHandle.documentId),
    ).toBeNull();

    const agentRepo = new Repo({ peerId: "agent" as PeerId });
    repos.push(agentRepo);
    const agentAdapter = connectRepo(agentRepo, base, agentToken, 0);
    await agentAdapter.whenReady();
    const remote = await agentRepo.find<TestDocument>(ownerHandle.documentId);
    await remote.whenReady();
    await eventually(() => {
      const actor = db()
        .query(
          "SELECT participant FROM automerge_spike_actors WHERE document_id = ? AND actor = ?",
        )
        .get(ownerHandle.documentId, decodedAliceChange.actor) as
        | { participant: string }
        | undefined;
      const attribution = db()
        .query(
          "SELECT participant FROM automerge_spike_attribution WHERE document_id = ? AND change_hash = ?",
        )
        .get(ownerHandle.documentId, decodedAliceChange.hash) as
        | { participant: string }
        | undefined;
      return (
        actor?.participant === "alice" &&
        attribution?.participant === "alice" &&
        remote.doc().replies.some((reply) => reply.text === "alice#seed")
      );
    });
    expect(remote.doc().replies[0]?.text).toBe("alice#seed");

    const thirdHandle = aliceRepo.create<TestDocument>({ replies: [] });
    registerSpikeDocument("automerge", thirdHandle.documentId, "alice");
    grantSpikeShare("automerge", thirdHandle.documentId, "agent");
    thirdHandle.change((doc) => {
      doc.replies.push({
        author: "alice",
        text: "d3-before-revocation",
        at: Date.now(),
      });
    });
    await eventually(() =>
      Boolean(
        db()
          .query(
            "SELECT 1 FROM automerge_spike_attribution WHERE document_id = ?",
          )
          .get(thirdHandle.documentId),
      ),
    );
    const remoteThird = await agentRepo.find<TestDocument>(
      thirdHandle.documentId,
    );
    await remoteThird.whenReady();
    await eventually(() =>
      remoteThird
        .doc()
        .replies.some((reply) => reply.text === "d3-before-revocation"),
    );
    const beforeAgentChange = remote.doc();
    remote.change((doc) => {
      doc.replies.push({
        author: "alice",
        text: "agent#forged",
        at: Date.now(),
      });
    });
    const agentChange = Automerge.getChanges(
      beforeAgentChange,
      remote.doc(),
    )[0];
    if (!agentChange) throw new Error("Agent change was not created");
    const decodedAgentChange = Automerge.decodeChange(agentChange);
    await eventually(() => {
      const row = db()
        .query(
          "SELECT participant FROM automerge_spike_attribution WHERE document_id = ? AND change_hash = ?",
        )
        .get(ownerHandle.documentId, decodedAgentChange.hash) as
        | { participant: string }
        | undefined;
      return row?.participant === "agent";
    });
    expect(remote.doc().replies).toContainEqual(
      expect.objectContaining({
        author: "alice",
        text: "agent#forged",
      }),
    );
    expect(
      db()
        .query(
          "SELECT actor, participant FROM automerge_spike_attribution WHERE document_id = ? AND change_hash = ?",
        )
        .get(ownerHandle.documentId, decodedAgentChange.hash),
    ).toEqual({ actor: decodedAgentChange.actor, participant: "agent" });
    process.env.LORE_SPIKE_VARIANT = "automerge";
    const app = createGatewayApp(loadConfig());
    const attribution = await app.fetch(
      new Request(
        `http://gateway.local/api/v1/spike/automerge/attribution/${ownerHandle.documentId}`,
        { headers: { Authorization: `Bearer ${agentToken}` } },
      ),
      { peerAddress: "127.0.0.1" },
    );
    expect(attribution.status).toBe(200);
    const attributionEntries = (await attribution.json()) as {
      entries: Array<{
        changeHash: string;
        actor: string;
        participant: string;
      }>;
    };
    expect(attributionEntries.entries).toContainEqual(
      expect.objectContaining({
        changeHash: decodedAgentChange.hash,
        actor: decodedAgentChange.actor,
        participant: "agent",
      }),
    );
    const attributionDenied = await app.fetch(
      new Request(
        `http://gateway.local/api/v1/spike/automerge/attribution/${unsharedHandle.documentId}`,
        { headers: { Authorization: `Bearer ${agentToken}` } },
      ),
      { peerAddress: "127.0.0.1" },
    );
    expect(attributionDenied.status).toBe(403);

    const impersonatorToken = issueSpikeToken(
      "automerge",
      ownerHandle.documentId,
      "agent",
    );
    const impersonatorRepo = new Repo({
      peerId: "agent-impersonator" as PeerId,
    });
    repos.push(impersonatorRepo);
    const impersonatorAdapter = connectRepo(
      impersonatorRepo,
      base,
      impersonatorToken,
      0,
    );
    await impersonatorAdapter.whenReady();
    const impersonatorHandle = await impersonatorRepo.find<TestDocument>(
      ownerHandle.documentId,
    );
    await impersonatorHandle.whenReady();
    const impersonatorSocket = impersonatorAdapter.socket;
    if (!impersonatorSocket)
      throw new Error("Missing actor-impersonation socket");
    const impersonatedBase = Automerge.clone(impersonatorHandle.doc(), {
      actor: decodedAliceChange.actor,
    });
    const impersonatedDocument = Automerge.change(impersonatedBase, (doc) => {
      doc.replies.push({
        author: "agent",
        text: "agent#actor-impersonation",
        at: Date.now(),
      });
    });
    const impersonatedChange = Automerge.getChanges(
      impersonatedBase,
      impersonatedDocument,
    )[0];
    if (!impersonatedChange)
      throw new Error("Impersonated actor change was not created");
    const impersonatedSync = Automerge.encodeSyncMessage({
      heads: Automerge.getHeads(impersonatedDocument),
      need: [],
      have: [],
      changes: [impersonatedChange],
    });
    const impersonationClosed = once(impersonatorSocket, "close");
    impersonatorSocket.send(
      cbor.encode({
        type: "sync",
        senderId: "agent-impersonator",
        targetId: "lore-spike-server",
        documentId: ownerHandle.documentId,
        data: impersonatedSync,
      }),
    );
    const [impersonationCode] = await impersonationClosed;
    expect(impersonationCode).toBe(1008);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(
      ownerHandle
        .doc()
        .replies.some((reply) => reply.text === "agent#actor-impersonation"),
    ).toBe(false);

    const thirdOwnerToken = issueSpikeToken(
      "automerge",
      thirdHandle.documentId,
      "alice",
    );
    let revocationObservedAt: number | undefined;
    const revocationEvent = new Promise<void>((resolve) => {
      const listener = ({ message }: { message: unknown }) => {
        const value =
          message instanceof Uint8Array ? cbor.decode(message) : message;
        if (
          typeof value === "object" &&
          value !== null &&
          "type" in value &&
          value.type === "share-revoked"
        ) {
          revocationObservedAt = performance.now();
          remoteThird.off("ephemeral-message", listener);
          resolve();
        }
      };
      remoteThird.on("ephemeral-message", listener);
    });
    const revokeRequest = new Request(
      "http://gateway.local/api/v1/spike/automerge/share",
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentId: thirdHandle.documentId,
          participant: "agent",
          token: thirdOwnerToken,
        }),
      },
    );
    const revocationStarted = performance.now();
    const revokeThird = await app.fetch(revokeRequest, {
      peerAddress: "127.0.0.1",
    });
    expect(revokeThird.status).toBe(200);
    let revocationTimeout: ReturnType<typeof setTimeout> | undefined;
    const observedRevocation = await Promise.race([
      revocationEvent.then(() => true),
      new Promise<boolean>((resolve) => {
        revocationTimeout = setTimeout(() => resolve(false), 2000);
      }),
    ]);
    if (revocationTimeout) clearTimeout(revocationTimeout);
    expect(observedRevocation).toBe(true);
    const multiplexedRevocationMs =
      revocationObservedAt === undefined
        ? Number.POSITIVE_INFINITY
        : revocationObservedAt - revocationStarted;
    thirdHandle.change((doc) => {
      doc.replies.push({
        author: "alice",
        text: "d3-after-revocation",
        at: Date.now(),
      });
    });
    const beforeD1Edit = ownerHandle.doc();
    ownerHandle.change((doc) => {
      doc.replies.push({
        author: "alice",
        text: "d1-after-revocation",
        at: Date.now(),
      });
    });
    const d1Edit = Automerge.getChanges(beforeD1Edit, ownerHandle.doc())[0];
    if (!d1Edit) throw new Error("Alice D1 change was not created");
    const d1EditHash = Automerge.decodeChange(d1Edit).hash;
    await eventually(() =>
      Boolean(
        db()
          .query(
            "SELECT 1 FROM automerge_spike_attribution WHERE document_id = ? AND change_hash = ?",
          )
          .get(ownerHandle.documentId, d1EditHash),
      ),
    );
    await eventually(() =>
      remote
        .doc()
        .replies.some((reply) => reply.text === "d1-after-revocation"),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(
      remoteThird
        .doc()
        .replies.some((reply) => reply.text === "d3-after-revocation"),
    ).toBe(false);

    void agentRepo
      .find<TestDocument>(unsharedHandle.documentId)
      .catch(() => undefined);
    const agentSocket = agentAdapter.socket;
    if (!agentSocket) throw new Error("Missing Automerge peer socket");
    const blocked = await Promise.race([
      once(agentSocket, "close").then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
    ]);
    expect(blocked).toBe(true);

    const revokeRepo = new Repo({ peerId: "agent-revoke" as PeerId });
    repos.push(revokeRepo);
    grantSpikeShare("automerge", ownerHandle.documentId, "agent-revoke");
    const revokeToken = issueSpikeToken(
      "automerge",
      ownerHandle.documentId,
      "agent-revoke",
    );
    const revokeAdapter = connectRepo(revokeRepo, base, revokeToken, 0);
    await revokeAdapter.whenReady();
    await (
      await revokeRepo.find<TestDocument>(ownerHandle.documentId)
    ).whenReady();
    const revokeSocket = revokeAdapter.socket;
    if (!revokeSocket) throw new Error("Missing revocation socket");
    const disconnected = once(revokeSocket, "close");
    const unshareRequest = new Request(
      "http://gateway.local/api/v1/spike/automerge/share",
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentId: ownerHandle.documentId,
          participant: "agent-revoke",
          token: ownerToken,
        }),
      },
    );
    const started = performance.now();
    const unshared = await app.fetch(unshareRequest, {
      peerAddress: "127.0.0.1",
    });
    expect(unshared.status).toBe(200);
    const [revocationCode] = await disconnected;
    const socketRevocationMs = performance.now() - started;
    expect(revocationCode).toBe(1008);
    expect(socketRevocationMs).toBeLessThan(1000);
    expect(multiplexedRevocationMs).toBeLessThan(1000);

    await writeParticipantResult("automerge", {
      checks: {
        serverAttestedAttribution: {
          pass: true,
          actor: decodedAgentChange.actor,
          changeHash: decodedAgentChange.hash,
          participant: "agent",
          mechanism:
            "the server binds each actor to the authenticated participant on first use and stamps change hashes",
        },
        forgedAuthor: {
          pass: true,
          mechanism:
            "client author is not trusted; the change hash maps to the authenticated actor participant",
        },
        readScoping: {
          pass: true,
          mechanism: "share policy denies unshared document sync",
        },
        actorImpersonation: {
          pass: true,
          closeCode: impersonationCode,
          mechanism:
            "changes using Alice's already-bound actor are rejected with WebSocket close code 1008",
        },
        multiplexedRevocation: {
          pass:
            remote
              .doc()
              .replies.some((reply) => reply.text === "d1-after-revocation") &&
            !remoteThird
              .doc()
              .replies.some((reply) => reply.text === "d3-after-revocation"),
          d1ContinuedSyncing: true,
          d3EditBlocked: true,
          latencyMs: multiplexedRevocationMs,
          syncStateCleanup:
            "The external per-peer tracking state is removed and outbound content is filtered; Repo exposes no public per-peer, per-document sync-state removal API",
        },
        revocation: {
          pass: true,
          latencyMs: multiplexedRevocationMs,
          mechanism:
            "t0 is immediately before unshare; t1 is the agent DocHandle's server-initiated share-revoked event",
        },
        singleDocumentSocketRevocation: {
          pass: true,
          latencyMs: socketRevocationMs,
          mechanism:
            "the server closes the socket when its token document is revoked",
        },
      },
      mechanism:
        "Change hashes are attributed to an authenticated participant through a first-seen actor binding per document. Changes are unsigned, so this is first-seen attribution rather than cryptographic authorship.",
    });
  });
});

it("uses an indexed key prefix without matching a sibling prefix", async () => {
  const storage = new SqliteStorageAdapter();
  const prefix = `storage-test-${randomUUID()}`;
  await storage.save([prefix, "a", "b"], Uint8Array.of(1));
  await storage.save([prefix, "a", "b", "child"], Uint8Array.of(2));
  await storage.save([prefix, "a", "bc"], Uint8Array.of(3));
  const matching = await storage.loadRange([prefix, "a", "b"]);
  expect(matching.map(({ key }) => key)).toEqual([
    [prefix, "a", "b"],
    [prefix, "a", "b", "child"],
  ]);
  await storage.removeRange([prefix, "a", "b"]);
  expect(await storage.load([prefix, "a", "bc"])).toEqual(Uint8Array.of(3));
  await storage.removeRange([prefix]);
});

function connectRepo(
  repo: Repo,
  base: string,
  token: string,
  retryInterval = 0,
) {
  const adapter = new WebSocketClientAdapter(
    `${base.replace(/^http/, "ws")}/automerge-spike?token=${encodeURIComponent(token)}`,
    retryInterval,
  );
  repo.networkSubsystem.addNetworkAdapter(adapter);
  return adapter;
}

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for Automerge persistence");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
