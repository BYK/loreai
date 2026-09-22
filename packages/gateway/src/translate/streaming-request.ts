import { TokenParser, TokenType, Tokenizer } from "@streamparser/json";
import type { ParsedElementInfo, ParsedTokenInfo } from "@streamparser/json";
import {
  CHAIN_DIGEST_SEED,
  extendChainDigest,
  type ContextBoundary,
} from "@loreai/core";
import type { GatewayRequest } from "./types";

export const STREAMING_PARSE_SPOOL_BYTES = 256 * 1024;

/** Errors that must survive the generic JSON-parser error boundary. */
export class StreamedRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamedRequestError";
  }
}

/** The caller's continuation hint cannot be proven against this body. */
export class StreamedRequestBoundaryMismatchError extends StreamedRequestError {
  constructor(message = "Context boundary does not match the request") {
    super(message);
    this.name = "StreamedRequestBoundaryMismatchError";
  }
}

export interface StreamedItemsBuilder<M> {
  add(item: unknown): void;
  finish(): M;
}

export interface StreamingRequestSpec<M> {
  streamKey: string;
  captureKeys: ReadonlySet<string> | "*";
  /** A verified-prefix hint. The body then contains retained preamble + suffix. */
  contextBoundary?: ContextBoundary;
  /** Validate protocol-specific items repeated ahead of an elided suffix. */
  isRetainedItem?(item: unknown, index: number): boolean;
  /** Describe whether a new boundary can safely restart normalization. */
  describeBoundary?(
    streamed: M,
    boundary: ContextBoundary | undefined,
  ): { boundarySafe: boolean; retainedItems: number };
  createItemsBuilder(): StreamedItemsBuilder<M>;
  parseSync(raw: unknown): GatewayRequest;
  assemble(
    raw: Record<string, unknown>,
    streamed: M | undefined,
  ): GatewayRequest;
}

interface TrackedItems<M> {
  value: M;
  itemCount: number;
  inputDigest: string;
  boundarySafe: boolean;
  retainedItems: number;
}

interface TopLevelCapture {
  key: string;
  nesting: number;
  parser: TokenParser;
  value: unknown;
}

interface ActiveTopLevelValue<M> {
  key: string;
  nesting: number;
  capture?: TopLevelCapture;
  streamBuilder?: StreamedItemsBuilder<TrackedItems<M>>;
  streamItem?: TopLevelCapture;
}

type RootState =
  | "start"
  | "key-or-end"
  | "colon"
  | "value"
  | "comma-or-end"
  | "complete";

function isOpeningToken(token: TokenType): boolean {
  return token === TokenType.LEFT_BRACE || token === TokenType.LEFT_BRACKET;
}

function isClosingToken(token: TokenType): boolean {
  return token === TokenType.RIGHT_BRACE || token === TokenType.RIGHT_BRACKET;
}

function createTopLevelCapture(key: string): TopLevelCapture {
  const parser = new TokenParser({ paths: ["$"], keepStack: false });
  const capture: TopLevelCapture = {
    key,
    nesting: 0,
    parser,
    value: undefined,
  };
  parser.onValue = ({ value }: ParsedElementInfo): void => {
    capture.value = value;
  };
  return capture;
}

function feedCapture(capture: TopLevelCapture, token: ParsedTokenInfo): void {
  capture.parser.write({
    token: token.token,
    value: token.value,
    partial: token.partial,
  });
}

function finishCapture(capture: TopLevelCapture): unknown {
  if (!capture.parser.isEnded) capture.parser.end();
  return capture.value;
}

