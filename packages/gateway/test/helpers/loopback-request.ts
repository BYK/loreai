import { request as httpRequest } from "node:http";
import { isIP } from "node:net";
import { Readable } from "node:stream";

export interface LoopbackRequestInit {
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | Uint8Array<ArrayBufferLike> | null;
}

export async function loopbackRequest(
  input: string | URL,
  init: LoopbackRequestInit = {},
): Promise<Response> {
  const url = input instanceof URL ? input : new URL(input);
  if (url.protocol !== "http:") {
    throw new Error(`loopbackRequest requires http, received ${url.protocol}`);
  }
  const hostname =
    url.hostname.startsWith("[") && url.hostname.endsWith("]")
      ? url.hostname.slice(1, -1)
      : url.hostname;
  if (
    hostname !== "localhost" &&
    hostname !== "::1" &&
    !(isIP(hostname) === 4 && hostname.startsWith("127."))
  ) {
    throw new Error(
      `loopbackRequest requires a loopback host, received ${hostname}`,
    );
  }
  let body: string | Uint8Array | undefined;
  if (typeof init.body === "string") body = init.body;
  else if (init.body instanceof URLSearchParams) body = init.body.toString();
  else if (init.body instanceof Blob) {
    body = new Uint8Array(await init.body.arrayBuffer());
  } else if (init.body instanceof ArrayBuffer) body = new Uint8Array(init.body);
  else if (ArrayBuffer.isView(init.body)) {
    body = new Uint8Array(
      init.body.buffer,
      init.body.byteOffset,
      init.body.byteLength,
    );
  } else if (init.body != null) {
    throw new Error(
      "loopbackRequest does not support streaming or FormData bodies",
    );
  }
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  if (body !== undefined && headers["content-length"] === undefined) {
    headers["content-length"] = String(
      typeof body === "string" ? Buffer.byteLength(body) : body.byteLength,
    );
  }
  const method = init.method ?? "GET";
  return new Promise<Response>((resolve, reject) => {
    const outgoing = httpRequest(
      {
        hostname,
        port: url.port ? Number(url.port) : 80,
        path: `${url.pathname}${url.search}`,
        method,
        headers,
      },
      (incoming) => {
        const status = incoming.statusCode ?? 500;
        const responseHeaders = new Headers();
        for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
          responseHeaders.append(
            incoming.rawHeaders[i],
            incoming.rawHeaders[i + 1],
          );
        }
        const hasBody =
          method.toUpperCase() !== "HEAD" &&
          status !== 204 &&
          status !== 205 &&
          status !== 304;
        if (!hasBody) incoming.resume();
        resolve(
          new Response(
            hasBody
              ? (Readable.toWeb(
                  incoming,
                ) as unknown as ReadableStream<Uint8Array>)
              : null,
            {
              status,
              statusText: incoming.statusMessage,
              headers: responseHeaders,
            },
          ),
        );
      },
    );
    outgoing.once("error", reject);
    outgoing.end(body);
  });
}
