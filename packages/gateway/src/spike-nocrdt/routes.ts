import { db, withTransaction } from "@loreai/core";
import { withManagementCors } from "../management-access";
import type { GatewayContext, RouteModule } from "../routes/types";
import {
  bearerToken,
  grantSpikeShare,
  initializeSpikeAccess,
  isSpikeOwner,
  issueSpikeDocument,
  issueSpikeToken,
  registerSpikeDocument,
  registerSpikeRevocationHandler,
  recordSpikeAttribution,
  revokeSpikeShare,
  verifySpikeToken,
  type SpikeVariant,
} from "../spike-shared";

type ReplyRow = {
  sequence: number;
  participant: string;
  client_author: string | null;
  text: string;
  at: number;
};

const repliesSchema = `
  CREATE TABLE IF NOT EXISTS nocrdt_spike_replies (
    document_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    participant TEXT NOT NULL,
    client_author TEXT,
    text TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (document_id, sequence)
  );
`;

type Subscriber = {
  participant: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
};
const listeners = new Map<string, Set<Subscriber>>();

registerSpikeRevocationHandler("nocrdt", (documentId, participant) => {
  for (const subscriber of listeners.get(documentId) ?? []) {
    if (subscriber.participant === participant) {
      listeners.get(documentId)?.delete(subscriber);
      subscriber.controller.close();
    }
  }
});

function respond(
  c: GatewayContext,
  value: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  return withManagementCors(
    new Response(JSON.stringify(value), {
      status,
      headers: {
        "Content-Type": "application/json",
        ...Object.fromEntries(new Headers(headers)),
      },
    }),
    c.var.allowedManagementOrigin,
  );
}

function enabledVariant(variant: string): variant is SpikeVariant {
  return (
    process.env.LORE_SPIKE_VARIANT === variant &&
    (variant === "yjs" || variant === "automerge" || variant === "nocrdt")
  );
}

function bearerFrom(c: GatewayContext) {
  return bearerToken(c.var.request);
}

function encodeEvent(row: ReplyRow): Uint8Array {
  return new TextEncoder().encode(
    `id: ${row.sequence}\nevent: reply\ndata: ${JSON.stringify({
      sequence: row.sequence,
      participant: row.participant,
      author: row.participant,
      clientAuthor: row.client_author,
      text: row.text,
      at: row.at,
    })}\n\n`,
  );
}

function broadcast(documentId: string, row: ReplyRow): void {
  const encoded = encodeEvent(row);
  for (const subscriber of listeners.get(documentId) ?? []) {
    try {
      subscriber.controller.enqueue(encoded);
    } catch {
      listeners.get(documentId)?.delete(subscriber);
    }
  }
}

