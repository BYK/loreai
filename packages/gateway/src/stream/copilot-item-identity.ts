import type { ResponsesAccState } from "./openai-responses";
import { log } from "@loreai/core";
import { isDeepStrictEqual } from "node:util";

type IdentityCheck = "alias_owner_conflict" | "alias_reserved" | "alias_limit";

class CopilotItemIdentityError extends Error {
  constructor(
    check: IdentityCheck,
    readonly structure: string,
  ) {
    super(`Copilot Responses identity ${check}`);
  }
}

/** Copilot keeps output_index stable while provider item IDs rotate per event. */
export function createCopilotItemIdentityNormalizer(
  maxAliases: number,
  reserved: (state: ResponsesAccState, id: string) => boolean,
  reserve: (state: ResponsesAccState, id: string, index: number) => void,
) {
  const states = new WeakMap<
    ResponsesAccState,
    {
      aliases: Map<string, number>;
      done: Set<number>;
    }
  >();
  return (
    state: ResponsesAccState,
    event: string,
    parsed: Record<string, unknown>,
  ): boolean => {
    let identities = states.get(state);
    if (!identities) {
      identities = { aliases: new Map(), done: new Set() };
      states.set(state, identities);
    }
    const { aliases, done } = identities;
    const reject = (
      check: IdentityCheck,
      id: unknown,
      index: number,
    ): never => {
      const shape = (value: unknown): string =>
        value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
      const declared = state.rawItems.get(index);
      const owner = typeof id === "string" ? aliases.get(id) : undefined;
      const eventLabel =
        /^response\.(?:function_call_arguments\.(?:delta|done)|output_item\.done|content_part\.(?:added|done)|output_text\.(?:delta|done)|refusal\.(?:delta|done)|reasoning_(?:text\.(?:delta|done)|summary_(?:text\.(?:delta|done)|part\.(?:added|done))))$/.test(
          event,
        )
          ? event
          : "other";
      const kind =
        declared?.type === "message" ||
        declared?.type === "reasoning" ||
        declared?.type === "function_call"
          ? declared.type
          : "other";
      const validIndex = (value: unknown): boolean =>
        Number.isSafeInteger(value) &&
        (value as number) >= 0 &&
        (value as number) < maxAliases;
      const structure = `check=copilot_${check} event=${eventLabel} index=${shape(parsed.output_index)} index_valid=${validIndex(index)} declared=${!!declared} kind=${kind} id=${shape(id)} id_empty=${id === ""} canonical_match=${id === declared?.id} alias_known=${owner !== undefined} alias_owner_match=${owner === index} aliases=${aliases.size} items=${state.rawItems.size} limit=${maxAliases} content_index=${shape(parsed.content_index)} content_index_valid=${validIndex(parsed.content_index)} summary_index=${shape(parsed.summary_index)} summary_index_valid=${validIndex(parsed.summary_index)} delta=${shape(parsed.delta)} text=${shape(parsed.text)}`;
      // These are fixed codes, shapes, equality flags and bounded counts only.
      try {
        log.info(`responses-validation check=copilot_${check}`);
        log.info(`responses-normalizer ${structure}`);
      } catch {
        // Diagnostics must not replace the protocol rejection.
      }
      throw new CopilotItemIdentityError(check, structure);
    };
    const canonicalId = (id: unknown, index: number): unknown => {
      const declared = state.rawItems.get(index);
      if (
        !declared ||
        !["message", "reasoning", "function_call"].includes(
          declared.type as string,
        ) ||
        typeof id !== "string" ||
        !id ||
        id === declared.id
      )
        return id;
      const owner = aliases.get(id);
      if (owner !== undefined && owner !== index)
        reject("alias_owner_conflict", id, index);
      if (owner === undefined) {
        if (reserved(state, id)) reject("alias_reserved", id, index);
        if (aliases.size >= maxAliases) reject("alias_limit", id, index);
        aliases.set(id, index);
        reserve(state, id, index);
      }
      return declared.id;
    };
    let changed = false;
    const index = parsed.output_index;
    if (
      Number.isSafeInteger(index) &&
      (index as number) >= 0 &&
      (index as number) < maxAliases
    ) {
      const outputIndex = index as number;
      const declared = state.rawItems.get(outputIndex);
      const item = parsed.item as Record<string, unknown> | undefined;
      if (
        event === "response.output_item.done" &&
        item &&
        item.type === declared?.type
      ) {
        const id = canonicalId(item.id, outputIndex);
        if (id !== item.id) {
          parsed.item = { ...item, id };
          changed = true;
        }
        done.add(outputIndex);
      } else if (
        /^response\.(?:function_call_arguments\.(?:delta|done)|content_part\.(?:added|done)|output_text\.(?:delta|done)|refusal\.(?:delta|done)|reasoning_(?:text\.(?:delta|done)|summary_(?:text\.(?:delta|done)|part\.(?:added|done))))$/.test(
          event,
        )
      ) {
        const id = canonicalId(parsed.item_id, outputIndex);
        if (id !== parsed.item_id) {
          parsed.item_id = id;
          changed = true;
        }
      }
    }
    if (
      [
        "response.completed",
        "response.done",
        "response.incomplete",
        "response.failed",
      ].includes(event)
    ) {
      const response = parsed.response as Record<string, unknown> | undefined;
      if (!Array.isArray(response?.output)) {
        try {
          log.info(
            `responses-terminal output_array=false output_missing=${response?.output === undefined} output_null=${response?.output === null} expected_count=${state.rawItems.size}`,
          );
        } catch {
          /* Preserve validation even if diagnostics fail. */
        }
      }
      if (Array.isArray(response?.output)) {
        const expected = [...state.rawItems.entries()].sort(
          ([a], [b]) => a - b,
        );
        const complete =
          response.output.length === expected.length &&
          expected.every(([index]) => done.has(index));
        response.output = response.output.map(
          (item: unknown, position: number) => {
            if (!item || typeof item !== "object" || Array.isArray(item))
              return item;
            const record = item as Record<string, unknown>;
            const owner =
              typeof record.id === "string"
                ? aliases.get(record.id)
                : undefined;
            const positional = expected[position];
            if (
              complete &&
              positional &&
              typeof record.id === "string" &&
              record.id
            ) {
              const [index, streamed] = positional;
              // Keep replayable done ciphertext authoritative if Copilot re-encrypts
              // the otherwise identical completed reasoning snapshot.
              const reconciled =
                event === "response.completed" &&
                response.status === "completed" &&
                streamed.type === "reasoning" &&
                (streamed.status === "completed" ||
                  (streamed.status === undefined &&
                    record.status === undefined)) &&
                typeof streamed.encrypted_content === "string" &&
                typeof record.encrypted_content === "string"
                  ? { ...record, encrypted_content: streamed.encrypted_content }
                  : record;
              const { id: _actualId, ...actualEnvelope } = reconciled;
              const { id: _streamedId, ...streamedEnvelope } = streamed;
              if (
                (streamed.type === "message" ||
                  streamed.type === "reasoning" ||
                  streamed.type === "function_call") &&
                isDeepStrictEqual(actualEnvelope, streamedEnvelope)
              ) {
                const id = canonicalId(record.id, index);
                changed ||= id !== record.id || reconciled !== record;
                return { ...reconciled, id };
              }
            }
            const declared =
              owner === undefined ? undefined : state.rawItems.get(owner);
            if (
              !declared ||
              (record.type !== declared.type &&
                record.type !== "item_reference")
            )
              return item;
            changed = true;
            return { ...record, id: declared.id };
          },
        );
        const output = response.output as unknown[];
        const mismatch = output.findIndex((item, position) => {
          const streamed = expected[position]?.[1];
          if (
            !item ||
            typeof item !== "object" ||
            Array.isArray(item) ||
            !streamed
          )
            return true;
          const record = item as Record<string, unknown>;
          return record.type === "item_reference"
            ? record.id !== streamed.id ||
                Object.keys(record).some(
                  (key) => key !== "type" && key !== "id",
                )
            : !isDeepStrictEqual(record, streamed);
        });
        if (mismatch >= 0 || output.length !== expected.length) {
          const position =
            mismatch >= 0 ? mismatch : Math.min(output.length, expected.length);
          const value = output[position];
          const actual =
            value && typeof value === "object" && !Array.isArray(value)
              ? (value as Record<string, unknown>)
              : {};
          const streamed = expected[position]?.[1] ?? {};
          const equal = [
            "id",
            "type",
            "status",
            "role",
            "call_id",
            "name",
            "arguments",
            "content",
            "summary",
            "encrypted_content",
          ]
            .map(
              (field) =>
                `${field}_equal=${isDeepStrictEqual(actual[field], streamed[field])}`,
            )
            .join(" ");
          const textEqual = (field: string) => {
            const parts = (item: Record<string, unknown>) =>
              Array.isArray(item[field])
                ? (item[field] as unknown[]).map((part) =>
                    part && typeof part === "object"
                      ? (part as Record<string, unknown>).text
                      : undefined,
                  )
                : item[field];
            return isDeepStrictEqual(parts(actual), parts(streamed));
          };
          const shape = (value: unknown): string =>
            value === null
              ? "null"
              : Array.isArray(value)
                ? "array"
                : typeof value;
          const status = (value: unknown): string =>
            typeof value === "string" &&
            [
              "completed",
              "incomplete",
              "in_progress",
              "failed",
              "cancelled",
            ].includes(value)
              ? value
              : shape(value);
          try {
            log.info(
              `responses-terminal actual_count=${output.length} expected_count=${expected.length} complete=${complete} mismatch_position=${position} actual_object=${!!value && typeof value === "object" && !Array.isArray(value)} id_string=${typeof actual.id === "string"} id_nonempty=${typeof actual.id === "string" && actual.id.length > 0} alias_known=${typeof actual.id === "string" && aliases.has(actual.id)} ${equal} content_text_equal=${textEqual("content")} summary_text_equal=${textEqual("summary")} envelope_equal=${isDeepStrictEqual(actual, streamed)} response_status=${status(response.status)} actual_status=${status(actual.status)} done_status=${status(streamed.status)} actual_ciphertext=${shape(actual.encrypted_content)} done_ciphertext=${shape(streamed.encrypted_content)} actual_ciphertext_present=${Object.hasOwn(actual, "encrypted_content")} done_ciphertext_present=${Object.hasOwn(streamed, "encrypted_content")}`,
            );
          } catch {
            /* Preserve validation even if diagnostics fail. */
          }
        }
      }
    }
    return changed;
  };
}
