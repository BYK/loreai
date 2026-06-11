/**
 * Unit tests for the synthetic-tools primitive.
 *
 * Tests dynamic tool inference across the agent compatibility matrix,
 * tool_use ID minting, input building, capture/strip, and result parsing.
 */
import { describe, test, expect } from "vitest";
import type { GatewayTool, GatewayRequest } from "../src/translate/types";
import {
  findReadTool,
  findShellTool,
  mintSyntheticToolUseId,
  isSyntheticToolUseId,
  buildSyntheticToolUseBlock,
  buildResolveProjectInput,
  captureSyntheticToolResult,
  stripSyntheticRoundTrips,
  parseResolveProjectResult,
} from "../src/synthetic-tools";

// ---------------------------------------------------------------------------
// Helper: build a GatewayTool from shorthand
// ---------------------------------------------------------------------------

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
): GatewayTool {
  return {
    name,
    description,
    inputSchema: { type: "object", properties, required },
  };
}

const str = (desc = "") => ({
  type: "string",
  ...(desc ? { description: desc } : {}),
});
const num = () => ({ type: "number" });
const bool = () => ({ type: "boolean" });
const strEnum = (...values: string[]) => ({ type: "string", enum: values });
const strArray = () => ({ type: "array", items: { type: "string" } });

// ---------------------------------------------------------------------------
// Agent compatibility matrix — real tool definitions
// ---------------------------------------------------------------------------

const CLAUDE_READ = tool(
  "Read",
  "Read a file from the local filesystem.",
  { file_path: str(), offset: num(), limit: num() },
  ["file_path"],
);
const CLAUDE_BASH = tool(
  "Bash",
  "Executes a given bash command in a persistent shell session.",
  { command: str(), timeout: num(), description: str() },
  ["command"],
);
const CLAUDE_EDIT = tool(
  "Edit",
  "Edit a file.",
  { file_path: str(), old_string: str(), new_string: str() },
  ["file_path", "old_string", "new_string"],
);
const CLAUDE_WRITE = tool(
  "Write",
  "Write content to a file.",
  { file_path: str(), content: str() },
  ["file_path", "content"],
);
const CLAUDE_GREP = tool(
  "Grep",
  "Search for patterns.",
  { pattern: str(), path: str() },
  ["pattern"],
);
const CLAUDE_GLOB = tool(
  "Glob",
  "Find files by pattern.",
  { pattern: str(), path: str() },
  ["pattern"],
);

const OPENCODE_READ = tool(
  "read",
  "Read a file or directory.",
  { filePath: str(), offset: num(), limit: num() },
  ["filePath"],
);
const OPENCODE_BASH = tool(
  "bash",
  "Run a shell command.",
  { command: str(), description: str() },
  ["command", "description"],
);

const PI_READ = tool(
  "read",
  "Read the contents of a file.",
  { path: str(), offset: num(), limit: num() },
  ["path"],
);
const PI_BASH = tool(
  "bash",
  "Execute a bash command.",
  { command: str(), timeout: num() },
  ["command"],
);
const PI_EDIT = tool(
  "edit",
  "Edit a file.",
  { path: str(), edits: { type: "array" } },
  ["path", "edits"],
);
const PI_WRITE = tool(
  "write",
  "Write content to a file.",
  { path: str(), content: str() },
  ["path", "content"],
);
const PI_GREP = tool(
  "grep",
  "Search with a regex pattern.",
  { pattern: str(), path: str() },
  ["pattern"],
);
const PI_LS = tool(
  "ls",
  "List directory contents.",
  { path: str(), limit: num() },
  [],
);

const HERMES_READ = tool(
  "read_file",
  "Read a text file with line numbers.",
  { path: str(), offset: { type: "integer" }, limit: { type: "integer" } },
  ["path"],
);
const HERMES_TERMINAL = tool(
  "terminal",
  "Execute shell commands on a Linux environment.",
  { command: str(), timeout: { type: "integer" }, workdir: str() },
  ["command"],
);
const HERMES_WRITE = tool(
  "write_file",
  "Write content to a file.",
  { path: str(), content: str() },
  ["path", "content"],
);
const HERMES_READ_TERMINAL = tool(
  "read_terminal",
  "Read the terminal pane.",
  { start_line: { type: "integer" }, count: { type: "integer" } },
  [],
);
const HERMES_EXECUTE_CODE = tool(
  "execute_code",
  "Execute Python code.",
  { code: str() },
  ["code"],
);

