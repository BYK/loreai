import { createRequire } from "node:module";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { transform } from "esbuild";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resultDir = resolve(
  process.env.SPIKE_RESULTS_DIR ??
    resolve(packageDir, "../../../spike-results"),
);
const require = createRequire(import.meta.url);
const { loadConfig, startServer } = require("../../gateway/dist/index.cjs");
const {
  createDiscussion,
  getFluidAttribution,
  identityTokenProvider,
  joinDiscussion,
  shareDiscussion,
  unshareDiscussion,
} = require("../dist/node-agent.cjs");

await mkdir(resultDir, { recursive: true });
process.env.LORE_FLUID_SPIKE = "1";
process.env.LORE_LISTEN_HOST = "127.0.0.1";
process.env.LORE_LISTEN_PORT = "0";
process.env.LORE_REMOTE_GATEWAY = "0";
process.env.LORE_HOSTED_MODE = "0";
process.env.LORE_DB_PATH = resolve(
  resultDir,
  `fluid-participants-${process.pid}.db`,
);

const config = loadConfig();
config.hosts = ["127.0.0.1"];
config.port = 0;
config.remoteGateway = false;
config.hostedMode = false;

let gateway;
const clients = [];
const result = {
  variant: "fluid",
  checks: {
    serverAttestedAttribution: { passed: false },
    forgedAuthor: { passed: false },
    readScoping: { passed: false },
    revocation: { passed: false, latencyMs: null },
  },
  mechanism:
    "Gateway-signed per-document JWT user claims; the server maps clientIds to the JWT user and the attribution endpoint returns that mapping.",
};

async function loadFluidSchema() {
  const source = await readFile(resolve(packageDir, "src/schema.ts"), "utf8");
  const { code } = await transform(source, { loader: "ts", format: "cjs" });
  const schemaPath = resolve(
    packageDir,
    `dist/participants-schema-${process.pid}.cjs`,
  );
  await writeFile(schemaPath, code);
  try {
    return require(schemaPath);
  } finally {
    await rm(schemaPath, { force: true });
  }
}

