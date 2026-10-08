import type { GatewayContentBlock, GatewayMessage } from "./translate/types";
import { InvalidCrossProviderRequestError } from "./translate/errors";

type UserProvenance = Pick<
  GatewayMessage,
  "content" | "provenanceContent" | "provenancePositions"
>;

/** Carry edited visible text into a native user envelope without losing metadata. */
export function projectNativeUserProvenance(
  source: UserProvenance,
  content: GatewayContentBlock[],
  sourceIndexes: readonly number[] = content.map((_block, index) => index),
): UserProvenance {
  const envelope = source.provenanceContent?.[0];
  if (
    source.provenanceContent?.length !== 1 ||
    envelope?.type !== "opaque" ||
    !envelope.responsesItem ||
    !envelope.requestOnly ||
    envelope.raw.role !== "user" ||
    (envelope.raw.type !== undefined && envelope.raw.type !== "message") ||
    sourceIndexes.length !== content.length ||
    sourceIndexes.some(
      (index, position) =>
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= source.content.length ||
        (position > 0 && index <= sourceIndexes[position - 1]),
    )
  ) {
    throw new InvalidCrossProviderRequestError();
  }

  const raw = envelope.raw;
  const editedBySource = new Map(
    sourceIndexes.map((index, position) => [index, content[position]]),
  );
  let projected: unknown;
  if (typeof raw.content === "string") {
    const original = source.content[0];
    const edited = editedBySource.get(0);
    if (
      content.length !== 1 ||
      original?.type !== "text" ||
      edited?.type !== "text" ||
      original.text !== raw.content
    ) {
      throw new InvalidCrossProviderRequestError();
    }
    projected = edited.text;
  } else if (Array.isArray(raw.content)) {
    let index = 0;
    projected = raw.content.map((value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new InvalidCrossProviderRequestError();
      }
      const part = value as Record<string, unknown>;
      if (["input_text", "output_text", "text"].includes(String(part.type))) {
        if (typeof part.text !== "string") {
          throw new InvalidCrossProviderRequestError();
        }
        // Ingress does not project ordinary empty text parts into visible
        // content. Keep their wire positions and metadata unchanged.
        const hasAnnotations =
          Array.isArray(part.annotations) && part.annotations.length > 0;
        if (part.text === "" && !hasAnnotations) return value;
        const original = source.content[index];
        const edited = editedBySource.get(index++);
        if (
          original?.type !== "text" ||
          (edited !== undefined && edited.type !== "text") ||
          original.text !== part.text ||
          // Citations can refer to offsets in the original text. Editing
          // that text would leave stale metadata; reject rather than drop it.
          (hasAnnotations &&
            (edited?.type !== "text" || edited.text !== original.text))
        ) {
          throw new InvalidCrossProviderRequestError();
        }
        // Cleanup can remove a plain text part. Its original ID anchors the
        // other edits; retain this wire slot as empty rather than shifting
        // their types or metadata onto a neighboring source part.
        return { ...part, text: edited?.type === "text" ? edited.text : "" };
      }
      const original = source.content[index];
      const edited = editedBySource.get(index++);
      if (
        original?.type !== "opaque" ||
        JSON.stringify(original.raw) !== JSON.stringify(part) ||
        JSON.stringify(original) !== JSON.stringify(edited)
      ) {
        throw new InvalidCrossProviderRequestError();
      }
      return value;
    });
    if (index !== source.content.length) {
      throw new InvalidCrossProviderRequestError();
    }
  } else {
    throw new InvalidCrossProviderRequestError();
  }
  return {
    ...source,
    content,
    provenancePositions: content.map(() => 0),
    provenanceContent: [{ ...envelope, raw: { ...raw, content: projected } }],
  };
}