function createTrackedItemsBuilder<M>(
  spec: StreamingRequestSpec<M>,
): StreamedItemsBuilder<TrackedItems<M>> {
  const builder = spec.createItemsBuilder();
  const boundary = spec.contextBoundary;
  let itemCount = boundary?.inputItems ?? 0;
  let inputDigest = boundary?.inputDigest ?? CHAIN_DIGEST_SEED;
  let receivedItems = 0;

  return {
    add(item) {
      const receivedIndex = receivedItems++;
      if (boundary && receivedIndex < boundary.retainedItems) {
        if (!spec.isRetainedItem?.(item, receivedIndex)) {
          throw new StreamedRequestBoundaryMismatchError(
            "The retained context preamble no longer matches this protocol; retrying with the full conversation.",
          );
        }
        builder.add(item);
        return;
      }
      itemCount++;
      inputDigest = extendChainDigest(inputDigest, item);
      builder.add(item);
    },
    finish() {
      if (boundary && receivedItems < boundary.retainedItems) {
        throw new StreamedRequestBoundaryMismatchError(
          "The request ended before its retained context preamble; retrying with the full conversation.",
        );
      }
      const value = builder.finish();
      const suffixItems = receivedItems - (boundary?.retainedItems ?? 0);
      if (boundary && suffixItems === 0) {
        throw new StreamedRequestBoundaryMismatchError(
          "The checkpointed request contains no new context items; retrying with the full conversation.",
        );
      }
      const description = spec.describeBoundary?.(value, boundary) ?? {
        boundarySafe: true,
        retainedItems: 0,
      };
      return {
        value,
        itemCount,
        inputDigest,
        boundarySafe: itemCount > 0 && description.boundarySafe,
        retainedItems: description.retainedItems,
      };
    },
  };
}

function assembleTrackedRequest<M>(
  spec: StreamingRequestSpec<M>,
  raw: Record<string, unknown>,
  streamed: TrackedItems<M> | undefined,
): GatewayRequest {
  if (spec.contextBoundary && !streamed) {
    throw new StreamedRequestBoundaryMismatchError(
      `The checkpointed ${spec.streamKey} suffix is missing; retrying with the full conversation.`,
    );
  }
  const req = spec.assemble(raw, streamed?.value);
  if (streamed) {
    req.sourceInput = {
      itemCount: streamed.itemCount,
      inputDigest: streamed.inputDigest,
      boundarySafe: streamed.boundarySafe,
      retainedItems: streamed.retainedItems,
      ...(spec.contextBoundary
        ? {
            sourcePrefix: {
              messageCount: spec.contextBoundary.sourceMessages,
              sourceDigest: spec.contextBoundary.sourceDigest,
            },
          }
        : {}),
    };
  }
  return req;
}

function parseBufferedRequest<M>(
  raw: unknown,
  spec: StreamingRequestSpec<M>,
): GatewayRequest {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    const items = record[spec.streamKey];
    if (Array.isArray(items)) {
      const builder = createTrackedItemsBuilder(spec);
      for (const item of items) builder.add(item);
      const envelope = { ...record };
      delete envelope[spec.streamKey];
      return assembleTrackedRequest(spec, envelope, builder.finish());
    }
  }
  if (spec.contextBoundary) {
    throw new StreamedRequestBoundaryMismatchError(
      `The checkpointed ${spec.streamKey} is not an array; retrying with the full conversation.`,
    );
  }
  return spec.parseSync(raw);
}