async function joinFluidDiscussion(id, author) {
  const [{ TinyliciousClient }, { TreeViewConfiguration }, schema] =
    await Promise.all([
      import("@fluidframework/tinylicious-client"),
      import("fluid-framework"),
      loadFluidSchema(),
    ]);
  const domain = process.env.LORE_FLUID_DOMAIN ?? "http://127.0.0.1";
  const port = Number(process.env.LORE_FLUID_PORT ?? 7070);
  const client = new TinyliciousClient({
    connection: {
      domain,
      port,
      tokenProvider: identityTokenProvider(author, author, `${domain}:${port}`),
    },
  });
  const { container } = await client.getContainer(
    id,
    schema.discussionContainerSchema,
    "2.0.0",
  );
  const view = container.initialObjects.discussion.viewWith(
    new TreeViewConfiguration({ schema: schema.Discussion }),
  );
  const deadline = performance.now() + 20_000;
  while (
    !["2", "connected"].includes(
      String(container.connectionState).toLowerCase(),
    )
  ) {
    if (performance.now() >= deadline)
      throw new Error("Fluid participant did not connect");
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  return {
    container,
    appendAs(text, replyAuthor) {
      const reply = {
        author: replyAuthor,
        text,
        at: performance.timeOrigin + performance.now(),
      };
      view.root.replies.insertAtEnd(reply);
      return reply;
    },
    state() {
      return Array.from(view.root.replies, ({ author, text, at }) => ({
        author,
        text,
        at,
      }));
    },
    close: () => container.dispose(),
  };
}

try {
  gateway = await startServer(config);
  await gateway.ready;
  process.env.LORE_FLUID_PORT = String(gateway.port);
  const first = await createDiscussion("alice");
  clients.push(first.participant);
  const second = await createDiscussion("alice");
  clients.push(second.participant);
  await shareDiscussion(first.id, "alice", "agent");
  const agent = await joinFluidDiscussion(first.id, "agent");
  clients.push(agent);
  agent.appendAs("forged#1", "alice");

  const waitFor = async (predicate, timeoutMs = 10_000) => {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      if (predicate()) return true;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    return false;
  };

  const forgedVisible = await waitFor(() =>
    first.participant.state().some(({ text }) => text === "forged#1"),
  );
  const attribution = await getFluidAttribution(first.id, "alice");
  const forgedOperation = attribution.find(
    (entry) =>
      entry.participant === "agent" && entry.operation.includes("forged#1"),
  );
  result.checks.serverAttestedAttribution = {
    pass: Boolean(forgedOperation),
    clientId: forgedOperation?.clientId ?? null,
    sequenceNumber: forgedOperation?.sequenceNumber ?? null,
  };
  result.checks.forgedAuthor = {
    pass: Boolean(
      forgedVisible &&
      forgedOperation &&
      forgedOperation.participant === "agent" &&
      forgedOperation.operation.includes('\\"alice\\",\\"forged#1\\"'),
    ),
    author: "alice",
    serverParticipant: forgedOperation?.participant ?? null,
  };

  let joinDenied = null;
  try {
    const denied = await joinDiscussion(second.id, "agent");
    clients.push(denied);
  } catch (error) {
    joinDenied = String(error);
  }
  // Replay the agent's valid D1 token against D2's storage and delta routes.
  const base = `http://127.0.0.1:${gateway.port}`;
  const d1Token = await identityTokenProvider(
    "agent",
    "agent",
    base,
  ).fetchOrdererToken("tinylicious", first.id);
  const replay = {};
  for (const path of [
    `/documents/tinylicious/${second.id}`,
    `/deltas/tinylicious/${second.id}`,
    `/repos/tinylicious/git/refs/heads/${second.id}`,
  ]) {
    const response = await fetch(`${base}${path}`, {
      headers: { Authorization: `Basic ${d1Token.jwt}` },
    });
    replay[path.replace(second.id, ":d2")] = response.status;
  }
  result.checks.readScoping = {
    pass:
      joinDenied !== null &&
      Object.values(replay).every((status) => status === 401 || status === 403),
    joinError: joinDenied,
    d1TokenReplayStatus: replay,
  };

  const container = agent.container ?? agent.fluidContainer;
  let resolveDisconnected;
  const disconnectedEvent = new Promise((resolveDisconnect) => {
    resolveDisconnected = resolveDisconnect;
  });
  const disconnectListener = () => resolveDisconnected(performance.now());
  const canObserveDisconnect =
    typeof container?.on === "function" && typeof container?.off === "function";
  if (canObserveDisconnect) {
    container.on("disconnected", disconnectListener);
  }
  const revokeStarted = performance.now();
  await unshareDiscussion(first.id, "alice", "agent");
  let disconnectedAt = null;
  if (canObserveDisconnect) {
    let timeoutId;
    disconnectedAt = await Promise.race([
      disconnectedEvent,
      new Promise((resolveTimeout) => {
        timeoutId = setTimeout(() => resolveTimeout(null), 5000);
      }),
    ]);
    clearTimeout(timeoutId);
    container.off("disconnected", disconnectListener);
  }
  const revokedReply = "after-revocation";
  first.participant.append(revokedReply);
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  result.checks.revocation = {
    pass:
      disconnectedAt !== null &&
      !agent.state().some(({ text }) => text === revokedReply),
    latencyMs: disconnectedAt === null ? null : disconnectedAt - revokeStarted,
    disconnectListenerAvailable: canObserveDisconnect,
    t0: "immediately before the owner's unshare request",
    t1: "the agent's Fluid container disconnected event",
    noPostRevocationEditReceived: !agent
      .state()
      .some(({ text }) => text === revokedReply),
    ...(canObserveDisconnect
      ? {}
      : {
          limitation:
            "The Fluid container does not expose a disconnected event listener.",
        }),
  };
  result.attributionRows = attribution.length;
} catch (error) {
  result.error = String(error);
} finally {
  await Promise.all(clients.map((client) => client.close()));
  await gateway?.stop();
}

result.loc = (
  await Promise.all(
    [
      "../gateway/src/fluid/auth.ts",
      "../gateway/src/fluid/index.ts",
      "../gateway/src/fluid/sqlite.ts",
    ].map((path) => readFile(resolve(packageDir, path), "utf8")),
  )
).reduce((total, source) => total + source.split("\n").length - 1, 0);
const path = resolve(resultDir, "participants-fluid.json");
await writeFile(path, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ path, result }, null, 2));
