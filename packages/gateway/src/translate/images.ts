import type { GatewayProtocol } from "./types";
import { InvalidCrossProviderRequestError } from "./errors";

const DATA_IMAGE =
  /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/i;

function allowFields(
  raw: Record<string, unknown>,
  fields: readonly string[],
): void {
  if (Object.keys(raw).some((key) => !fields.includes(key))) {
    throw new InvalidCrossProviderRequestError();
  }
}

/** Conversions must not silently discard any source image control. */
function assertImageShape(
  raw: Record<string, unknown>,
  source: GatewayProtocol,
  target: "anthropic" | "openai-responses",
): void {
  // A native destination can normalize foreign image blocks in its own input.
  // A Chat image part, however, always has the image_url object shape; never
  // launder a Responses part through a Chat-to-provider conversion.
  if (
    (source === "openai" && raw.type !== "image_url") ||
    (source !== target &&
      ((source === "anthropic" && raw.type !== "image") ||
        (source === "openai-responses" && raw.type !== "input_image") ||
        (source === "gemini" && raw.inlineData === undefined)))
  ) {
    throw new InvalidCrossProviderRequestError();
  }
  if (raw.type === "image_url") {
    allowFields(raw, ["type", "image_url"]);
    const image = raw.image_url;
    if (!image || typeof image !== "object" || Array.isArray(image)) {
      throw new InvalidCrossProviderRequestError();
    }
    allowFields(image as Record<string, unknown>, ["url", "detail"]);
  } else if (raw.type === "input_image") {
    allowFields(raw, ["type", "image_url", "detail"]);
    const image = raw.image_url;
    if (image && typeof image === "object" && !Array.isArray(image)) {
      allowFields(image as Record<string, unknown>, ["url"]);
    }
  } else if (raw.type === "image") {
    allowFields(raw, ["type", "source"]);
    const source = raw.source;
    if (source && typeof source === "object" && !Array.isArray(source)) {
      const value = source as Record<string, unknown>;
      if (value.type === "base64") {
        allowFields(value, ["type", "media_type", "data"]);
      } else if (value.type === "url") {
        allowFields(value, ["type", "url"]);
      }
    }
  } else if (raw.inlineData !== undefined) {
    allowFields(raw, ["inlineData"]);
    const image = raw.inlineData;
    if (image && typeof image === "object" && !Array.isArray(image)) {
      allowFields(image as Record<string, unknown>, ["mimeType", "data"]);
    }
  } else {
    throw new InvalidCrossProviderRequestError();
  }
}

function imageURL(raw: Record<string, unknown>): string {
  if (raw.type === "image_url" || raw.type === "input_image") {
    const value = raw.image_url;
    if (typeof value === "string") return value;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const url = (value as Record<string, unknown>).url;
      if (typeof url === "string") return url;
    }
  }
  if (raw.type === "image") {
    const source = raw.source;
    if (source && typeof source === "object" && !Array.isArray(source)) {
      const value = source as Record<string, unknown>;
      if (
        value.type === "base64" &&
        typeof value.media_type === "string" &&
        typeof value.data === "string"
      ) {
        return `data:${value.media_type};base64,${value.data}`;
      }
      if (value.type === "url" && typeof value.url === "string") {
        return value.url;
      }
    }
  }
  if (
    raw.inlineData &&
    typeof raw.inlineData === "object" &&
    !Array.isArray(raw.inlineData)
  ) {
    const value = raw.inlineData as Record<string, unknown>;
    if (typeof value.mimeType === "string" && typeof value.data === "string") {
      return `data:${value.mimeType};base64,${value.data}`;
    }
  }
  throw new InvalidCrossProviderRequestError();
}

function supportedImageURL(value: string): string {
  const encoded = DATA_IMAGE.exec(value);
  if (
    encoded &&
    Buffer.from(encoded[2], "base64").toString("base64") === encoded[2]
  )
    return value;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password)
      return value;
  } catch {
    // An unsupported image must never be forwarded in another provider's wire format.
  }
  throw new InvalidCrossProviderRequestError();
}

function imageDetail(raw: Record<string, unknown>): unknown {
  if (raw.type === "input_image") return raw.detail;
  const image = raw.image_url;
  if (image && typeof image === "object" && !Array.isArray(image)) {
    return (image as Record<string, unknown>).detail;
  }
  return undefined;
}

export function toAnthropicImage(
  raw: Record<string, unknown>,
  source: GatewayProtocol,
): Record<string, unknown> {
  if (source === "anthropic" && raw.type === "image") return { ...raw };
  assertImageShape(raw, source, "anthropic");
  if (
    source === "openai-responses" &&
    raw.type === "input_image" &&
    typeof raw.image_url !== "string"
  ) {
    throw new InvalidCrossProviderRequestError();
  }
  const detail = imageDetail(raw);
  if (detail !== undefined && detail !== "auto") {
    throw new InvalidCrossProviderRequestError();
  }
  const url = supportedImageURL(imageURL(raw));
  const encoded = DATA_IMAGE.exec(url);
  return {
    type: "image",
    source: encoded
      ? {
          type: "base64",
          media_type: encoded[1].toLowerCase(),
          data: encoded[2],
        }
      : { type: "url", url },
  };
}

export function toResponsesImage(
  raw: Record<string, unknown>,
  source: GatewayProtocol,
): Record<string, unknown> {
  if (source === "openai-responses" && raw.type === "input_image") {
    if (raw.image_url === undefined) {
      allowFields(raw, ["type", "file_id", "detail"]);
      if (typeof raw.file_id !== "string" || !raw.file_id) {
        throw new InvalidCrossProviderRequestError();
      }
    } else {
      assertImageShape(raw, source, "openai-responses");
      if (typeof raw.image_url !== "string") {
        throw new InvalidCrossProviderRequestError();
      }
      supportedImageURL(raw.image_url);
    }
    if (
      raw.detail !== undefined &&
      raw.detail !== "auto" &&
      raw.detail !== "low" &&
      raw.detail !== "high" &&
      raw.detail !== "original"
    ) {
      throw new InvalidCrossProviderRequestError();
    }
    return { ...raw };
  }
  assertImageShape(raw, source, "openai-responses");
  const requestedDetail = imageDetail(raw);
  if (
    requestedDetail !== undefined &&
    requestedDetail !== "auto" &&
    requestedDetail !== "low" &&
    requestedDetail !== "high" &&
    requestedDetail !== "original"
  ) {
    throw new InvalidCrossProviderRequestError();
  }
  return {
    type: "input_image",
    image_url: supportedImageURL(imageURL(raw)),
    detail: requestedDetail ?? "auto",
  };
}

export function isImageBlock(raw: Record<string, unknown>): boolean {
  return (
    raw.type === "image" ||
    raw.type === "image_url" ||
    raw.type === "input_image" ||
    raw.inlineData !== undefined ||
    raw.fileData !== undefined
  );
}
