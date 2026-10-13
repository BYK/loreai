import {
  estimateTokens,
  formatKnowledge,
  formatKnowledgeEntry,
} from "@loreai/core";
import type { GatewayMessage } from "./translate/types";
import { knowledgeRecallToken } from "./knowledge-recall-token";

export type KnowledgeDeliveryState = "full" | "hint" | "absent" | "ambiguous";

export type KnowledgeDeliveryCandidate = {
  id: string;
  category: string;
  title: string;
  content: string;
  /** Surfaced handles already verified by the caller against the same
   * tenant-scoped logical identity. Never infer aliases from similar text. */
  surfacedIds?: readonly string[];
};

/** Aggregate-only measurement of the outgoing message array, never selectors.
 * Token totals are text estimates, not provider billing or cache-use measurements.
 * Callers must measure the final upstream array and record real usage separately.
 */
export function measureKnowledgeDelivery(
  messages: readonly GatewayMessage[],
  entries: readonly KnowledgeDeliveryCandidate[],
  sessionToken: string,
  model?: { providerID?: string; modelID?: string },
): {
  states: KnowledgeDeliveryState[];
  full: number;
  hintOnly: number;
  absent: number;
  ambiguous: number;
  blocks: number;
  deltaTextTokens: number;
  fullTextTokens: number;
  hintTextTokens: number;
} {
  const prefix = `[Lore knowledge update — session token: lore-ctx-${sessionToken}.]`;
  const hintHeading =
    "\n## Other relevant knowledge (recall by id for detail)\n";
  const payloads: Array<{
    sections: Array<{ heading: string; text: string }>;
    hints: string;
  }> = [];
  const totals = {
    blocks: 0,
    deltaTextTokens: 0,
    fullTextTokens: 0,
    hintTextTokens: 0,
  };
  const textOf = (message: GatewayMessage): string =>
    message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
  for (const [index, message] of messages.entries()) {
    const next = messages[index + 1];
    if (message.role !== "user" || next?.role !== "assistant") continue;
    const text = textOf(message);
    const closer = textOf(next);
    if (
      !text.startsWith(`${prefix}\n`) ||
      !["*🧠 Refreshed memory*", "[memory refreshed]"].includes(closer)
    )
      continue;
    const section = (heading: string, input = text): string => {
      const start = input.indexOf(heading, prefix.length);
      if (start < 0) return "";
      const bodyStart = start + heading.length;
      // Both owned H2 sections stop at the next H1/H2, including Markdown's
      // allowed indentation. Later categories or hints belong to that sibling,
      // never to this section's delivery proof or token estimate.
      const end = input.slice(bodyStart).search(/^ {0,3}#{1,2}(?:[ \t]|$)/m);
      return input.slice(start, end < 0 ? undefined : bodyStart + end);
    };
    // Hint titles retain newlines, so even a full-section opening inside a
    // hint is untrusted for full delivery. Bound discovery, not just its end.
    const hintStart = text.indexOf(hintHeading, prefix.length);
    const full = section(
      "\n## Long-term Knowledge\n",
      hintStart < 0 ? text : text.slice(0, hintStart),
    );
    const hints = section(hintHeading);
    // A category ends at the next heading of the same or higher level. The
    // renderer flattens entry text, so its bullets cannot introduce headings.
    const headings = [...full.matchAll(/^#{1,3}(?:[ \t].*)?$/gm)];
    const sections = headings.flatMap((heading, index) =>
      /^###(?:[ \t]|$)/.test(heading[0])
        ? [
            {
              heading: heading[0],
              text: full.slice(
                heading.index + heading[0].length,
                headings[index + 1]?.index,
              ),
            },
          ]
        : [],
    );
    payloads.push({ sections, hints });
    totals.blocks++;
    totals.deltaTextTokens +=
      estimateTokens(text, model) + estimateTokens(closer, model);
    totals.fullTextTokens += estimateTokens(full, model);
    totals.hintTextTokens += estimateTokens(hints, model);
  }
  const handles = entries.map((entry) => [
    ...new Set([entry.id, ...(entry.surfacedIds ?? [])]),
  ]);
  const categoryHeadings = entries.map((entry) => {
    // Share the renderer's category escaping without serializing a large body.
    const heading = formatKnowledge([
      { category: entry.category, title: "", content: "" },
    ]).match(/^###(?:[ \t].*)?$/m)?.[0];
    if (heading === undefined)
      throw new Error("Missing knowledge category heading");
    return heading;
  });
  const bullets = entries.map((entry, index) =>
    handles[index].map((id) => `\n${formatKnowledgeEntry({ ...entry, id })}\n`),
  );
  const ownerKey = (index: number, bullet: string): string =>
    JSON.stringify([categoryHeadings[index], bullet]);
  const owners = new Map<string, Set<string>>();
  for (const [index, entry] of entries.entries()) {
    for (const bullet of bullets[index]) {
      const key = ownerKey(index, bullet);
      const set = owners.get(key) ?? new Set<string>();
      set.add(entry.id);
      owners.set(key, set);
    }
  }
  const states: KnowledgeDeliveryState[] = entries.map((entry, index) => {
    // A short-handle collision must never turn one visible bullet into proof
    // that two different candidates in one category were fully delivered.
    // Category headings distinguish otherwise identical bullets; hints use full IDs.
    const delivered = bullets[index].filter((bullet) =>
      payloads.some((payload) =>
        payload.sections.some(
          (section) =>
            section.heading === categoryHeadings[index] &&
            section.text.includes(bullet),
        ),
      ),
    );
    if (delivered.length > 0) {
      return delivered.some(
        (bullet) => (owners.get(ownerKey(index, bullet))?.size ?? 0) === 1,
      )
        ? "full"
        : "ambiguous";
    }
    return payloads.some((payload) =>
      handles[index].some((id) =>
        payload.hints.includes(
          `\n* [${knowledgeRecallToken({ ...entry, id })}] `,
        ),
      ),
    )
      ? "hint"
      : "absent";
  });
  return {
    states,
    full: states.filter((state) => state === "full").length,
    hintOnly: states.filter((state) => state === "hint").length,
    absent: states.filter((state) => state === "absent").length,
    ambiguous: states.filter((state) => state === "ambiguous").length,
    ...totals,
  };
}
