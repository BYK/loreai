/**
 * LLM backend abstraction for the eval suite.
 *
 * Supports Anthropic (direct), GitHub Copilot API (free in CI under the
 * workflow's `copilot-requests: write` permission), and OpenAI as backends.
 * The harness and judge call `prompt()` on the resolved backend without
 * knowing which provider is active.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LLMBackendType = "anthropic" | "github-copilot" | "openai";

export interface BackendConfig {
  backend: LLMBackendType;
  model: string;
  judgeModel: string;
  apiKey: string;
  baseUrl: string;
}

export interface PromptOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** If true, parse the response as JSON. */
  json?: boolean;
}

export interface PromptResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface EvalLLMClient {
  prompt(
    system: string,
    user: string,
    opts?: PromptOptions,
  ): Promise<PromptResult>;
  readonly config: BackendConfig;
}

// ---------------------------------------------------------------------------
// Rate limiter (token-bucket with 429 backoff)
// ---------------------------------------------------------------------------

class RateLimiter {
  private queue: Array<{
    resolve: () => void;
    reject: (e: Error) => void;
  }> = [];
  private inflight = 0;
  private backoffUntil = 0;

  constructor(
    private maxConcurrent: number,
    private minIntervalMs: number,
  ) {}

  async acquire(): Promise<void> {
    // Honor backoff from 429 responses
    const now = Date.now();
    if (this.backoffUntil > now) {
      await new Promise((r) => setTimeout(r, this.backoffUntil - now));
    }

    if (this.inflight < this.maxConcurrent) {
      this.inflight++;
      return;
    }

    return new Promise<void>((resolve, reject) => {
      this.queue.push({ resolve, reject });
    });
  }

  release(): void {
    this.inflight--;
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.inflight++;
      // Add minimum interval between requests
      setTimeout(() => next.resolve(), this.minIntervalMs);
    }
  }

  backoff(retryAfterMs: number): void {
    this.backoffUntil = Date.now() + retryAfterMs;
  }
}

// ---------------------------------------------------------------------------
// Resolve backend from environment
// ---------------------------------------------------------------------------

/**
 * Normalize an Anthropic base URL so `${baseUrl}/v1/messages` is always well
 * formed: drop any trailing slash and a trailing `/v1` segment. This lets
 * callers pass either `https://host/anthropic` or `https://host/anthropic/v1`.
 */
export function normalizeAnthropicBaseUrl(url: string): string {
  return url.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export function resolveBackend(
  overrides?: Partial<BackendConfig>,
): BackendConfig {
  // Anthropic direct — preferred when available (no daily limits, best quality).
  // ANTHROPIC_BASE_URL (the standard Anthropic-SDK env var) points the backend
  // at any Anthropic-compatible provider (e.g. MiniMax's /anthropic endpoint).
  // The base must NOT include the version segment — `/v1/messages` is appended.
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      backend: "anthropic",
      model: "claude-sonnet-4-6",
      judgeModel: "claude-sonnet-4-6",
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseUrl: normalizeAnthropicBaseUrl(
        process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
      ),
      ...overrides,
    };
  }

  // OpenAI direct
  if (process.env.OPENAI_API_KEY) {
    return {
      backend: "openai",
      model: "gpt-4.1",
      judgeModel: "gpt-4.1",
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: "https://api.openai.com",
      ...overrides,
    };
  }

  // GitHub Copilot API — free fallback in CI. The workflow's `copilot-requests:
  // write` permission lets the built-in `GITHUB_TOKEN` call
  // api.githubcopilot.com directly as a Bearer credential; no separate Copilot
  // token exchange is needed.
  if (process.env.GITHUB_ACTIONS && process.env.GITHUB_TOKEN) {
    return {
      backend: "github-copilot",
      model: "gpt-5-mini",
      judgeModel: "gpt-5-mini",
      apiKey: process.env.GITHUB_TOKEN,
      baseUrl: "https://api.githubcopilot.com",
      ...overrides,
    };
  }

  // No API key — fixture mode only
  return {
    backend: "anthropic",
    model: "claude-sonnet-4-6",
    judgeModel: "claude-sonnet-4-6",
    apiKey: "",
    baseUrl: "https://api.anthropic.com",
    ...overrides,
  };
}

/**
 * Dedicated judge backend, independent of the answering model.
 *
 * A weak or non-Anthropic answering model must NEVER grade its own output
 * (self-judging / unreliable grading floors every score). When JUDGE_API_KEY
 * is set, the judge always runs on Anthropic (Sonnet by default) via the real
 * Anthropic key + endpoint, regardless of which provider the answering model
 * uses. Falls back to the shared answering backend when JUDGE_API_KEY is unset
 * (back-compat: single-provider runs keep working unchanged).
 */
export function resolveJudgeBackend(answer: BackendConfig): BackendConfig {
  const judgeKey = process.env.JUDGE_API_KEY;
  if (!judgeKey) return answer;
  const judgeModel =
    process.env.JUDGE_MODEL || answer.judgeModel || "claude-sonnet-4-5";
  return {
    backend: "anthropic",
    model: judgeModel,
    judgeModel,
    apiKey: judgeKey,
    baseUrl: normalizeAnthropicBaseUrl(
      process.env.JUDGE_BASE_URL ?? "https://api.anthropic.com",
    ),
  };
}

