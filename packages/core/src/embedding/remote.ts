/** Remote embedding providers. */

import { EmbeddingProviderError, type EmbeddingProvider } from "./contract";

const EMBED_TIMEOUT_MS = 10_000;

const VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings";

type VoyageResponse = {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage: { total_tokens: number };
};

export class VoyageProvider implements EmbeddingProvider {
  readonly maxBatchSize = 128;
  private apiKey: string;
  private model: string;
  private dimensions: number;

  constructor(apiKey: string, model: string, dimensions: number) {
    this.apiKey = apiKey;
    this.model = model;
    this.dimensions = dimensions;
  }

  async embed(
    texts: string[],
    inputType: "document" | "query",
    signal?: AbortSignal,
  ): Promise<Float32Array[]> {
    let res: Response;
    try {
      res = await fetch(VOYAGE_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          input: texts,
          model: this.model,
          input_type: inputType,
          output_dimension: this.dimensions,
        }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(EMBED_TIMEOUT_MS)])
          : AbortSignal.timeout(EMBED_TIMEOUT_MS),
      });
    } catch {
      throw new EmbeddingProviderError("Voyage embeddings API request failed");
    }

    if (!res.ok) {
      throw new EmbeddingProviderError(
        `Voyage embeddings API failed with HTTP ${res.status}`,
        res.status,
      );
    }

    try {
      const json = (await res.json()) as VoyageResponse;
      const sorted = [...json.data].sort((a, b) => a.index - b.index);
      return sorted.map((d) => new Float32Array(d.embedding));
    } catch {
      throw new EmbeddingProviderError(
        "Voyage embeddings API returned malformed JSON",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// OpenAI provider
// ---------------------------------------------------------------------------

const OPENAI_API_URL = "https://api.openai.com/v1/embeddings";

type OpenAIResponse = {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
};

export class OpenAIProvider implements EmbeddingProvider {
  readonly maxBatchSize = 2048;
  private apiKey: string;
  private model: string;
  private dimensions: number;

  constructor(apiKey: string, model: string, dimensions: number) {
    this.apiKey = apiKey;
    this.model = model;
    this.dimensions = dimensions;
  }

  async embed(
    texts: string[],
    _inputType: "document" | "query",
    signal?: AbortSignal,
  ): Promise<Float32Array[]> {
    const body: Record<string, unknown> = {
      input: texts,
      model: this.model,
    };
    // OpenAI supports dimensions parameter for text-embedding-3-* models
    if (this.model.startsWith("text-embedding-3")) {
      body.dimensions = this.dimensions;
    }

    let res: Response;
    try {
      res = await fetch(OPENAI_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(EMBED_TIMEOUT_MS)])
          : AbortSignal.timeout(EMBED_TIMEOUT_MS),
      });
    } catch {
      throw new EmbeddingProviderError("OpenAI embeddings API request failed");
    }

    if (!res.ok) {
      throw new EmbeddingProviderError("OpenAI embeddings API request failed");
    }

    try {
      const json = (await res.json()) as OpenAIResponse;
      const sorted = [...json.data].sort((a, b) => a.index - b.index);
      return sorted.map((d) => new Float32Array(d.embedding));
    } catch {
      throw new EmbeddingProviderError(
        "OpenAI embeddings API returned malformed JSON",
      );
    }
  }
}

const PROVIDER_DEFAULTS = {
  voyage: { model: "voyage-code-3", dimensions: 1024 },
  openai: { model: "text-embedding-3-small", dimensions: 1536 },
} as const;

function validApiKey(key: string): boolean {
  const trimmed = key.trim();
  return trimmed.length >= 20 && !/\s/.test(trimmed);
}

export function createRemoteProvider(
  name: "voyage" | "openai",
  model: string,
  dimensions: number,
): EmbeddingProvider | null {
  const key =
    process.env[name === "voyage" ? "VOYAGE_API_KEY" : "OPENAI_API_KEY"];
  if (!key) return null;
  return name === "voyage"
    ? new VoyageProvider(key, model, dimensions)
    : new OpenAIProvider(key, model, dimensions);
}

/** Prefer Voyage when both supported remote credentials are available. */
export function pickRemoteFallback(): {
  name: "voyage" | "openai";
  provider: EmbeddingProvider;
} | null {
  for (const name of ["voyage", "openai"] as const) {
    const key =
      process.env[name === "voyage" ? "VOYAGE_API_KEY" : "OPENAI_API_KEY"];
    if (!key || !validApiKey(key)) continue;
    const defaults = PROVIDER_DEFAULTS[name];
    return {
      name,
      provider:
        name === "voyage"
          ? new VoyageProvider(key, defaults.model, defaults.dimensions)
          : new OpenAIProvider(key, defaults.model, defaults.dimensions),
    };
  }
  return null;
}
