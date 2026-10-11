import { db, dbPath } from "@loreai/core";
import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
} from "express";
import type { Server } from "node:http";
import { EventEmitter } from "node:events";
import { dirname, resolve } from "node:path";
import nconf from "nconf";
import { Server as SocketIoServer } from "socket.io";
import * as winston from "winston";
import { isLoopbackAddress } from "../management-access";
import {
  FLUID_SPIKE_SCOPES,
  FLUID_SPIKE_TENANT_ID,
  createFluidSpikeSecret,
  signFluidSpikeToken,
  verifyFluidSpikeToken,
} from "./auth";
import {
  grantFluidShare,
  fluidAttribution,
  fluidSpikeTokenSecret,
  hasFluidShare,
  initializeFluidTables,
  revokeFluidShare,
  recordFluidClient,
  SQLiteDbFactory,
  withFluidParticipant,
} from "./sqlite";
import { sqliteFs } from "./sqlite-fs";

const {
  MongoManager,
  MongoDatabaseManager,
  MongoDocumentRepository,
  DefaultMetricClient,
} =
  require("@fluidframework/server-services-core") as typeof import("@fluidframework/server-services-core");
const { DocumentStorage } =
  require("@fluidframework/server-services-shared") as typeof import("@fluidframework/server-services-shared");
const { LocalOrdererManager } =
  require("@fluidframework/server-local-server") as typeof import("@fluidframework/server-local-server");
const { TypedEventEmitter } =
  require("@fluidframework/common-utils") as typeof import("@fluidframework/common-utils");
const { configureWebSocketServices } =
  require("@fluidframework/server-lambdas") as typeof import("@fluidframework/server-lambdas");
const { TestClientManager } =
  require("@fluidframework/server-test-utils") as typeof import("@fluidframework/server-test-utils");
const {
  TenantManager,
  TinyliciousTenant,
} = require("tinylicious/dist/services/tenantManager");
const {
  PubSubPublisher,
} = require("tinylicious/dist/services/pubSubPublisher");
const {
  StorageNameAllocator,
} = require("tinylicious/dist/services/storageNameAllocator");
const { create: createApp } = require("./vendor/app.js") as {
  create: (
    ...args: unknown[]
  ) => (request: ExpressRequest, response: ExpressResponse) => void;
};
const INTERNAL_HEADER = "x-lore-fluid-internal";
const { Historian, BasicRestWrapper, GitManager, NetworkError } =
  require("@fluidframework/server-services-client") as typeof import("@fluidframework/server-services-client");

interface SocketLike {
  id: string;
  on(event: string, listener: (...args: unknown[]) => void): void;
  join(room: string): Promise<void> | void;
  emit(event: string, ...args: unknown[]): void;
  to(room: string): { emit(event: string, ...args: unknown[]): void };
  nsp: { to(room: string): { emit(event: string, ...args: unknown[]): void } };
  disconnect(close?: boolean): void;
}

function internalHistorian(historianUrl: string, internalSecret: string) {
  return new Historian(
    historianUrl,
    false,
    false,
    new BasicRestWrapper(historianUrl, {}, undefined, undefined, {
      [INTERNAL_HEADER]: internalSecret,
    }),
  );
}

class SpikeTenantManager extends TenantManager {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
    private readonly internalSecret: string,
  ) {
    super(baseUrl);
  }

  /** Server-side Historian calls (scribe summaries, document create) carry the internal header. */
  async getTenant(tenantId: string): Promise<unknown> {
    const historianUrl = `${this.baseUrl}/repos/${encodeURIComponent(tenantId)}`;
    const tenant = new TinyliciousTenant(this.baseUrl, historianUrl);
    tenant.manager = new GitManager(
      internalHistorian(historianUrl, this.internalSecret),
    );
    return tenant;
  }

  async verifyToken(tenantId: string, token: string): Promise<void> {
    let claims: ReturnType<typeof verifyFluidSpikeToken>;
    try {
      claims = verifyFluidSpikeToken(token, this.secret, { tenantId });
    } catch {
      throw new NetworkError(403, "Invalid Fluid spike token");
    }
    if (
      claims.documentId &&
      !hasFluidShare(claims.documentId, claims.user.id)
    ) {
      throw new NetworkError(403, "Fluid spike document access denied");
    }
  }

  async getKey(tenantId: string): Promise<string> {
    if (tenantId !== FLUID_SPIKE_TENANT_ID) {
      throw new Error("Unknown Fluid spike tenant");
    }
    return this.secret;
  }
}

