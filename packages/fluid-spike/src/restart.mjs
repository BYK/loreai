import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { chromium } from "@playwright/test";
import { createServer as createViteServer } from "vite";
import { reserveLoopbackPort, spawnGateway } from "./gateway-process.mjs";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageDir, "../..");
const resultDir = resolve(
  process.env.SPIKE_RESULTS_DIR ?? resolve(repoRoot, "../spike-results"),
);
const supported = ["fluid", "yjs", "automerge", "nocrdt"];
const variantIndex = process.argv.indexOf("--variant");
const variants =
  variantIndex >= 0
    ? [process.argv[variantIndex + 1]]
    : ["fluid", "yjs", "automerge", "nocrdt"];
for (const variant of variants) {
  if (!supported.includes(variant))
    throw new Error(`Unknown variant: ${variant}`);
}

const require = createRequire(import.meta.url);
const failures = [];

async function fluidBrowserPage(browser, vitePort, gatewayPort, author) {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(window, "spike", {
      configurable: true,
      get() {
        const fluid = window.fluidSpike;
        if (!fluid) return undefined;
        return {
          create: (...args) => fluid.create(...args),
          load: (...args) => fluid.load(...args),
          append: (...args) => fluid.append(...args),
          finalState: () => fluid.finalState(),
          dispose: () => fluid.dispose(),
          ready: async () => {
            const deadline = Date.now() + 30_000;
            while (Date.now() < deadline && fluid.connectionState() !== "2") {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            if (fluid.connectionState() !== "2")
              throw new Error("Fluid browser connection timeout");
          },
        };
      },
    });
  });
  await page.goto(
    `http://127.0.0.1:${vitePort}/?port=${gatewayPort}&author=${author}`,
  );
  await page.waitForFunction(
    () => typeof window.spike?.create === "function",
    undefined,
    { timeout: 20_000 },
  );
  return page;
}

