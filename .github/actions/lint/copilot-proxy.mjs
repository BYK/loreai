import { fork } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 85_000;
const CLEANUP_TIMEOUT_MS = 2_000;
const DISABLED_TOOLS = ["builtin:*", "mcp:*", "custom:*"];

async function settleWithin(operation, timeoutMs) {
  let timeout;
  const result = await Promise.race([
    Promise.resolve()
      .then(operation)
      .then(
        (value) => ({ status: "fulfilled", value }),
        (error) => ({ status: "rejected", error }),
      ),
    new Promise((resolveTimeout) => {
      timeout = setTimeout(
        () => resolveTimeout({ status: "timeout" }),
        timeoutMs,
      );
    }),
  ]);
  clearTimeout(timeout);
  return result;
}

function requestText(input) {
  if (!Array.isArray(input)) return "";
  return input
    .filter((item) => item && item.role === "user")
    .flatMap((item) => {
      if (typeof item.content === "string") return [item.content];
      if (!Array.isArray(item.content)) return [];
      return item.content
        .filter(
          (block) =>
            block &&
            (block.type === "input_text" || block.type === "text") &&
            typeof block.text === "string",
        )
        .map((block) => block.text);
    })
    .join("\n");
}

function reasoningEffort(body) {
  const effort = body?.reasoning?.effort;
  return ["low", "medium", "high", "xhigh", "max"].includes(effort)
    ? effort
    : undefined;
}

function maxOutputTokens(body) {
  const value = body?.max_output_tokens;
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function copilotSessionConfig(body) {
  if (!body || typeof body !== "object") {
    throw new Error("request body must be an object");
  }
  if (typeof body.model !== "string" || body.model.length === 0) {
    throw new Error("request model is required");
  }
  if (!/^gpt-5\.6-[A-Za-z0-9._-]+$/.test(body.model)) {
    throw new Error("request model must be in the gpt-5.6-* family");
  }
  if (typeof body.instructions !== "string") {
    throw new Error("request instructions are required");
  }
  const prompt = requestText(body.input);
  if (prompt.length === 0) throw new Error("request user input is required");
  const effort = reasoningEffort(body);
  const outputTokens = maxOutputTokens(body);

  return {
    prompt,
    config: {
      clientName: "lore-semantic-linter",
      model: body.model,
      ...(effort ? { reasoningEffort: effort } : {}),
      ...(outputTokens
        ? { modelCapabilities: { limits: { max_output_tokens: outputTokens } } }
        : {}),
      systemMessage: { mode: "replace", content: body.instructions },
      tools: [],
      availableTools: [],
      excludedTools: DISABLED_TOOLS,
      defaultAgent: { excludedTools: DISABLED_TOOLS },
      enableConfigDiscovery: false,
      enableSkills: false,
      enableSessionStore: false,
      infiniteSessions: { enabled: false },
      memory: { enabled: false },
      streaming: false,
      enableSessionTelemetry: false,
    },
  };
}

export async function runCopilotResponse(client, body, signal) {
  const { prompt, config } = copilotSessionConfig(body);
  const session = await client.createSession(config);
  let rejectAborted;
  let abortRequest;
  const aborted = new Promise((_resolve, reject) => {
    rejectAborted = reject;
  });
  const abort = () => {
    abortRequest ??= Promise.resolve().then(() => session.abort());
    const reject = rejectAborted;
    rejectAborted = undefined;
    reject?.(signal?.reason ?? new DOMException("Aborted", "AbortError"));
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) {
      abort();
    }
    const response = await Promise.race([
      session.sendAndWait({ prompt }, REQUEST_TIMEOUT_MS),
      aborted,
    ]);
    rejectAborted = undefined;
    const text = response?.data?.content;
    if (typeof text !== "string" || text.length === 0) {
      throw new Error("Copilot returned no assistant message");
    }
    return {
      id: `resp_${randomUUID()}`,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      model: body.model,
      status: "completed",
      output: [
        {
          type: "message",
          id: `msg_${randomUUID()}`,
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text,
              annotations: [],
              logprobs: [],
            },
          ],
        },
      ],
    };
  } finally {
    rejectAborted = undefined;
    signal?.removeEventListener("abort", abort);
    if (abortRequest) {
      await settleWithin(() => abortRequest, CLEANUP_TIMEOUT_MS);
    }
    await settleWithin(() => session.disconnect(), CLEANUP_TIMEOUT_MS);
  }
}

function writeJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

export function copilotProxyErrorResponse(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/rate limit|429/i.test(message)) {
    return { status: 429, message: "Copilot rate limit exceeded" };
  }
  if (/billing|credit|quota|spending limit/i.test(message)) {
    return { status: 402, message: "insufficient credit or Copilot quota" };
  }
  if (
    /model.{0,80}(not supported|unsupported|not found|unavailable|must be in)|unknown model/i.test(
      message,
    )
  ) {
    return { status: 400, message: "Copilot model is not supported" };
  }
  if (
    /\b(?:auth|authentication|authorization|unauthorized|forbidden|permission|policy)\b|\bnot (?:authorized|authenticated)\b|\baccess denied\b|\b(?:401|403)\b|\b(?:(?:invalid|expired|rejected) (?:github )?token|token (?:is )?(?:invalid|expired|rejected))\b/i.test(
      message,
    )
  ) {
    return {
      status: 403,
      message: "Copilot authentication or policy rejected",
    };
  }
  return { status: 502, message: "Copilot SDK request failed" };
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) throw new Error("request body is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createCopilotProxyHandler(client) {
  return async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      return writeJson(response, 200, { status: "ok" });
    }
    if (
      request.method !== "POST" ||
      (request.url !== "/responses" && request.url !== "/v1/responses")
    ) {
      return writeJson(response, 404, { error: { message: "not found" } });
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    const abortIfUnfinished = () => {
      if (!response.writableEnded) controller.abort();
    };
    request.once("aborted", abort);
    response.once("close", abortIfUnfinished);
    try {
      const body = await readJson(request);
      const result = await runCopilotResponse(client, body, controller.signal);
      if (!controller.signal.aborted) writeJson(response, 200, result);
    } catch (error) {
      if (controller.signal.aborted) return;
      const failure = copilotProxyErrorResponse(error);
      writeJson(response, failure.status, {
        error: { message: failure.message },
      });
    } finally {
      request.off("aborted", abort);
      response.off("close", abortIfUnfinished);
    }
  };
}