const CLINE_READ = tool(
  "read_file",
  "Read the contents of a file.",
  {
    path: str(),
    start_line: { type: "integer" },
    end_line: { type: "integer" },
  },
  ["path"],
);
const CLINE_EXEC = tool(
  "execute_command",
  "Execute a CLI command.",
  { command: str(), requires_approval: bool() },
  ["command", "requires_approval"],
);
const CLINE_WRITE = tool(
  "write_to_file",
  "Write content to a file.",
  { path: str(), content: str() },
  ["path", "content"],
);
const CLINE_SEARCH = tool(
  "search_files",
  "Search files with regex.",
  { path: str(), regex: str() },
  ["regex"],
);

const GEMINI_READ = tool(
  "read_file",
  "Reads and returns the content of a file.",
  {
    file_path: str(),
    start_line: { type: "integer" },
    end_line: { type: "integer" },
  },
  ["file_path"],
);
const GEMINI_SHELL = tool(
  "run_shell_command",
  "Execute a shell command.",
  { command: str(), dir_path: str(), description: str() },
  ["command"],
);
const GEMINI_WRITE = tool(
  "write_file",
  "Write content to a file.",
  { file_path: str(), content: str() },
  ["file_path", "content"],
);

const OPENHANDS_FILE_EDITOR = tool(
  "file_editor",
  "Custom editing tool for viewing and editing files.",
  {
    command: strEnum("view", "create", "str_replace", "insert", "undo_edit"),
    path: str(),
    file_text: str(),
    old_str: str(),
    new_str: str(),
  },
  ["command", "path"],
);
const OPENHANDS_TERMINAL = tool(
  "terminal",
  "Execute a shell command.",
  { command: str(), is_input: bool(), timeout: num() },
  ["command"],
);

const CODEX_EXEC = tool(
  "exec_command",
  "Runs a command in a PTY.",
  { cmd: str(), workdir: str(), tty: bool() },
  ["cmd"],
);
const CODEX_SHELL_ARRAY = tool(
  "shell",
  "Run a shell command.",
  { command: strArray(), workdir: str() },
  ["command"],
);

const CLINE_SDK_RUN = tool(
  "run_commands",
  "Run shell commands.",
  { commands: strArray() },
  ["commands"],
);
const CLINE_SDK_READ = tool(
  "read_files",
  "Read files.",
  { files: { type: "array", items: { type: "object" } } },
  ["files"],
);

// MCP namespaced
const MCP_FS_READ = tool(
  "mcp__filesystem__read_file",
  "Read a file.",
  { path: str() },
  ["path"],
);
const SLASH_NS_READ = tool(
  "filesystem/read_file",
  "Read a file.",
  { path: str() },
  ["path"],
);
const DOT_NS_READ = tool(
  "functions.Read",
  "Read a file.",
  { file_path: str() },
  ["file_path"],
);

// ---------------------------------------------------------------------------
// findReadTool tests
// ---------------------------------------------------------------------------