async function runFluidCase(signal) {
  const dataDir = await mkdtemp(
    resolve(resultDir, `.restart-fluid-${signal}-`),
  );
  const dbPath = resolve(dataDir, "gateway.db");
  const port = await reserveLoopbackPort();
  const clients = [];
  const pages = [];
  const trace = [];
  let gateway;
  let vite;
  let browser;
  let agent;
  const gatewayLogs = [];
  let documentId;
  try {
    process.env.LORE_FLUID_PORT = String(port);
    process.env.LORE_FLUID_DOMAIN = "http://127.0.0.1";
    gateway = spawnGateway({ variant: "fluid", port, dbPath });
    await gateway.waitForHealth();
    vite = await createViteServer({
      root: packageDir,
      configFile: false,
      server: { host: "127.0.0.1", port: 0 },
    });
    await vite.listen();
    const vitePort = vite.httpServer.address().port;
    browser = await chromium.launch({ headless: true });
    const alice = await fluidBrowserPage(browser, vitePort, port, "alice");
    const bob = await fluidBrowserPage(browser, vitePort, port, "bob");
    pages.push(alice, bob);
    documentId = await alice.evaluate(() => window.fluidSpike.create());
    await Promise.all(
      ["bob", "agent", "carol"].map((participant) =>
        alice.evaluate(({ id, name }) => window.fluidSpike.share(id, name), {
          id: documentId,
          name: participant,
        }),
      ),
    );
    await bob.evaluate((id) => window.fluidSpike.load(id), documentId);
    await Promise.all([
      alice.evaluate(() => window.spike.ready()),
      bob.evaluate(() => window.spike.ready()),
    ]);
    const nodeAgent = loadAgentModule("fluid", port);
    agent = await nodeAgent.joinDiscussion(documentId, "agent");
    clients.push(agent);
    await alice.evaluate(() =>
      window.fluidSpike.append("alice", "before-restart"),
    );
    await waitFor(
      async () =>
        (await bob.evaluate(() =>
          window.spike
            .finalState()
            .some((reply) => reply.text === "before-restart"),
        )) && agent.state().some((reply) => reply.text === "before-restart"),
      "pre-restart edit convergence",
    );
    gatewayLogs.push(gateway.output());
    trace.push("both browsers and Node agent observed before-restart");

    await gateway.stop(signal);
    trace.push(`gateway stopped with ${signal}`);
    gateway = spawnGateway({ variant: "fluid", port, dbPath });
    const readyAt = await gateway.waitForHealth();
    trace.push("gateway restarted and health returned 200");
    await Promise.all([
      alice.evaluate(() => window.spike.ready()),
      bob.evaluate(() => window.spike.ready()),
    ]);
    const editText = `after-${signal}`;
    await alice.evaluate(
      (text) => window.fluidSpike.append("alice", text),
      editText,
    );
    await waitFor(
      async () =>
        (await bob.evaluate(() =>
          window.spike.finalState().some((reply) => reply.text === editText),
        )) && agent.state().some((reply) => reply.text === editText),
      "post-restart edit convergence",
    );
    const reconnectMs = performance.now() - readyAt;

    const fresh = await fluidBrowserPage(browser, vitePort, port, "carol");
    pages.push(fresh);
    await fresh.evaluate((id) => window.fluidSpike.load(id), documentId);
    await fresh.evaluate(() => window.spike.ready());
    const allTexts = await fresh.evaluate(() =>
      window.spike.finalState().map((reply) => reply.text),
    );
    const expected = ["before-restart", editText];
    if (!expected.every((text) => allTexts.includes(text))) {
      throw new Error(
        `Fresh client missed replies: ${JSON.stringify({ expected, received: allTexts })}`,
      );
    }
    trace.push("fresh fourth client loaded full state");
    gatewayLogs.push(gateway.output());
    return {
      passed: true,
      signal,
      reconnectMs,
      priorReplies: ["before-restart"],
      postRestartReplies: [editText],
      freshClientReplies: allTexts,
      trace,
      gatewayOutput: gatewayLogs.join("\n"),
    };
  } catch (error) {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    const states = await Promise.all(
      pages.map(async (page) =>
        page
          .evaluate(
            () => window.spike?.finalState?.().map((reply) => reply.text) ?? [],
          )
          .catch(() => []),
      ),
    );
    const expected = ["before-restart", `after-${signal}`];
    const lostReplies = Object.fromEntries(
      ["alice", "bob", "carol"].map((name, index) => [
        name,
        expected.filter((text) => !states[index]?.includes(text)),
      ]),
    );
    lostReplies.agent = expected.filter(
      (text) => !agent?.state().some((reply) => reply.text === text),
    );
    if (gateway) gatewayLogs.push(gateway.output());
    failures.push(`fluid/${signal}: ${message}`);
    return {
      passed: false,
      signal,
      error: message,
      lostReplies,
      trace,
      gatewayOutput: gatewayLogs.join("\n"),
    };
  } finally {
    await Promise.all(clients.map((client) => closeParticipant(client)));
    for (const page of pages) {
      await page.evaluate(() => window.spike?.dispose?.()).catch(() => {});
    }
    await browser?.close();
    await vite?.close();
    await gateway?.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
}

function loadAgentModule(variant, port) {
  if (variant === "fluid") {
    process.env.LORE_FLUID_PORT = String(port);
    process.env.LORE_FLUID_DOMAIN = "http://127.0.0.1";
    return require(resolve(packageDir, "dist/node-agent.cjs"));
  }
  return require(resolve(packageDir, `dist/${variant}-agent.cjs`));
}

async function shareSpikeDocument(
  variant,
  gatewayUrl,
  documentId,
  participant,
) {
  if (variant === "fluid") {
    const agentModule = loadAgentModule(variant, new URL(gatewayUrl).port);
    await agentModule.shareDiscussion(documentId, "alice", participant);
    return;
  }
  const tokenResponse = await fetch(
    `${gatewayUrl}/api/v1/spike/${variant}/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId, participant: "alice" }),
    },
  );
  if (!tokenResponse.ok) {
    throw new Error(`Owner token request failed: ${tokenResponse.status}`);
  }
  const { token } = await tokenResponse.json();
  const response = await fetch(`${gatewayUrl}/api/v1/spike/${variant}/share`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ documentId, participant, token }),
  });
  if (!response.ok) {
    throw new Error(`Share failed for ${participant}: ${response.status}`);
  }
}

async function createOwner(variant, gatewayUrl, port) {
  const agentModule = loadAgentModule(variant, port);
  if (variant === "fluid") {
    const created = await agentModule.createDiscussion("alice");
    return {
      documentId: created.id,
      participant: created.participant,
      agentModule,
    };
  }
  const participant = await agentModule.createDiscussion(gatewayUrl, "alice");
  return {
    documentId: participant.documentId,
    participant,
    agentModule,
  };
}

async function joinParticipant(variant, gatewayUrl, port, documentId, name) {
  const agentModule = loadAgentModule(variant, port);
  return variant === "fluid"
    ? agentModule.joinDiscussion(documentId, name)
    : agentModule.joinDiscussion(gatewayUrl, documentId, name);
}

async function waitFor(predicate, label, timeoutMs = 20_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolvePause) => setTimeout(resolvePause, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function closeParticipant(participant) {
  if (participant?.close) await participant.close();
}

async function runCase(variant, signal, retryIntervalMs = null) {
  const previousRetryInterval =
    process.env.LORE_SPIKE_AUTOMERGE_RETRY_INTERVAL_MS;
  if (variant === "automerge") {
    process.env.LORE_SPIKE_AUTOMERGE_RETRY_INTERVAL_MS = String(
      retryIntervalMs ?? 5000,
    );
  }
  const dataDir = await mkdtemp(
    resolve(resultDir, `.restart-${variant}-${signal}-`),
  );
  const dbPath = resolve(dataDir, "gateway.db");
  const port = await reserveLoopbackPort();
  const gatewayUrl = `http://127.0.0.1:${port}`;
  const clients = [];
  let gateway;
  const trace = [];
  try {
    gateway = spawnGateway({ variant, port, dbPath });
    await gateway.waitForHealth();
    const { documentId, participant: owner } = await createOwner(
      variant,
      gatewayUrl,
      port,
    );
    clients.push(owner);
    for (const name of ["bob", "agent", "carol"]) {
      await shareSpikeDocument(variant, gatewayUrl, documentId, name);
    }
    const bob = await joinParticipant(
      variant,
      gatewayUrl,
      port,
      documentId,
      "bob",
    );
    const agent = await joinParticipant(
      variant,
      gatewayUrl,
      port,
      documentId,
      "agent",
    );
    clients.push(bob, agent);
    await owner.append("before-restart");
    await waitFor(
      () =>
        bob.state().some((reply) => reply.text === "before-restart") &&
        agent.state().some((reply) => reply.text === "before-restart"),
      "pre-restart edit convergence",
    );
    await new Promise((resolvePause) => setTimeout(resolvePause, 250));
    trace.push("pre-restart edit converged");

    await gateway.stop(signal);
    trace.push(`gateway stopped with ${signal}`);
    gateway = spawnGateway({ variant, port, dbPath });
    const readyAt = await gateway.waitForHealth();
    trace.push("gateway restarted and health returned 200");
    await new Promise((resolvePause) => setTimeout(resolvePause, 300));
    const editText = `after-${signal}`;
    await owner.append(editText);
    await waitFor(
      () =>
        bob.state().some((reply) => reply.text === editText) &&
        agent.state().some((reply) => reply.text === editText),
      "post-restart remote edit",
    );
    const reconnectMs = performance.now() - readyAt;

    const fresh = await joinParticipant(
      variant,
      gatewayUrl,
      port,
      documentId,
      "carol",
    );
    clients.push(fresh);
    await waitFor(
      () =>
        fresh.state().some((reply) => reply.text === "before-restart") &&
        fresh.state().some((reply) => reply.text === editText),
      "fresh participant full document",
    );
    const stateTexts = (participant) =>
      participant.state().map((reply) => reply.text);
    const expected = ["before-restart", editText];
    const passed = [owner, bob, agent, fresh].every((participant) =>
      expected.every((text) => stateTexts(participant).includes(text)),
    );
    if (!passed) throw new Error("Restarted participants diverged");
    trace.push("existing and fresh participants have full state");
    return {
      passed: true,
      signal,
      reconnectMs,
      editsBeforeRestart: 1,
      editsAfterRestart: 1,
      participantCountAfterRestart: 4,
      trace,
      gatewayOutput: gateway.output(),
      retryIntervalMs,
    };
  } catch (error) {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    failures.push(`${variant}/${signal}: ${message}`);
    return {
      passed: false,
      signal,
      error: message,
      trace,
      gatewayOutput: gateway?.output() ?? "",
      retryIntervalMs,
    };
  } finally {
    await Promise.all(clients.map((client) => closeParticipant(client)));
    await gateway?.stop();
    await rm(dataDir, { recursive: true, force: true });
    if (previousRetryInterval === undefined)
      delete process.env.LORE_SPIKE_AUTOMERGE_RETRY_INTERVAL_MS;
    else
      process.env.LORE_SPIKE_AUTOMERGE_RETRY_INTERVAL_MS =
        previousRetryInterval;
  }
}

await mkdir(resultDir, { recursive: true });
for (const variant of variants) {
  const cases = {};
  const retryIntervals = variant === "automerge" ? [5000, 50] : [null];
  for (const retryIntervalMs of retryIntervals) {
    for (const signal of ["SIGTERM", "SIGKILL"]) {
      const key =
        retryIntervalMs === null
          ? signal
          : `${signal}-retry-${retryIntervalMs}ms`;
      cases[key] =
        variant === "fluid"
          ? await runFluidCase(signal)
          : await runCase(variant, signal, retryIntervalMs);
      await writeFile(
        resolve(resultDir, `restart-${variant}-${key.toLowerCase()}.log`),
        JSON.stringify(cases[key], null, 2),
      );
    }
  }
  const path = resolve(resultDir, `restart-${variant}.json`);
  const reconnectPolicy =
    variant === "automerge"
      ? {
          defaultRetryIntervalMs: 5000,
          alignedRetryIntervalMs: 50,
          alignedWith: "Yjs provider reconnect delay",
        }
      : variant === "yjs"
        ? { reconnectDelayMs: 50, mechanism: "WebSocket close timer" }
        : variant === "nocrdt"
          ? { reconnectDelayMs: 50, mechanism: "SSE retry timer" }
          : {
              mechanism:
                "Fluid Framework built-in reconnect policy; not overridden by the spike harness",
            };
  await writeFile(
    path,
    `${JSON.stringify({ variant, reconnectPolicy, cases }, null, 2)}\n`,
  );
  console.log(JSON.stringify({ path, reconnectPolicy, cases }, null, 2));
}
if (failures.length > 0) {
  throw new Error(failures.join("\n"));
}