async function parseStreamedRequestInternal<M>(
  chunks: AsyncIterable<Uint8Array>,
  spec: StreamingRequestSpec<M>,
  onDrain: () => void,
): Promise<GatewayRequest> {
  const raw: Record<string, unknown> = {};
  const tokenizer = new Tokenizer();
  // Tokenizer validates lexical tokens only. A TokenParser is still required
  // to enforce the JSON grammar between those tokens (colon/comma placement,
  // object keys, and a single root value). Keep no values: endpoint-specific
  // captures below own materialization.
  const validator = new TokenParser({ paths: [], keepStack: false });
  validator.onValue = (): void => {};
  const textDecoder = new TextDecoder("utf-8", { ignoreBOM: true });
  let inString = false;
  let escapingStringCharacter = false;
  let rootState: RootState = "start";
  let rootIsObject = false;
  let rootComplete = false;
  let rootDepth = 0;
  let sawToken = false;
  let rootKey: string | undefined;
  let active: ActiveTopLevelValue<M> | undefined;
  let streamed: TrackedItems<M> | undefined;
  let sawStreamKey = false;

  const finishActive = (): void => {
    if (!active) return;
    if (active.capture) raw[active.key] = finishCapture(active.capture);
    if (active.streamItem && active.streamBuilder) {
      active.streamBuilder.add(finishCapture(active.streamItem));
    }
    if (active.streamBuilder) streamed = active.streamBuilder.finish();
    active = undefined;
    rootKey = undefined;
    rootState = "comma-or-end";
  };

  const consumeStreamItemToken = (token: ParsedTokenInfo): void => {
    if (!active?.streamBuilder) return;
    if (!active.streamItem) {
      if (token.token === TokenType.RIGHT_BRACKET) {
        active.nesting = 0;
        finishActive();
        return;
      }
      if (token.token === TokenType.COMMA) return;
      active.streamItem = createTopLevelCapture(spec.streamKey);
      feedCapture(active.streamItem, token);
      active.streamItem.nesting = isOpeningToken(token.token) ? 1 : 0;
      if (active.streamItem.nesting === 0) {
        active.streamBuilder.add(finishCapture(active.streamItem));
        active.streamItem = undefined;
      }
      return;
    }
    feedCapture(active.streamItem, token);
    if (isOpeningToken(token.token)) active.streamItem.nesting += 1;
    if (isClosingToken(token.token)) active.streamItem.nesting -= 1;
    if (active.streamItem.nesting === 0) {
      active.streamBuilder.add(finishCapture(active.streamItem));
      active.streamItem = undefined;
    }
  };

  const consumeTopLevelToken = (token: ParsedTokenInfo): void => {
    if (rootState === "start") {
      if (token.token === TokenType.LEFT_BRACE) {
        rootIsObject = true;
        rootState = "key-or-end";
      }
      return;
    }

    if (active) {
      if (active.streamBuilder) {
        consumeStreamItemToken(token);
        return;
      }
      if (active.capture) feedCapture(active.capture, token);
      if (isOpeningToken(token.token)) active.nesting += 1;
      if (isClosingToken(token.token)) active.nesting -= 1;
      if (active.nesting === 0) finishActive();
      return;
    }

    switch (rootState) {
      case "key-or-end":
        if (token.token === TokenType.RIGHT_BRACE) {
          rootState = "complete";
          rootComplete = true;
        } else if (token.token === TokenType.STRING) {
          rootKey = typeof token.value === "string" ? token.value : undefined;
          rootState = "colon";
        }
        return;
      case "colon":
        if (token.token === TokenType.COLON) rootState = "value";
        return;
      case "value": {
        const key = rootKey ?? "";
        if (key === spec.streamKey) {
          if (sawStreamKey) {
            streamed = undefined;
            delete raw[spec.streamKey];
          }
          sawStreamKey = true;
        }
        const streamArray =
          key === spec.streamKey && token.token === TokenType.LEFT_BRACKET;
        const shouldCapture =
          (key === spec.streamKey && !streamArray) ||
          spec.captureKeys === "*" ||
          spec.captureKeys.has(key);
        active = {
          key,
          nesting: isOpeningToken(token.token) ? 1 : 0,
          streamBuilder: streamArray
            ? createTrackedItemsBuilder(spec)
            : undefined,
          capture:
            !streamArray && shouldCapture
              ? createTopLevelCapture(key)
              : undefined,
        };
        if (active.capture) feedCapture(active.capture, token);
        if (active.streamBuilder) return;
        if (active.nesting === 0) finishActive();
        return;
      }
      case "comma-or-end":
        if (token.token === TokenType.COMMA) {
          rootState = "key-or-end";
        } else if (token.token === TokenType.RIGHT_BRACE) {
          rootState = "complete";
          rootComplete = true;
        }
        return;
      case "complete":
        return;
    }
  };

  tokenizer.onToken = (token): void => {
    validator.write(token);
    if (rootComplete) throw new Error("Invalid JSON body");
    sawToken = true;
    consumeTopLevelToken(token);
    if (isOpeningToken(token.token)) rootDepth += 1;
    if (isClosingToken(token.token)) rootDepth -= 1;
    if (rootDepth === 0 && rootState === "start") rootComplete = true;
    if (rootDepth === 0 && token.token === TokenType.RIGHT_BRACE) {
      rootComplete = true;
    }
  };

  const write = (chunk: Uint8Array, stream: boolean): void => {
    const text = textDecoder.decode(chunk, { stream });
    for (const character of text) {
      if (inString) {
        if (escapingStringCharacter) {
          escapingStringCharacter = false;
        } else if (character === "\\") {
          escapingStringCharacter = true;
        } else if (character === '"') {
          inString = false;
        }
      } else if (character === "\uFEFF") {
        throw new Error("Invalid JSON body");
      } else if (character === '"') {
        inString = true;
      }
    }
    if (text) tokenizer.write(Buffer.from(text, "utf8"));
  };

  const iterator = chunks[Symbol.asyncIterator]();
  let parseError: unknown;
  let draining = false;
  const drain = (): void => {
    draining = true;
    onDrain();
    void (async () => {
      try {
        while (!(await iterator.next()).done) {
          // Keep Node's request body flowing so the handler can return a 400.
        }
      } catch {
        // The public error is already fixed; decoder cleanup is best effort.
      } finally {
        void iterator.return?.(undefined);
      }
    })();
  };
  try {
    while (true) {
      const { done, value } = await iterator.next();
      if (done) break;
      if (parseError) continue;
      try {
        write(value, true);
      } catch (error) {
        parseError = error;
        drain();
        break;
      }
    }
  } finally {
    if (!draining) void iterator.return?.(undefined);
  }
  if (!parseError) {
    try {
      write(new Uint8Array(), false);
      tokenizer.end();
      if (!validator.isEnded) validator.end();
    } catch (error) {
      parseError =
        error instanceof Error ? error : new Error("Invalid JSON body");
    }
  }
  if (parseError instanceof StreamedRequestError) throw parseError;
  if (parseError || !sawToken || active || !tokenizer.isEnded) {
    throw new Error("Invalid JSON body");
  }
  if (rootIsObject && !rootComplete) throw new Error("Invalid JSON body");
  return assembleTrackedRequest(spec, rootIsObject ? raw : {}, streamed);
}