class SocketIoSocket {
  constructor(
    private readonly socket: SocketLike,
    private readonly onDocumentConnect: (message: unknown) => void,
    private readonly onConnectionSuccess: (connection: unknown) => void,
  ) {}

  get id(): string {
    return this.socket.id;
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    this.socket.on(event, (...args) => {
      if (event === "connect_document") this.onDocumentConnect(args[0]);
      listener(...args);
    });
  }

  join(room: string): Promise<void> | void {
    return this.socket.join(room);
  }

  emit(event: string, ...args: unknown[]): void {
    if (event === "connect_document_success") {
      this.onConnectionSuccess(args[0]);
    }
    this.socket.emit(event, ...args);
  }

  emitToRoom(room: string, event: string, ...args: unknown[]): void {
    this.socket.nsp.to(room).emit(event, ...args);
  }

  broadcastToRoom(room: string, event: string, ...args: unknown[]): void {
    this.socket.to(room).emit(event, ...args);
  }

  disconnect(close?: boolean): void {
    this.socket.disconnect(close);
  }
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

function requestToken(
  request: import("node:http").IncomingMessage,
): string | undefined {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") return undefined;
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1];
  if (bearer) return bearer;
  const basic = /^Basic\s+(.+)$/i.exec(authorization)?.[1];
  if (!basic) return undefined;
  if (basic.split(".").length === 3) return basic;
  const credentials = Buffer.from(basic, "base64").toString("utf8");
  const separator = credentials.indexOf(":");
  return separator < 0 ? undefined : credentials.slice(separator + 1);
}

async function readJsonBody(
  request: import("node:http").IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > 16 * 1024) throw new Error("Request body is too large");
    chunks.push(bytes);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid JSON request body");
  }
  return value as Record<string, unknown>;
}

/** Spike identity endpoints only answer browser origins on this machine. */
function loopbackOrigin(origin: string | undefined): string | undefined {
  if (!origin) return undefined;
  try {
    const { hostname } = new URL(origin);
    return isLoopbackAddress(hostname.replace(/^\[|\]$/g, "")) ||
      hostname === "localhost"
      ? origin
      : undefined;
  } catch {
    return undefined;
  }
}

function jsonResponse(
  response: import("node:http").ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(encoded)),
    "Cache-Control": "no-store",
    Connection: "close",
  });
  response.end(encoded);
}

export interface FluidGatewayService {
  dispatchHttp(
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
  ): boolean;
  handlesUpgrade(
    request: import("node:http").IncomingMessage,
    socket: import("node:stream").Duplex,
  ): boolean;
  stop(): Promise<void>;
}

