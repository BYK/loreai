import { parseOpenAICodexRequest } from "../../src/translate/openai-responses";

/** Synthetic Responses/Codex transcript: no real prompts, paths or credentials. */
export function semanticHistory(messageCount = 5580) {
  if (messageCount < 2 || messageCount % 2)
    throw new Error("Use an even message count >= 2");
  const input: Record<string, unknown>[] = [
    {
      type: "message",
      role: "user",
      content: "Inspect the synthetic project and run its checks.",
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "I will inspect it." }],
    },
  ];
  for (let turn = 0; turn < (messageCount - 2) / 2; turn++) {
    input.push({
      type: "reasoning",
      id: `reason-${turn}`,
      encrypted_content: "synthetic-encrypted-state-".repeat(12),
      summary: [],
    });
    for (let call = 0; call < 2; call++)
      input.push({
        type: "function_call",
        call_id: `call-${turn}-${call}`,
        name: call ? "shell" : "read_file",
        arguments: JSON.stringify(
          call
            ? { command: "run synthetic checks" }
            : { path: `fixture-${turn % 20}.ts` },
        ),
      });
    for (let call = 0; call < 2; call++)
      input.push({
        type: "function_call_output",
        call_id: `call-${turn}-${call}`,
        output:
          `Synthetic output ${turn}/${call}\n` +
          "export const fixture = 'representative tool output';\n".repeat(40),
      });
  }
  return parseOpenAICodexRequest(
    { model: "synthetic-model", stream: true, input, tools: [] },
    {},
  );
}