describe("findReadTool", () => {
  test("Claude Code: Read with file_path", () => {
    const r = findReadTool([
      CLAUDE_READ,
      CLAUDE_BASH,
      CLAUDE_EDIT,
      CLAUDE_WRITE,
      CLAUDE_GREP,
    ]);
    expect(r).not.toBeNull();
    expect(r?.toolName).toBe("Read");
    expect(r?.pathParam).toBe("file_path");
    expect(r?.extraRequired).toEqual({});
  });

  test("OpenCode: read with filePath", () => {
    const r = findReadTool([OPENCODE_READ, OPENCODE_BASH]);
    expect(r).not.toBeNull();
    expect(r?.toolName).toBe("read");
    expect(r?.pathParam).toBe("filePath");
  });

  test("Pi: read with path", () => {
    const r = findReadTool([
      PI_READ,
      PI_BASH,
      PI_EDIT,
      PI_WRITE,
      PI_GREP,
      PI_LS,
    ]);
    expect(r).not.toBeNull();
    expect(r?.toolName).toBe("read");
    expect(r?.pathParam).toBe("path");
  });

  test("Hermes: read_file with path", () => {
    const r = findReadTool([
      HERMES_READ,
      HERMES_TERMINAL,
      HERMES_WRITE,
      HERMES_READ_TERMINAL,
    ]);
    expect(r).not.toBeNull();
    expect(r?.toolName).toBe("read_file");
    expect(r?.pathParam).toBe("path");
  });

  test("Cline: read_file with path", () => {
    const r = findReadTool([CLINE_READ, CLINE_EXEC, CLINE_WRITE, CLINE_SEARCH]);
    expect(r).not.toBeNull();
    expect(r?.toolName).toBe("read_file");
    expect(r?.pathParam).toBe("path");
  });

  test("Gemini: read_file with file_path", () => {
    const r = findReadTool([GEMINI_READ, GEMINI_SHELL, GEMINI_WRITE]);
    expect(r).not.toBeNull();
    expect(r?.toolName).toBe("read_file");
    expect(r?.pathParam).toBe("file_path");
  });

  test("OpenHands file_editor as fallback reader (command enum with view)", () => {
    const r = findReadTool([OPENHANDS_FILE_EDITOR, OPENHANDS_TERMINAL]);
    expect(r).not.toBeNull();
    expect(r?.toolName).toBe("file_editor");
    expect(r?.pathParam).toBe("path");
    expect(r?.extraRequired).toEqual({ command: "view" });
  });

  test("plain reader preferred over file_editor fallback", () => {
    const plainRead = tool("read_file", "Read a file.", { path: str() }, [
      "path",
    ]);
    const r = findReadTool([OPENHANDS_FILE_EDITOR, plainRead]);
    expect(r).not.toBeNull();
    expect(r?.toolName).toBe("read_file");
    expect(r?.extraRequired).toEqual({});
  });

  test("Codex: no read tool returns null", () => {
    const r = findReadTool([CODEX_EXEC]);
    expect(r).toBeNull();
  });

  test("MCP namespaced read_file matches", () => {
    const r = findReadTool([MCP_FS_READ]);
    expect(r).not.toBeNull();
    expect(r?.toolName).toBe("mcp__filesystem__read_file");
    expect(r?.pathParam).toBe("path");
  });

  test("slash-namespaced read matches", () => {
    const r = findReadTool([SLASH_NS_READ]);
    expect(r).not.toBeNull();
    expect(r?.pathParam).toBe("path");
  });

  test("dot-namespaced Read matches", () => {
    const r = findReadTool([DOT_NS_READ]);
    expect(r).not.toBeNull();
    expect(r?.pathParam).toBe("file_path");
  });

  test("rejects write tool (has content)", () => {
    const r = findReadTool([CLAUDE_WRITE]);
    expect(r).toBeNull();
  });

  test("rejects edit tool (has old_string)", () => {
    const r = findReadTool([CLAUDE_EDIT]);
    expect(r).toBeNull();
  });

  test("rejects grep tool (has pattern)", () => {
    const r = findReadTool([CLAUDE_GREP]);
    expect(r).toBeNull();
  });

  test("rejects Pi edit (has edits)", () => {
    const r = findReadTool([PI_EDIT]);
    expect(r).toBeNull();
  });

  test("Hermes read_terminal does NOT match (no path param)", () => {
    const r = findReadTool([HERMES_READ_TERMINAL]);
    expect(r).toBeNull();
  });

  test("Pi ls does NOT match (path is optional)", () => {
    const r = findReadTool([PI_LS]);
    expect(r).toBeNull();
  });

  test("Cline SDK read_files is a gap (files is array, not string)", () => {
    const r = findReadTool([CLINE_SDK_READ]);
    expect(r).toBeNull();
  });

  test("returns null for empty tools list", () => {
    expect(findReadTool([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findShellTool tests
// ---------------------------------------------------------------------------

describe("findShellTool", () => {
  test("Claude Code: Bash with command", () => {
    const r = findShellTool([CLAUDE_BASH, CLAUDE_READ]);
    expect(r).not.toBeNull();
    expect(r?.toolName).toBe("Bash");
    expect(r?.commandParam).toBe("command");
    expect(r?.commandIsArray).toBe(false);
    expect(r?.extraRequired).toEqual({});
  });

  test("OpenCode: bash with command + required description", () => {
    const r = findShellTool([OPENCODE_BASH, OPENCODE_READ]);
    expect(r).not.toBeNull();
    expect(r?.toolName).toBe("bash");
    expect(r?.commandParam).toBe("command");
    expect(r?.extraRequired).toHaveProperty("description");
    expect(typeof r?.extraRequired.description).toBe("string");
  });

  test("Pi: bash with command", () => {
    const r = findShellTool([PI_BASH]);
    expect(r).not.toBeNull();
    expect(r?.toolName).toBe("bash");
    expect(r?.commandParam).toBe("command");
  });

  test("Hermes: terminal with command", () => {
    const r = findShellTool([HERMES_TERMINAL]);
    expect(r).not.toBeNull();
    expect(r?.toolName).toBe("terminal");
    expect(r?.commandParam).toBe("command");
  });

  test("Cline: execute_command with command + required requires_approval", () => {
    const r = findShellTool([CLINE_EXEC]);
    expect(r).not.toBeNull();
    expect(r?.toolName).toBe("execute_command");
    expect(r?.commandParam).toBe("command");
    expect(r?.extraRequired).toEqual({ requires_approval: false });
  });

  test("Gemini: run_shell_command with command", () => {
    const r = findShellTool([GEMINI_SHELL]);
    expect(r).not.toBeNull();
    expect(r?.toolName).toBe("run_shell_command");
    expect(r?.commandParam).toBe("command");
  });

  test("OpenHands: terminal with command", () => {
    const r = findShellTool([OPENHANDS_TERMINAL]);
    expect(r).not.toBeNull();
    expect(r?.toolName).toBe("terminal");
    expect(r?.commandParam).toBe("command");
  });

  test("Codex: exec_command with cmd", () => {
    const r = findShellTool([CODEX_EXEC]);
    expect(r).not.toBeNull();
    expect(r?.toolName).toBe("exec_command");
    expect(r?.commandParam).toBe("cmd");
    expect(r?.commandIsArray).toBe(false);
  });

  test("Codex classic: shell with command (array)", () => {
    const r = findShellTool([CODEX_SHELL_ARRAY]);
    expect(r).not.toBeNull();
    expect(r?.toolName).toBe("shell");
    expect(r?.commandParam).toBe("command");
    expect(r?.commandIsArray).toBe(true);
  });

  test("Cline SDK: run_commands with commands (array)", () => {
    const r = findShellTool([CLINE_SDK_RUN]);
    expect(r).not.toBeNull();
    expect(r?.toolName).toBe("run_commands");
    expect(r?.commandParam).toBe("commands");
    expect(r?.commandIsArray).toBe(true);
  });

  test("rejects execute_code (code is not in cmd allowlist)", () => {
    const r = findShellTool([HERMES_EXECUTE_CODE]);
    expect(r).toBeNull();
  });

  test("rejects file_editor (command is enum, not free-form)", () => {
    const r = findShellTool([OPENHANDS_FILE_EDITOR]);
    expect(r).toBeNull();
  });

  test("returns null for empty tools list", () => {
    expect(findShellTool([])).toBeNull();
  });

  test("returns null when no shell-like tool exists", () => {
    const r = findShellTool([CLAUDE_READ, CLAUDE_WRITE, CLAUDE_EDIT]);
    expect(r).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// mintSyntheticToolUseId / isSyntheticToolUseId
// ---------------------------------------------------------------------------

describe("synthetic tool_use ID", () => {
  test("minted IDs start with prefix", () => {
    const id = mintSyntheticToolUseId();
    expect(id).toMatch(/^lore_syn_/);
    expect(id.length).toBeGreaterThan(10);
  });

  test("minted IDs are unique", () => {
    const ids = new Set(
      Array.from({ length: 100 }, () => mintSyntheticToolUseId()),
    );
    expect(ids.size).toBe(100);
  });

  test("isSyntheticToolUseId recognizes our IDs", () => {
    expect(isSyntheticToolUseId(mintSyntheticToolUseId())).toBe(true);
  });

  test("isSyntheticToolUseId rejects non-synthetic IDs", () => {
    expect(isSyntheticToolUseId("toolu_abc123")).toBe(false);
    expect(isSyntheticToolUseId("call_abc123")).toBe(false);
    expect(isSyntheticToolUseId("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildSyntheticToolUseBlock / buildResolveProjectInput
// ---------------------------------------------------------------------------

describe("buildSyntheticToolUseBlock", () => {
  test("read target builds correct block", () => {
    const target = findReadTool([OPENCODE_READ])!;
    const block = buildSyntheticToolUseBlock(target);
    expect(block.type).toBe("tool_use");
    expect(block.name).toBe("read");
    expect(isSyntheticToolUseId(block.id)).toBe(true);
    const input = block.input as Record<string, unknown>;
    expect(input.filePath).toBe(".git/config");
  });

  test("shell target builds correct block (string command)", () => {
    const target = findShellTool([CLAUDE_BASH])!;
    const block = buildSyntheticToolUseBlock(target);
    expect(block.name).toBe("Bash");
    const input = block.input as Record<string, unknown>;
    expect(typeof input.command).toBe("string");
    expect(input.command).toContain("git rev-parse --show-toplevel");
    expect(input.command).toContain("pwd");
  });

  test("shell target builds array command when commandIsArray", () => {
    const target = findShellTool([CODEX_SHELL_ARRAY])!;
    const input = buildResolveProjectInput(target);
    expect(Array.isArray(input.command)).toBe(true);
    expect((input.command as string[])[0]).toBe("bash");
  });

  test("extra required params are included in input", () => {
    const target = findShellTool([OPENCODE_BASH])!;
    const input = buildResolveProjectInput(target);
    expect(input.description).toBeTruthy();
    expect(typeof input.description).toBe("string");
  });

  test("Cline requires_approval is set to false", () => {
    const target = findShellTool([CLINE_EXEC])!;
    const input = buildResolveProjectInput(target);
    expect(input.requires_approval).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// captureSyntheticToolResult
// ---------------------------------------------------------------------------

describe("captureSyntheticToolResult", () => {
  const syntheticId = "lore_syn_abc123def456";

  test("captures matching tool_result", () => {
    const req = {
      messages: [
        {
          role: "user" as const,
          content: [
            {
              type: "tool_result" as const,
              toolUseId: syntheticId,
              content: [{ type: "text" as const, text: "the result" }],
            },
          ],
        },
      ],
    } as GatewayRequest;
    const result = captureSyntheticToolResult(req, syntheticId);
    expect(result).toEqual({ text: "the result", isError: false });
  });

  test("captures error tool_result", () => {
    const req = {
      messages: [
        {
          role: "user" as const,
          content: [
            {
              type: "tool_result" as const,
              toolUseId: syntheticId,
              content: [{ type: "text" as const, text: "error: not found" }],
              isError: true,
            },
          ],
        },
      ],
    } as GatewayRequest;
    const result = captureSyntheticToolResult(req, syntheticId);
    expect(result).toEqual({ text: "error: not found", isError: true });
  });

  test("returns null when no matching tool_result", () => {
    const req = {
      messages: [
        {
          role: "user" as const,
          content: [
            {
              type: "tool_result" as const,
              toolUseId: "toolu_other",
              content: [{ type: "text" as const, text: "other" }],
            },
          ],
        },
      ],
    } as GatewayRequest;
    expect(captureSyntheticToolResult(req, syntheticId)).toBeNull();
  });

  test("returns null when messages are empty", () => {
    const req = { messages: [] } as unknown as GatewayRequest;
    expect(captureSyntheticToolResult(req, syntheticId)).toBeNull();
  });

  test("ignores assistant messages", () => {
    const req = {
      messages: [
        {
          role: "assistant" as const,
          content: [
            {
              type: "tool_use" as const,
              id: syntheticId,
              name: "read",
              input: {},
            },
          ],
        },
      ],
    } as GatewayRequest;
    expect(captureSyntheticToolResult(req, syntheticId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// stripSyntheticRoundTrips
// ---------------------------------------------------------------------------

describe("stripSyntheticRoundTrips", () => {
  const synId = "lore_syn_strip_test_1";

  test("strips synthetic tool_use and tool_result", () => {
    const req = {
      messages: [
        {
          role: "assistant" as const,
          content: [
            { type: "tool_use" as const, id: synId, name: "read", input: {} },
          ],
        },
        {
          role: "user" as const,
          content: [
            {
              type: "tool_result" as const,
              toolUseId: synId,
              content: [{ type: "text" as const, text: "result" }],
            },
          ],
        },
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: "real message" }],
        },
      ],
    } as unknown as GatewayRequest;

    const stripped = stripSyntheticRoundTrips(req);
    expect(stripped).toBe(true);
    // Empty messages removed, only real message remains
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0].role).toBe("user");
    expect(req.messages[0].content[0]).toEqual({
      type: "text",
      text: "real message",
    });
  });

  test("leaves non-synthetic blocks intact", () => {
    const req = {
      messages: [
        {
          role: "assistant" as const,
          content: [
            {
              type: "tool_use" as const,
              id: "toolu_real",
              name: "bash",
              input: {},
            },
          ],
        },
        {
          role: "user" as const,
          content: [
            {
              type: "tool_result" as const,
              toolUseId: "toolu_real",
              content: [{ type: "text" as const, text: "result" }],
            },
          ],
        },
      ],
    } as unknown as GatewayRequest;

    const stripped = stripSyntheticRoundTrips(req);
    expect(stripped).toBe(false);
    expect(req.messages).toHaveLength(2);
  });

  test("partially strips synthetic blocks from a mixed message", () => {
    const synId = "lore_syn_mixed_test_1";
    const req = {
      messages: [
        {
          role: "assistant" as const,
          content: [
            {
              type: "tool_use" as const,
              id: synId,
              name: "read",
              input: {},
            },
            {
              type: "tool_use" as const,
              id: "toolu_real_123",
              name: "bash",
              input: { command: "ls" },
            },
          ],
        },
        {
          role: "user" as const,
          content: [
            {
              type: "tool_result" as const,
              toolUseId: synId,
              content: [{ type: "text" as const, text: "synthetic result" }],
            },
            {
              type: "tool_result" as const,
              toolUseId: "toolu_real_123",
              content: [{ type: "text" as const, text: "real result" }],
            },
          ],
        },
      ],
    } as unknown as GatewayRequest;

    const stripped = stripSyntheticRoundTrips(req);
    expect(stripped).toBe(true);
    // Both messages should remain (they still have real blocks)
    expect(req.messages).toHaveLength(2);
    // Assistant message should only have the real tool_use
    expect(req.messages[0].content).toHaveLength(1);
    expect(req.messages[0].content[0]).toEqual({
      type: "tool_use",
      id: "toolu_real_123",
      name: "bash",
      input: { command: "ls" },
    });
    // User message should only have the real tool_result
    expect(req.messages[1].content).toHaveLength(1);
    expect(req.messages[1].content[0]).toMatchObject({
      type: "tool_result",
      toolUseId: "toolu_real_123",
    });
  });

  test("idempotent — second call is a no-op", () => {
    const req = {
      messages: [
        {
          role: "assistant" as const,
          content: [
            { type: "tool_use" as const, id: synId, name: "read", input: {} },
          ],
        },
      ],
    } as unknown as GatewayRequest;

    stripSyntheticRoundTrips(req);
    const result = stripSyntheticRoundTrips(req);
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseResolveProjectResult — read (.git/config)
// ---------------------------------------------------------------------------

describe("parseResolveProjectResult (read)", () => {
  test("parses origin remote URL", () => {
    const config = `[core]
\trepositoryformatversion = 0
[remote "origin"]
\turl = git@github.com:user/repo.git
\tfetch = +refs/heads/*:refs/remotes/origin/*
[branch "main"]
\tremote = origin`;
    const result = parseResolveProjectResult("read", config);
    expect(result.gitRemote).toBeTruthy();
    expect(result.gitRemote).toContain("github.com");
    expect(result.root).toBeUndefined();
    expect(result.gitHead).toBeUndefined();
  });

  test("prefers upstream over origin", () => {
    const config = `[remote "origin"]
\turl = git@github.com:user/fork.git
[remote "upstream"]
\turl = git@github.com:org/repo.git`;
    const result = parseResolveProjectResult("read", config);
    expect(result.gitRemote).toContain("org/repo");
  });

  test("returns empty for no remote", () => {
    const config = `[core]
\trepositoryformatversion = 0
[branch "main"]
\tmerge = refs/heads/main`;
    const result = parseResolveProjectResult("read", config);
    expect(result.gitRemote).toBeUndefined();
  });

  test("returns empty for malformed input", () => {
    const result = parseResolveProjectResult("read", "not a git config");
    expect(result.gitRemote).toBeUndefined();
  });

  test("handles HTTPS remote URLs", () => {
    const config = `[remote "origin"]
\turl = https://github.com/user/repo.git`;
    const result = parseResolveProjectResult("read", config);
    expect(result.gitRemote).toContain("github.com");
  });

  test("returns empty for empty input", () => {
    const result = parseResolveProjectResult("read", "");
    expect(result.gitRemote).toBeUndefined();
  });

  test("handles malformed URL gracefully (normalizeRemoteUrl catch path)", () => {
    const config = `[remote "origin"]
\turl = ://malformed-not-a-url`;
    const result = parseResolveProjectResult("read", config);
    // normalizeRemoteUrl may return the string as-is or throw — either way
    // the result should not crash and gitRemote should be defined or undefined
    // (depending on normalizeRemoteUrl's behavior with malformed input).
    expect(() => parseResolveProjectResult("read", config)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// parseResolveProjectResult — shell (positional stdout)
// ---------------------------------------------------------------------------

describe("parseResolveProjectResult (shell)", () => {
  test("parses full 4-line output (root + remote + head + pwd)", () => {
    const output = `/home/user/project
git@github.com:user/repo.git
abc1234deadbeef
/home/user/project`;
    const result = parseResolveProjectResult("shell", output);
    expect(result.root).toBe("/home/user/project");
    expect(result.gitRemote).toContain("github.com");
    expect(result.gitHead).toBe("abc1234deadbeef");
  });

  test("falls back to pwd when git root is blank (non-git dir)", () => {
    // 4-line output: line1=blank (no git root), line2=blank (no remote),
    // line3=blank (no HEAD), line4=pwd
    const output = "\n\n\n/home/user/non-git-dir";
    const result = parseResolveProjectResult("shell", output);
    // root = line[0] (blank) || line[3] = pwd
    expect(result.root).toBe("/home/user/non-git-dir");
    expect(result.gitRemote).toBeUndefined();
  });

  test("handles 4-line output where root is blank", () => {
    const output = `

deadbeef1234567
/home/user/non-git-dir`;
    const result = parseResolveProjectResult("shell", output);
    // root = line[0] (blank) || line[3] = pwd
    expect(result.root).toBe("/home/user/non-git-dir");
    expect(result.gitHead).toBe("deadbeef1234567");
  });

  test("returns empty for empty output", () => {
    const result = parseResolveProjectResult("shell", "");
    expect(result.root).toBeUndefined();
    expect(result.gitRemote).toBeUndefined();
  });

  test("rejects non-hex git HEAD", () => {
    const output = `/home/user/project
git@github.com:user/repo.git
not-a-sha
/home/user/project`;
    const result = parseResolveProjectResult("shell", output);
    expect(result.gitHead).toBeUndefined();
    expect(result.root).toBe("/home/user/project");
  });
});
