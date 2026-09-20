import { TokenParser, TokenType, Tokenizer } from "@streamparser/json";
import type { ParsedElementInfo, ParsedTokenInfo } from "@streamparser/json";
import type { GatewayRequest } from "./types";

export const STREAMING_PARSE_SPOOL_BYTES = 256 * 1024;

export interface StreamedItemsBuilder<M> {
  add(item: unknown): void;
  finish(): M;
}

export interface StreamingRequestSpec<M> {
  streamKey: string;
  captureKeys: ReadonlySet<string> | "*";
  createItemsBuilder(): StreamedItemsBuilder<M>;
  parseSync(raw: unknown): GatewayRequest;
  assemble(
    raw: Record<string, unknown>,
    streamed: M | undefined,
  ): GatewayRequest;
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
  streamBuilder?: StreamedItemsBuilder<M>;
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

function normaliseSyncBody(raw: unknown): unknown {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? raw
    : {};
}

async function parseStreamedRequestInternal<M>(
  chunks: AsyncIterable<Uint8Array>,
  spec: StreamingRequestSpec<M>,
  onDrain: () => void,
): Promise<GatewayRequest> {
  const raw: Record<string, unknown> = {};
  const tokenizer = new Tokenizer();
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
  let streamed: M | undefined;
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
          streamBuilder: streamArray ? spec.createItemsBuilder() : undefined,
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
    } catch (error) {
      parseError =
        error instanceof Error ? error : new Error("Invalid JSON body");
    }
  }
  if (parseError || !sawToken || active || !tokenizer.isEnded) {
    throw new Error("Invalid JSON body");
  }
  if (rootIsObject && !rootComplete) throw new Error("Invalid JSON body");
  return spec.assemble(rootIsObject ? raw : {}, streamed);
}

export async function parseStreamedRequest<M>(
  chunks: AsyncIterable<Uint8Array>,
  spec: StreamingRequestSpec<M>,
): Promise<GatewayRequest> {
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
        return spec.parseSync(normaliseSyncBody(raw));
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