export async function createFluidService(
  server: Server,
  port: number,
  peerAddressForRequest?: (
    request: import("node:http").IncomingMessage,
  ) => string | undefined,
): Promise<FluidGatewayService> {
  initializeFluidTables();

  const storagePath = resolve(dirname(dbPath()), "fluid-spike-git");
  const config = new nconf.Provider().defaults({
    logger: {
      colorize: true,
      morganFormat: "dev",
      json: false,
      level: "info",
      timestamp: true,
      label: "lore-fluid-spike",
    },
    alfred: {
      maxMessageSize: "16KB",
      restJsonSize: "50mb",
      maxNumberOfClientsPerDocument: 1000000,
    },
    deli: {},
    scribe: {},
    mongo: {
      collectionNames: {
        content: "content",
        deltas: "deltas",
        documents: "documents",
        checkpoints: "checkpoints",
        partitions: "partitions",
        tenants: "tenants",
        nodes: "nodes",
        reservations: "reservations",
        scribeDeltas: "scribeDeltas",
      },
    },
    storage: storagePath,
    db: { inMemory: false, path: storagePath },
    moira: { enable: false, endpoint: "http://127.0.0.1:3070" },
    error: { track: false, endpoint: "" },
    exitOnPortConflict: false,
  });
  Object.assign(config, { gitFs: sqliteFs.promises });

  const dbFactory = new SQLiteDbFactory();
  const mongoManager = new MongoManager(dbFactory);
  const collections = config.get("mongo:collectionNames");
  const databaseManager = new MongoDatabaseManager(
    false,
    mongoManager,
    mongoManager,
    collections.nodes,
    collections.documents,
    collections.checkpoints,
    collections.deltas,
    collections.scribeDeltas,
  );
  const tokenSecret = fluidSpikeTokenSecret();
  const internalSecret = createFluidSpikeSecret();
  const tenantManager = new SpikeTenantManager(
    `http://127.0.0.1:${port}`,
    tokenSecret,
    internalSecret,
  ) as unknown as import("@fluidframework/server-services-core").ITenantManager;
  const storageNameAllocator = new StorageNameAllocator(tenantManager);
  const documentsCollection = await databaseManager.getDocumentCollection();
  const documentRepository = new MongoDocumentRepository(documentsCollection);
  const opsCollection = await databaseManager.getDeltaCollection(
    undefined,
    undefined,
  );
  const documentStorage = new DocumentStorage(
    documentRepository,
    tenantManager,
    false,
    opsCollection,
    storageNameAllocator,
  );
  const io = new SocketIoServer({ allowEIO3: true });
  const activeSockets = new Map<
    string,
    { documentId: string; participant: string; socket: SocketLike }
  >();
  const pubsub = new PubSubPublisher(io);
  const orderManager = new LocalOrdererManager(
    documentStorage,
    databaseManager,
    async (tenantId: string) =>
      internalHistorian(
        `http://127.0.0.1:${port}/repos/${encodeURIComponent(tenantId)}`,
        internalSecret,
      ),
    winston,
    config.get(),
    pubsub,
  );
  const collaborationSessionEventEmitter = new TypedEventEmitter();
  const authorize = (
    request: ExpressRequest,
    response: ExpressResponse,
    next: () => void,
  ): void => {
    if (request.headers[INTERNAL_HEADER] === internalSecret) {
      next();
      return;
    }
    const segments = request.path.split("/").filter(Boolean);
    const token = requestToken(request);
    if (!token) {
      jsonResponse(response, 401, { error: "Fluid token required" });
      return;
    }
    try {
      if (segments[0] === "repos") {
        const tenantId = ["git", "commits", "contents"].includes(
          segments[2] ?? "",
        )
          ? segments[1]
          : segments[2];
        const claims = verifyFluidSpikeToken(token, tokenSecret, {
          tenantId: tenantId ?? "",
        });
        // Refs are per document; blobs/trees/commits are content-addressed per tenant.
        const refsAt = segments.indexOf("refs");
        const refDocument =
          refsAt >= 0 && segments[refsAt + 1] === "heads"
            ? decodeURIComponent(segments.slice(refsAt + 2).join("/"))
            : undefined;
        if (
          refDocument &&
          (refDocument !== claims.documentId ||
            !hasFluidShare(refDocument, claims.user.id))
        ) {
          jsonResponse(response, 403, { error: "Document access denied" });
          return;
        }
        if (
          !claims.documentId ||
          !hasFluidShare(claims.documentId, claims.user.id)
        ) {
          jsonResponse(response, 403, { error: "Document access denied" });
          return;
        }
        next();
        return;
      }
      const tenantId = segments[1];
      const documentId = segments[2] ?? "";
      const claims = verifyFluidSpikeToken(token, tokenSecret, {
        tenantId: tenantId ?? "",
        documentId,
      });
      const creatingDocument =
        segments[0] === "documents" && !documentId && request.method === "POST";
      if (
        (creatingDocument && !claims.scopes.includes("doc:write")) ||
        (!creatingDocument &&
          (!documentId ||
            !hasFluidShare(documentId, claims.user.id) ||
            !claims.scopes.includes(
              request.method === "GET" ? "doc:read" : "doc:write",
            )))
      ) {
        jsonResponse(response, 403, { error: "Document access denied" });
        return;
      }
      if (creatingDocument) withFluidParticipant(claims.user.id, next);
      else next();
    } catch {
      jsonResponse(response, 403, { error: "Invalid Fluid token" });
    }
  };
  const app = createApp(
    config,
    documentStorage,
    mongoManager,
    collaborationSessionEventEmitter,
    authorize,
  );
  const websocketServer = new EventEmitter();
  io.on("connection", (socket: SocketLike) => {
    websocketServer.emit(
      "connection",
      new SocketIoSocket(
        socket,
        (message) => {
          if (!message || typeof message !== "object") return;
          const documentId = stringValue(
            (message as Record<string, unknown>).id,
          );
          const token = stringValue((message as Record<string, unknown>).token);
          const tenantId =
            stringValue((message as Record<string, unknown>).tenantId) ??
            FLUID_SPIKE_TENANT_ID;
          if (!documentId || !token) return;
          try {
            const claims = verifyFluidSpikeToken(token, tokenSecret, {
              tenantId,
              documentId,
            });
            if (hasFluidShare(documentId, claims.user.id)) {
              activeSockets.set(socket.id, {
                documentId,
                participant: claims.user.id,
                socket,
              });
            }
          } catch {
            socket.disconnect(true);
          }
        },
        (connection) => {
          if (!connection || typeof connection !== "object") return;
          const active = activeSockets.get(socket.id);
          const clientId = stringValue(
            (connection as Record<string, unknown>).clientId,
          );
          if (active && clientId) {
            recordFluidClient(active.documentId, clientId, active.participant);
          }
        },
      ),
    );
    socket.on("disconnect", () => activeSockets.delete(socket.id));
    socket.on("ping", (callback) => {
      if (typeof callback === "function") callback();
    });
  });
  io.attach(server);
  configureWebSocketServices(
    websocketServer as unknown as Parameters<
      typeof configureWebSocketServices
    >[0],
    orderManager,
    tenantManager,
    documentStorage,
    new TestClientManager(),
    new DefaultMetricClient(),
    winston,
    undefined, // maxNumberOfClientsPerDocument
    undefined, // numberOfMessagesPerTrace
    undefined, // maxTokenLifetimeSec
    undefined, // isTokenExpiryEnabled
    undefined, // isClientConnectivityCountingEnabled
    undefined, // isSignalUsageCountingEnabled
    undefined, // cache
    undefined, // connectThrottlerPerTenant
    undefined, // connectThrottlerPerCluster
    undefined, // submitOpThrottler
    undefined, // submitSignalThrottler
    undefined, // throttleAndUsageStorageManager
    undefined, // verifyMaxMessageSize
    undefined, // socketTracker
    undefined, // revokedTokenChecker
    collaborationSessionEventEmitter,
  );

  const pathMatches = (path: string): boolean =>
    ["/documents", "/deltas", "/repos", "/fluid-spike"].some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    );
  const isLocalPeer = (request: import("node:http").IncomingMessage): boolean =>
    isLoopbackAddress(
      peerAddressForRequest
        ? peerAddressForRequest(request)
        : request.socket.remoteAddress,
    );
  const refuseRemotePeer = (
    request: import("node:http").IncomingMessage,
  ): boolean => !isLocalPeer(request);
  const forbiddenResponse =
    "HTTP/1.1 403 Forbidden\r\n" +
    "Content-Length: 0\r\n" +
    "Connection: close\r\n" +
    "\r\n";

  return {
    dispatchHttp(request, response) {
      const path = new URL(request.url ?? "/", "http://gateway.local").pathname;
      const socketIoPath =
        path === "/socket.io" || path.startsWith("/socket.io/");
      if (!socketIoPath && !pathMatches(path)) return false;
      if (refuseRemotePeer(request)) {
        response.writeHead(403, { "Content-Length": "0", Connection: "close" });
        response.end();
        return true;
      }
      if (socketIoPath) return true;
      if (path.startsWith("/fluid-spike/")) {
        const origin = loopbackOrigin(request.headers.origin);
        if (origin) {
          response.setHeader("Access-Control-Allow-Origin", origin);
          response.setHeader("Vary", "Origin");
        }
        if (request.method === "OPTIONS") {
          response.writeHead(origin ? 204 : 403, {
            "Access-Control-Allow-Methods": "GET, POST, DELETE",
            "Access-Control-Allow-Headers": "Authorization, Content-Type",
            "Content-Length": "0",
          });
          response.end();
          return true;
        }
      }
      if (
        path.startsWith("/fluid-spike/attribution/") &&
        request.method === "GET"
      ) {
        const documentId = decodeURIComponent(
          path.slice("/fluid-spike/attribution/".length),
        );
        const token = requestToken(request);
        if (!token || !documentId) {
          jsonResponse(response, 401, { error: "Fluid token required" });
          return true;
        }
        try {
          const claims = verifyFluidSpikeToken(token, tokenSecret, {
            tenantId: FLUID_SPIKE_TENANT_ID,
            documentId,
          });
          if (
            !claims.scopes.includes("doc:read") ||
            !hasFluidShare(documentId, claims.user.id)
          ) {
            jsonResponse(response, 403, { error: "Document access denied" });
            return true;
          }
          jsonResponse(response, 200, {
            entries: fluidAttribution(documentId),
          });
        } catch {
          jsonResponse(response, 403, { error: "Invalid Fluid token" });
        }
        return true;
      }
      if (path === "/fluid-spike/token" && request.method === "POST") {
        void readJsonBody(request).then(
          (body) => {
            const documentId = stringValue(body.documentId) ?? "";
            const participant = stringValue(body.participant);
            const name = stringValue(body.name) ?? participant;
            if (!participant || participant.length > 128 || !name) {
              jsonResponse(response, 400, { error: "Invalid participant" });
              return;
            }
            if (documentId && !hasFluidShare(documentId, participant)) {
              jsonResponse(response, 403, { error: "Document not shared" });
              return;
            }
            const jwt = signFluidSpikeToken(
              {
                documentId,
                scopes: documentId ? [...FLUID_SPIKE_SCOPES] : ["doc:write"],
                tenantId: FLUID_SPIKE_TENANT_ID,
                user: { id: participant, name },
              },
              tokenSecret,
            );
            jsonResponse(response, 200, { jwt });
          },
          () => jsonResponse(response, 400, { error: "Invalid request body" }),
        );
        return true;
      }
      if (
        path === "/fluid-spike/share" &&
        (request.method === "POST" || request.method === "DELETE")
      ) {
        void readJsonBody(request).then(
          (body) => {
            const documentId = stringValue(body.documentId);
            const participant = stringValue(body.participant);
            const token = requestToken(request);
            if (!documentId || !participant || !token) {
              jsonResponse(response, 400, { error: "Invalid share request" });
              return;
            }
            try {
              const claims = verifyFluidSpikeToken(token, tokenSecret, {
                tenantId: FLUID_SPIKE_TENANT_ID,
                documentId,
              });
              if (
                !claims.scopes.includes("doc:write") ||
                !hasFluidShare(documentId, claims.user.id)
              ) {
                jsonResponse(response, 403, {
                  error: "Document access denied",
                });
                return;
              }
              if (request.method === "POST") {
                grantFluidShare(documentId, participant);
              } else {
                revokeFluidShare(documentId, participant);
                for (const active of activeSockets.values()) {
                  if (
                    active.documentId === documentId &&
                    active.participant === participant
                  ) {
                    active.socket.disconnect(true);
                  }
                }
              }
              jsonResponse(response, 200, { ok: true });
            } catch {
              jsonResponse(response, 403, { error: "Document access denied" });
            }
          },
          () => jsonResponse(response, 400, { error: "Invalid request body" }),
        );
        return true;
      }
      app(
        request as unknown as ExpressRequest,
        response as unknown as ExpressResponse,
      );
      return true;
    },
    handlesUpgrade(request, socket) {
      const path = new URL(request.url ?? "/", "http://gateway.local").pathname;
      const handled = path === "/socket.io" || path.startsWith("/socket.io/");
      if (handled && refuseRemotePeer(request)) {
        request.url = "/__fluid_spike_remote_denied";
        socket.end(forbiddenResponse);
      }
      return handled;
    },
    async stop() {
      await orderManager.close();
      await new Promise<void>((resolve, reject) => {
        void io.close((error?: Error) => (error ? reject(error) : resolve()));
      });
      await mongoManager.close();
      db().exec("PRAGMA wal_checkpoint(PASSIVE)");
    },
  };
}