export const spikeNocrdtRoutes: RouteModule = {
  name: "comparison-spike",
  plane: "management",
  register(app, ctx) {
    app.post("/api/v1/spike/:variant/token", async (c) => {
      const variant = c.req.param("variant");
      if (!enabledVariant(variant)) return ctx.notFound(c);
      initializeSpikeAccess();
      let body: {
        participant?: unknown;
        documentId?: unknown;
        createIfMissing?: unknown;
      };
      try {
        body = (await c.req.json()) as typeof body;
      } catch {
        return respond(c, { error: "Invalid request body" }, 400);
      }
      if (typeof body.participant !== "string") {
        return respond(c, { error: "Participant required" }, 400);
      }
      try {
        let result: { documentId: string; token: string };
        if (
          typeof body.documentId !== "string" ||
          body.documentId.length === 0
        ) {
          result = issueSpikeDocument(variant, body.participant);
        } else {
          const documentId = body.documentId;
          if (variant === "automerge" && body.createIfMissing === true) {
            registerSpikeDocument(variant, documentId, body.participant);
          }
          result = {
            documentId,
            token: issueSpikeToken(variant, documentId, body.participant),
          };
        }
        return respond(c, {
          documentId: result.documentId,
          token: result.token,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Token denied";
        return respond(
          c,
          { error: message },
          message === "Document access denied" ? 403 : 400,
        );
      }
    });

    app.on(["POST", "DELETE"], "/api/v1/spike/:variant/share", async (c) => {
      const variant = c.req.param("variant");
      if (!enabledVariant(variant)) return ctx.notFound(c);
      let body: {
        participant?: unknown;
        documentId?: unknown;
        token?: unknown;
      };
      try {
        body = (await c.req.json()) as typeof body;
      } catch {
        return respond(c, { error: "Invalid request body" }, 400);
      }
      if (
        typeof body.documentId !== "string" ||
        typeof body.participant !== "string"
      ) {
        return respond(c, { error: "Document and participant required" }, 400);
      }
      const token =
        bearerFrom(c) ?? (typeof body.token === "string" ? body.token : null);
      const claims =
        token && verifySpikeToken(token, variant, body.documentId, false);
      if (
        !claims ||
        !isSpikeOwner(variant, body.documentId, claims.participant)
      ) {
        return respond(c, { error: "Document access denied" }, 403);
      }
      try {
        if (c.req.method === "POST") {
          grantSpikeShare(variant, body.documentId, body.participant);
        } else {
          revokeSpikeShare(variant, body.documentId, body.participant);
        }
      } catch {
        return respond(c, { error: "Invalid participant" }, 400);
      }
      return respond(c, { ok: true });
    });

    app.get("/api/v1/spike/:variant/attribution/:documentId", async (c) => {
      const variant = c.req.param("variant");
      if (!enabledVariant(variant)) return ctx.notFound(c);
      const documentId = c.req.param("documentId");
      const token = bearerFrom(c) ?? c.req.query("token");
      const claims =
        token && verifySpikeToken(token, variant, documentId, true);
      if (!claims) return respond(c, { error: "Document access denied" }, 403);
      const entries =
        variant === "yjs"
          ? db()
              .query(
                "SELECT client_id AS clientId, participant FROM yjs_spike_clients WHERE doc_id = ? ORDER BY client_id",
              )
              .all(documentId)
          : variant === "automerge"
            ? db()
                .query(
                  "SELECT change_hash AS changeHash, actor, participant, at FROM automerge_spike_attribution WHERE document_id = ? ORDER BY at, change_hash",
                )
                .all(documentId)
            : db()
                .query(
                  "SELECT sequence, participant, client_author AS clientAuthor FROM comparison_spike_attribution WHERE variant = ? AND document_id = ? ORDER BY sequence",
                )
                .all(variant, documentId);
      return respond(c, { entries });
    });

    app.post(
      "/api/v1/spike/nocrdt/discussions/:documentId/replies",
      async (c) => {
        if (!enabledVariant("nocrdt")) return ctx.notFound(c);
        db().exec(repliesSchema);
        const documentId = c.req.param("documentId");
        let body: { text?: unknown; author?: unknown; token?: unknown };
        try {
          body = (await c.req.json()) as typeof body;
        } catch {
          return respond(c, { error: "Invalid request body" }, 400);
        }
        const token =
          bearerFrom(c) ?? (typeof body.token === "string" ? body.token : null);
        const claims =
          token && verifySpikeToken(token, "nocrdt", documentId, true);
        if (!claims)
          return respond(c, { error: "Document access denied" }, 403);
        if (
          typeof body.text !== "string" ||
          body.text.length === 0 ||
          body.text.length > 1000
        ) {
          return respond(c, { error: "Invalid reply text" }, 400);
        }
        const clientAuthor =
          typeof body.author === "string" ? body.author : null;
        let row: ReplyRow | undefined;
        try {
          withTransaction(() => {
            const last = db()
              .query(
                "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM nocrdt_spike_replies WHERE document_id = ?",
              )
              .get(documentId) as { sequence: number } | undefined;
            row = {
              sequence: (last?.sequence ?? 0) + 1,
              participant: claims.participant,
              client_author: clientAuthor,
              text: body.text as string,
              at: Date.now(),
            };
            const saved = row;
            db()
              .query(
                "INSERT INTO nocrdt_spike_replies (document_id, sequence, participant, client_author, text, at) VALUES (?, ?, ?, ?, ?, ?)",
              )
              .run(
                documentId,
                saved.sequence,
                saved.participant,
                saved.client_author,
                saved.text,
                saved.at,
              );
            recordSpikeAttribution(
              "nocrdt",
              documentId,
              saved.sequence,
              saved.participant,
              saved.client_author,
            );
          });
        } catch {
          return respond(c, { error: "Reply sequence conflict" }, 409);
        }
        if (!row) return respond(c, { error: "Unable to save reply" }, 500);
        broadcast(documentId, row);
        return respond(
          c,
          {
            sequence: row.sequence,
            author: claims.participant,
            participant: claims.participant,
            clientAuthor,
            text: body.text,
            at: row.at,
          },
          201,
        );
      },
    );

    app.get("/api/v1/spike/nocrdt/discussions/:documentId/events", (c) => {
      if (!enabledVariant("nocrdt")) return ctx.notFound(c);
      db().exec(repliesSchema);
      const documentId = c.req.param("documentId");
      const token = bearerFrom(c) ?? c.req.query("token") ?? null;
      const claims = token
        ? verifySpikeToken(token, "nocrdt", documentId, true)
        : undefined;
      if (!claims) {
        return respond(c, { error: "Document access denied" }, 403);
      }
      const lastId = Number(
        c.req.header("Last-Event-ID") ?? c.req.query("lastEventId") ?? "0",
      );
      if (!Number.isSafeInteger(lastId) || lastId < 0) {
        return respond(c, { error: "Invalid Last-Event-ID" }, 400);
      }
      const previous = db()
        .query(
          "SELECT sequence, participant, client_author, text, at FROM nocrdt_spike_replies WHERE document_id = ? AND sequence > ? ORDER BY sequence",
        )
        .all(documentId, lastId) as ReplyRow[];
      const encoder = new TextEncoder();
      let subscriber: Subscriber | undefined;
      const close = () => {
        if (!subscriber) return;
        listeners.get(documentId)?.delete(subscriber);
        if (listeners.get(documentId)?.size === 0) {
          listeners.delete(documentId);
        }
      };
      const stream = new ReadableStream<Uint8Array>({
        start(currentController) {
          subscriber = {
            participant: claims.participant,
            controller: currentController,
          };
          const current = listeners.get(documentId) ?? new Set();
          current.add(subscriber);
          listeners.set(documentId, current);
          for (const row of previous)
            currentController.enqueue(encodeEvent(row));
          c.var.request.signal.addEventListener("abort", close, {
            once: true,
          });
          currentController.enqueue(encoder.encode(": connected\n\n"));
        },
        cancel: close,
      });
      return withManagementCors(
        new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
          },
        }),
        c.var.allowedManagementOrigin,
      );
    });
  },
};
