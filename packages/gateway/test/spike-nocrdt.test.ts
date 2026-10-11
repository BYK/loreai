import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { createGatewayApp } from "../src/app";
import { loadConfig } from "../src/config";
import { writeParticipantResult } from "./spike-participants-result";
import { grantSpikeShare, issueSpikeDocument } from "../src/spike-shared";

describe("authoritative no-CRDT spike", () => {
  const previousVariant = process.env.LORE_SPIKE_VARIANT;
  afterEach(() => {
    if (previousVariant === undefined) delete process.env.LORE_SPIKE_VARIANT;
    else process.env.LORE_SPIKE_VARIANT = previousVariant;
  });

  it("stamps authors, detects forged author fields, scopes reads, and closes revoked SSE", async () => {
    process.env.LORE_SPIKE_VARIANT = "nocrdt";
    const app = createGatewayApp(loadConfig());
    const owner = issueSpikeDocument("nocrdt", "alice");
    const second = issueSpikeDocument("nocrdt", "alice");
    grantSpikeShare("nocrdt", owner.documentId, "agent");
    const agent = await fetchToken(app, owner.documentId, "agent");

    const denied = await app.fetch(
      new Request(
        `http://gateway.local/api/v1/spike/nocrdt/discussions/${second.documentId}/events`,
        { headers: { Authorization: `Bearer ${agent}` } },
      ),
      { peerAddress: "127.0.0.1" },
    );
    expect(denied.status).toBe(403);

    const forged = await app.fetch(
      new Request(
        `http://gateway.local/api/v1/spike/nocrdt/discussions/${owner.documentId}/replies`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${agent}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ author: "alice", text: "forged" }),
        },
      ),
      { peerAddress: "127.0.0.1" },
    );
    const reply = (await forged.json()) as {
      author: string;
      participant: string;
      clientAuthor: string;
      at: number;
    };
    expect(forged.status).toBe(201);
    expect(reply).toMatchObject({
      author: "agent",
      participant: "agent",
      clientAuthor: "alice",
    });
    expect(reply.at).toBeGreaterThan(0);

    const attribution = await app.fetch(
      new Request(
        `http://gateway.local/api/v1/spike/nocrdt/attribution/${owner.documentId}`,
        { headers: { Authorization: `Bearer ${agent}` } },
      ),
      { peerAddress: "127.0.0.1" },
    );
    expect(attribution.status).toBe(200);
    expect(await attribution.json()).toMatchObject({
      entries: [
        {
          participant: "agent",
          clientAuthor: "alice",
        },
      ],
    });
    const attributionDenied = await app.fetch(
      new Request(
        `http://gateway.local/api/v1/spike/nocrdt/attribution/${second.documentId}`,
        { headers: { Authorization: `Bearer ${agent}` } },
      ),
      { peerAddress: "127.0.0.1" },
    );
    expect(attributionDenied.status).toBe(403);

    const events = await app.fetch(
      new Request(
        `http://gateway.local/api/v1/spike/nocrdt/discussions/${owner.documentId}/events`,
        {
          headers: {
            Authorization: `Bearer ${agent}`,
            "Last-Event-ID": "0",
          },
        },
      ),
      { peerAddress: "127.0.0.1" },
    );
    if (!events.body) throw new Error("Missing SSE response body");
    const reader = events.body.getReader();
    const replay = await reader.read();
    expect(new TextDecoder().decode(replay.value)).toContain(
      '"clientAuthor":"alice"',
    );

    const ownerToken = await fetchToken(app, owner.documentId, "alice");
    const disconnected = (async () => {
      while (true) {
        const { done } = await reader.read();
        if (done) return performance.now();
      }
    })();
    const started = performance.now();
    const unshared = await app.fetch(
      new Request("http://gateway.local/api/v1/spike/nocrdt/share", {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          documentId: owner.documentId,
          participant: "agent",
        }),
      }),
      { peerAddress: "127.0.0.1" },
    );
    expect(unshared.status).toBe(200);
    let disconnectTimeout: ReturnType<typeof setTimeout> | undefined;
    const disconnectedAt = await Promise.race([
      disconnected,
      new Promise<null>((resolve) => {
        disconnectTimeout = setTimeout(() => resolve(null), 2000);
      }),
    ]);
    if (disconnectTimeout) clearTimeout(disconnectTimeout);
    if (disconnectedAt === null) {
      await reader.cancel();
      throw new Error("Agent SSE reader did not observe revocation");
    }
    const revocationMs = disconnectedAt - started;
    expect(revocationMs).toBeLessThan(1000);
    const postRevocation = await app.fetch(
      new Request(
        `http://gateway.local/api/v1/spike/nocrdt/discussions/${owner.documentId}/replies`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ text: "after-revocation" }),
        },
      ),
      { peerAddress: "127.0.0.1" },
    );
    expect(postRevocation.status).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await reader.read()).done).toBe(true);
    await writeParticipantResult("nocrdt", {
      checks: {
        serverAttestedAttribution: {
          pass: true,
          mechanism:
            "author, participant, sequence, and timestamp are server-stamped",
        },
        forgedAuthor: {
          pass: true,
          mechanism: "client author is recorded separately as clientAuthor",
        },
        readScoping: {
          pass: true,
          mechanism: "share check occurs before replay and stream subscription",
        },
        revocation: {
          pass: true,
          latencyMs: revocationMs,
          noPostRevocationEditReceived: true,
          mechanism:
            "t0 is immediately before unshare; t1 is the agent reader's SSE close event",
        },
      },
      mechanism:
        "Gateway-stamped sequence, participant, author, and at values are read through a share-checked attribution endpoint.",
    });
  });
});

async function fetchToken(
  app: ReturnType<typeof createGatewayApp>,
  documentId: string,
  participant: string,
): Promise<string> {
  const response = await app.fetch(
    new Request("http://gateway.local/api/v1/spike/nocrdt/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId, participant }),
    }),
    { peerAddress: "127.0.0.1" },
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}