// ---------------------------------------------------------------------------
// Anthropic client
// ---------------------------------------------------------------------------

async function promptAnthropic(
  config: BackendConfig,
  system: string,
  user: string,
  opts?: PromptOptions,
): Promise<PromptResult> {
  const model = opts?.model ?? config.model;
  const resp = await fetch(`${config.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: opts?.maxTokens ?? 4096,
      temperature: opts?.temperature ?? 0,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Anthropic API error ${resp.status}: ${body}`);
  }

  const data = (await resp.json()) as {
    content: Array<{ type: string; text?: string }>;
    usage: { input_tokens: number; output_tokens: number };
  };
  const text = data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");

  return {
    text,
    inputTokens: data.usage.input_tokens,
    outputTokens: data.usage.output_tokens,
  };
}

// ---------------------------------------------------------------------------
// OpenAI-compatible client (GitHub Copilot, OpenAI)
// ---------------------------------------------------------------------------

async function promptOpenAI(
  config: BackendConfig,
  system: string,
  user: string,
  opts?: PromptOptions,
): Promise<PromptResult> {
  const model = opts?.model ?? config.model;

  // GitHub Copilot serves Chat Completions at `/chat/completions` (NO `/v1`).
  // Matches the gateway's `OPENAI_HOST_CHAT_COMPLETIONS_PATHS` for github-copilot.
  const isCopilot = config.backend === "github-copilot";
  const url = isCopilot
    ? `${config.baseUrl}/chat/completions`
    : `${config.baseUrl}/v1/chat/completions`;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${config.apiKey}`,
  };

  // GitHub Copilot wants the integration-id + api-version headers (matches the
  // gateway's `copilotHeaders`). Without these the API still accepts the call
  // today but rejects malformed ones intermittently — send them as the real
  // Copilot clients do.
  if (isCopilot) {
    headers["copilot-integration-id"] = "vscode-chat";
    headers["x-github-api-version"] = "2026-06-01";
  }

  const body: Record<string, unknown> = {
    model,
    max_tokens: opts?.maxTokens ?? 4096,
    temperature: opts?.temperature ?? 0,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };

  if (opts?.json) {
    body.response_format = { type: "json_object" };
  }

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const respBody = await resp.text();
    // Log details for debugging in CI
    if (process.env.GITHUB_ACTIONS) {
      console.error(`  API error: ${resp.status} ${url} model=${model}`);
      console.error(`  Response: ${respBody.slice(0, 300)}`);
    }
    throw new Error(
      `OpenAI API error ${resp.status}: ${respBody.slice(0, 500)}`,
    );
  }

  const data = (await resp.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage: { prompt_tokens: number; completion_tokens: number };
  };

  return {
    text: data.choices[0]?.message?.content ?? "",
    inputTokens: data.usage.prompt_tokens,
    outputTokens: data.usage.completion_tokens,
  };
}

// ---------------------------------------------------------------------------
// Create client
// ---------------------------------------------------------------------------

export function createEvalLLMClient(
  backendConfig?: BackendConfig,
): EvalLLMClient {
  const config = backendConfig ?? resolveBackend();

  // Rate limits: very conservative for GitHub Copilot (CI quota), generous for
  // direct API
  const limiter =
    config.backend === "github-copilot"
      ? new RateLimiter(1, 10_000) // ~6 req/min to stay well under Copilot's CI quota
      : new RateLimiter(5, 200);

  const promptFn =
    config.backend === "anthropic" ? promptAnthropic : promptOpenAI;

  const MAX_RETRIES = 5;

  return {
    config,
    async prompt(
      system: string,
      user: string,
      opts?: PromptOptions,
    ): Promise<PromptResult> {
      let lastError: Error | undefined;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        await limiter.acquire();
        try {
          const result = await promptFn(config, system, user, opts);
          return result;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          const msg = lastError.message;

           // Detect GitHub's anti-scraping / quota exhaustion page (HTML, not
          // JSON). NOT a transient limit — daily quota is exhausted or the
          // token lacks access. Retrying wastes quota.
          if (msg.includes("429") && msg.includes("scraping")) {
            throw new Error(
              "GitHub Models daily quota exhausted or access denied. " +
                "The API returned GitHub's anti-scraping page instead of a JSON rate-limit error. " +
                "Wait for daily quota reset or check your token's 'models' scope.",
            );
          }

          // Retry transient overload/rate-limit/5xx (429 rate limit, 529
          // overloaded — common on MiniMax/Anthropic under load — and 500/502/
          // 503) with exponential backoff. A one-off 529 must not kill a
          // multi-hour run.
           if (
             /\b(429|529|500|502|503)\b/.test(msg) ||
             /overloaded/i.test(msg)
           ) {
            const backoffMs = Math.min(
              30_000 * 2 ** attempt, // 30s, 60s, 120s, 240s, 480s
              600_000, // cap at 10 minutes
            );
            console.warn(
              `  Transient API error (attempt ${attempt + 1}/${MAX_RETRIES + 1}), backing off ${Math.round(backoffMs / 1000)}s: ${msg.slice(0, 80)}`,
            );
            limiter.backoff(backoffMs);
            await new Promise((r) => setTimeout(r, backoffMs));
            continue;
          }

          // Non-retryable error
          throw lastError;
        } finally {
          limiter.release();
        }
      }

      throw lastError ?? new Error("Max retries exceeded");
    },
  };
}
