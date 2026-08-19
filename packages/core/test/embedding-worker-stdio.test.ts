import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import type { Worker, WorkerOptions } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  embed,
  _resetLocalProviderProbe,
  _restoreProvider,
  _saveAndClearProvider,
  _setTestWorkerFactory,
} from "../src/embedding";
import { isStderrSilenced, silenceStderr } from "../src/log";

type EmbedMessage = { type: string; id?: number };

class OutputWorker extends EventEmitter {
  readonly stdout = new PassThrough({ highWaterMark: 64 });
  readonly stderr = new PassThrough({ highWaterMark: 64 });

  constructor(private readonly sustainedOutput = false) {
    super();
  }

  postMessage(value: unknown): void {
    const message = value as EmbedMessage;
    if (message.type === "shutdown") {
      this.emit("exit", 0);
      return;
    }
    if (message.type !== "embed" || message.id === undefined) return;

    if (this.sustainedOutput) {
      void this.respondAfterSustainedOutput(message.id);
    } else {
      queueMicrotask(() => this.respond(message.id as number));
    }
  }

  ref(): void {}
  unref(): void {}

  async terminate(): Promise<number> {
    this.stdout.destroy();
    this.stderr.destroy();
    this.emit("exit", 0);
    return 0;
  }

  destroy(): void {
    this.stdout.destroy();
    this.stderr.destroy();
  }

  private respond(id: number): void {
    this.emit("message", {
      type: "result",
      id,
      vectors: [new Float32Array([1, 0, 0])],
    });
  }

  private async respondAfterSustainedOutput(id: number): Promise<void> {
    await this.writeWithBackpressure(this.stdout, "stdout");
    await this.writeWithBackpressure(this.stderr, "stderr");
    this.respond(id);
  }

  private async writeWithBackpressure(
    stream: PassThrough,
    label: string,
  ): Promise<void> {
    const chunk = `${label}:${"x".repeat(4096)}\n`;
    for (let i = 0; i < 512; i++) {
      if (!stream.write(chunk)) await once(stream, "drain");
    }
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("embedding worker output was not drained")),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("embedding worker owned stdio", () => {
  let savedProvider: unknown;
  let savedVoyage: string | undefined;
  let savedOpenAI: string | undefined;
  let stderrWasSilenced = false;
  const workers: OutputWorker[] = [];

  beforeEach(() => {
    savedVoyage = process.env.VOYAGE_API_KEY;
    savedOpenAI = process.env.OPENAI_API_KEY;
    delete process.env.VOYAGE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    stderrWasSilenced = isStderrSilenced();
    silenceStderr(true);
    _resetLocalProviderProbe();
    savedProvider = _saveAndClearProvider();
  });

  afterEach(() => {
    for (const worker of workers.splice(0)) worker.destroy();
    _setTestWorkerFactory(null);
    _resetLocalProviderProbe();
    _restoreProvider(savedProvider);
    silenceStderr(stderrWasSilenced);
    if (savedVoyage === undefined) delete process.env.VOYAGE_API_KEY;
    else process.env.VOYAGE_API_KEY = savedVoyage;
    if (savedOpenAI === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedOpenAI;
  });

  it("owns stdout and stderr in the file-backed dev/bundled path", async () => {
    let entrypoint: string | URL | undefined;
    let options: WorkerOptions | undefined;
    _setTestWorkerFactory((_data, seenEntrypoint, seenOptions) => {
      entrypoint = seenEntrypoint;
      options = seenOptions;
      const worker = new OutputWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    });

    await embed(["worker options"], "query");

    expect(entrypoint).toBeInstanceOf(URL);
    expect(options).toMatchObject({ stdout: true, stderr: true });
  });

  it("owns stdout and stderr in the SEA eval path", async () => {
    const globals = globalThis as Record<string, unknown>;
    const key = "__LORE_WORKER_SOURCE__";
    const hadSource = Object.hasOwn(globals, key);
    const previousSource = globals[key];
    const source = "/* synthetic SEA worker source */";
    globals[key] = source;

    try {
      let entrypoint: string | URL | undefined;
      let options: WorkerOptions | undefined;
      _setTestWorkerFactory((_data, seenEntrypoint, seenOptions) => {
        entrypoint = seenEntrypoint;
        options = seenOptions;
        const worker = new OutputWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      });

      await embed(["SEA worker options"], "query");

      expect(entrypoint).toBe(source);
      expect(options).toMatchObject({
        eval: true,
        stdout: true,
        stderr: true,
      });
    } finally {
      if (hadSource) globals[key] = previousSource;
      else delete globals[key];
    }
  });

  it("continuously drains sustained stdout and stderr without blocking embeds", async () => {
    let worker: OutputWorker | undefined;
    _setTestWorkerFactory((_data, _entrypoint, options) => {
      expect(options).toMatchObject({ stdout: true, stderr: true });
      worker = new OutputWorker(true);
      workers.push(worker);
      return worker as unknown as Worker;
    });

    const vectors = await withTimeout(
      embed(["sustained worker output"], "query"),
      2_000,
    );

    expect(vectors).toHaveLength(1);
    expect(worker?.stdout.listenerCount("data")).toBeGreaterThan(0);
    expect(worker?.stderr.listenerCount("data")).toBeGreaterThan(0);
    expect(worker?.stdout.readableLength).toBe(0);
    expect(worker?.stderr.readableLength).toBe(0);
  });
});