export async function stopCopilotClient(client) {
  const stopped = await settleWithin(() => client.stop(), CLEANUP_TIMEOUT_MS);
  if (
    stopped.status !== "fulfilled" ||
    (Array.isArray(stopped.value) && stopped.value.length > 0)
  ) {
    await settleWithin(() => client.forceStop(), CLEANUP_TIMEOUT_MS);
  }
}

export async function startCopilotProxy(client) {
  await client.start();
  const handler = createCopilotProxyHandler(client);
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Copilot proxy did not bind a TCP port");
  }

  let shutdownPromise;
  const shutdown = () => {
    shutdownPromise ??= (async () => {
      const closed = new Promise((resolveClose) => server.close(resolveClose));
      server.closeAllConnections();
      await closed;
      await stopCopilotClient(client);
    })();
    return shutdownPromise;
  };
  return { url: `http://127.0.0.1:${address.port}`, shutdown };
}

async function serve(sdkModulePath) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required");
  const baseDirectory =
    process.env.LORE_COPILOT_PROXY_HOME ??
    resolve(process.env.RUNNER_TEMP ?? "/tmp", "lore-copilot-proxy-home");
  mkdirSync(baseDirectory, { recursive: true });

  const { CopilotClient } = await import(
    pathToFileURL(resolve(sdkModulePath)).href
  );
  const client = new CopilotClient({
    mode: "empty",
    baseDirectory,
    workingDirectory: process.cwd(),
    gitHubToken: token,
    useLoggedInUser: false,
    logLevel: "error",
  });
  const proxy = await startCopilotProxy(client);
  const shutdown = async () => {
    await proxy.shutdown();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  process.send?.({ type: "ready", url: proxy.url });
}

export async function launch(sdkModulePath, spawnChild = fork) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error("GITHUB_OUTPUT is required");
  const runnerTemp = process.env.RUNNER_TEMP ?? "/tmp";
  const logPath = resolve(runnerTemp, "lore-copilot-proxy.log");
  const log = openSync(logPath, "a");
  const child = spawnChild(
    fileURLToPath(import.meta.url),
    ["serve", sdkModulePath],
    {
      detached: true,
      env: {
        ...process.env,
        LORE_COPILOT_PROXY_HOME: resolve(runnerTemp, "lore-copilot-proxy-home"),
      },
      stdio: ["ignore", log, log, "ipc"],
    },
  );
  closeSync(log);

  await new Promise((resolveReady, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (child.pid) killProcess(child.pid, "SIGKILL", true);
      reject(error);
    };
    const timeout = setTimeout(() => {
      fail(new Error("Copilot SDK bridge did not start within 60 seconds"));
    }, 60_000);
    child.once("error", fail);
    child.once("exit", (code) =>
      fail(new Error(`Copilot SDK bridge exited during startup (${code})`)),
    );
    child.on("message", (message) => {
      if (
        !message ||
        message.type !== "ready" ||
        typeof message.url !== "string"
      ) {
        return;
      }
      if (settled) return;
      try {
        appendFileSync(output, `url=${message.url}\npid=${child.pid}\n`);
      } catch (error) {
        fail(error);
        return;
      }
      settled = true;
      clearTimeout(timeout);
      child.removeAllListeners();
      child.disconnect();
      child.unref();
      resolveReady();
    });
  });
}

export function processIsAlive(pid, processGroup = false) {
  try {
    process.kill(processGroup && process.platform !== "win32" ? -pid : pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

export function killProcess(pid, signal, processGroup = false) {
  try {
    process.kill(
      processGroup && process.platform !== "win32" ? -pid : pid,
      signal,
    );
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (processGroup && error?.code === "EPERM") {
      process.kill(pid, signal);
      return true;
    }
    throw error;
  }
}

export async function stop(pidValue) {
  if (!/^[1-9][0-9]*$/.test(pidValue ?? "")) return;
  const pid = Number(pidValue);
  if (!killProcess(pid, "SIGTERM", true)) return;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid, true)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  killProcess(pid, "SIGKILL", true);
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [command, value] = process.argv.slice(2);
  const operation =
    command === "serve"
      ? serve(value)
      : command === "launch"
        ? launch(value)
        : command === "stop"
          ? stop(value)
          : Promise.reject(new Error("expected serve, launch, or stop"));
  operation.catch(() => {
    process.send?.({ type: "error" });
    console.error(`Copilot SDK bridge ${command ?? "operation"} failed`);
    process.exitCode = 1;
  });
}