export async function parseStreamedRequest<M>(
  chunks: AsyncIterable<Uint8Array>,
  spec: StreamingRequestSpec<M>,
): Promise<GatewayRequest> {
  if (spec.contextBoundary) {
    return parseStreamedRequestInternal(chunks, spec, () => {});
  }
  const iterator = chunks[Symbol.asyncIterator]();
  const spool: Uint8Array[] = [];
  let total = 0;
  let handedOff = false;
  let draining = false;
  try {
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        const raw = JSON.parse(Buffer.concat(spool, total).toString("utf8"));
        return parseBufferedRequest(raw, spec);
      }
      total += next.value.byteLength;
      spool.push(next.value);
      if (total > STREAMING_PARSE_SPOOL_BYTES) {
        async function* replay(): AsyncGenerator<Uint8Array> {
          try {
            yield* spool;
            while (true) {
              const remaining = await iterator.next();
              if (remaining.done) return;
              yield remaining.value;
            }
          } finally {
            void iterator.return?.(undefined);
          }
        }
        handedOff = true;
        try {
          return await parseStreamedRequestInternal(replay(), spec, () => {
            draining = true;
          });
        } finally {
          handedOff = false;
        }
      }
    }
  } finally {
    if (!handedOff && !draining) void iterator.return?.(undefined);
  }
}
