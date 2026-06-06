import { describe, test, expect, beforeEach } from "vitest";
import { db, ensureProject } from "../src/db";
import * as toolTrace from "../src/tool-trace";

const PROJECT = "/test/tool-trace/project";

function insertFailure(
  pid: string,
  opts: {
    messageId: string;
    callId: string;
    session: string;
    tool: string;
    status?: string;
    errorType?: string | null;
    errorMessage?: string | null;
    createdAt?: number;
  },
) {
  db()
    .query(
      `INSERT INTO tool_calls
         (call_id, message_id, project_id, session_id, tool, status, error_type, error_message, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.callId,
      opts.messageId,
      pid,
      opts.session,
      opts.tool,
      opts.status ?? "error",
      opts.errorType ?? null,
      opts.errorMessage ?? null,
      0,
      opts.createdAt ?? 1000,
    );
}

describe("tool-trace", () => {
  describe("classifyToolError", () => {
    test("returns 'unknown' for empty error", () => {
      expect(toolTrace.classifyToolError("bash", "")).toBe("unknown");
      expect(toolTrace.classifyToolError("bash", "   \n  ")).toBe("unknown");
    });

    test("buckets curated error types", () => {
      expect(toolTrace.classifyToolError("bash", "Operation timed out")).toBe(
        "timeout",
      );
      expect(
        toolTrace.classifyToolError("read", "EACCES: permission denied"),
      ).toBe("permission");
      expect(
        toolTrace.classifyToolError(
          "read",
          "ENOENT: no such file or directory",
        ),
      ).toBe("not_found");
      expect(toolTrace.classifyToolError("write", "File already exists")).toBe(
        "already_exists",
      );
      expect(
        toolTrace.classifyToolError("fetch", "ECONNREFUSED connection error"),
      ).toBe("network");
      expect(
        toolTrace.classifyToolError("edit", "Syntax error: unexpected token"),
      ).toBe("syntax");
      expect(
        toolTrace.classifyToolError("run", "TypeError: x is not a function"),
      ).toBe("type_error");
      expect(
        toolTrace.classifyToolError("edit", "oldString not found in content"),
      ).toBe("edit_noop");
      expect(
        toolTrace.classifyToolError("bash", "Command failed with exit code 1"),
      ).toBe("command_failed");
      expect(
        toolTrace.classifyToolError("bash", "Process aborted by user"),
      ).toBe("aborted");
    });

    test("uses only the first non-empty line", () => {
      expect(
        toolTrace.classifyToolError(
          "bash",
          "\n\nOperation timed out\nstack trace here",
        ),
      ).toBe("timeout");
    });

    test("falls back to 'other:' slug for unknown errors", () => {
      const r = toolTrace.classifyToolError(
        "custom",
        "Weird unmatched failure happened",
      );
      expect(r.startsWith("other:")).toBe(true);
      expect(r.length).toBeLessThanOrEqual(46); // "other:" + 40
    });

    test("returns 'unknown' when fallback slug is empty", () => {
      expect(toolTrace.classifyToolError("x", "123 456 789")).toBe("unknown");
    });
  });

  describe("aggregation accessors", () => {
    beforeEach(() => {
      const pid = ensureProject(PROJECT);
      db().query("DELETE FROM tool_calls WHERE project_id = ?").run(pid);
    });

    test("toolFailureStats groups by (tool, error_type) with session counts", () => {
      const pid = ensureProject(PROJECT);
      insertFailure(pid, {
        messageId: "m1",
        callId: "c1",
        session: "s1",
        tool: "edit",
        errorType: "edit_noop",
        errorMessage: "oldString not found",
      });
      insertFailure(pid, {
        messageId: "m2",
        callId: "c2",
        session: "s2",
        tool: "edit",
        errorType: "edit_noop",
      });
      insertFailure(pid, {
        messageId: "m3",
        callId: "c3",
        session: "s2",
        tool: "edit",
        errorType: "edit_noop",
      });
      insertFailure(pid, {
        messageId: "m4",
        callId: "c4",
        session: "s1",
        tool: "bash",
        errorType: "timeout",
      });

      const stats = toolTrace.toolFailureStats(PROJECT);
      const edit = stats.find(
        (s) => s.tool === "edit" && s.error_type === "edit_noop",
      );
      expect(edit).toBeDefined();
      expect(edit?.failure_count).toBe(3);
      expect(edit?.session_count).toBe(2);
      expect(edit?.sample_message).toBe("oldString not found");
    });

    test("toolFailureStats respects minSessions", () => {
      const pid = ensureProject(PROJECT);
      insertFailure(pid, {
        messageId: "m1",
        callId: "c1",
        session: "s1",
        tool: "bash",
        errorType: "timeout",
      });
      const all = toolTrace.toolFailureStats(PROJECT, { minSessions: 1 });
      expect(all.length).toBe(1);
      const filtered = toolTrace.toolFailureStats(PROJECT, { minSessions: 2 });
      expect(filtered.length).toBe(0);
    });

    test("toolFailureStats excludes the current session", () => {
      const pid = ensureProject(PROJECT);
      insertFailure(pid, {
        messageId: "m1",
        callId: "c1",
        session: "cur",
        tool: "bash",
        errorType: "timeout",
      });
      insertFailure(pid, {
        messageId: "m2",
        callId: "c2",
        session: "other",
        tool: "bash",
        errorType: "timeout",
      });
      const stats = toolTrace.toolFailureStats(PROJECT, {
        excludeSessionID: "cur",
      });
      expect(stats.length).toBe(1);
      expect(stats[0].session_count).toBe(1);
    });

    test("toolFailureStats ignores completed calls", () => {
      const pid = ensureProject(PROJECT);
      insertFailure(pid, {
        messageId: "m1",
        callId: "c1",
        session: "s1",
        tool: "bash",
        status: "completed",
        errorType: null,
      });
      expect(toolTrace.toolFailureStats(PROJECT).length).toBe(0);
    });

    test("recentSessionFailures filters by session, window, and limit", () => {
      const pid = ensureProject(PROJECT);
      insertFailure(pid, {
        messageId: "m1",
        callId: "c1",
        session: "s1",
        tool: "a",
        errorType: "timeout",
        createdAt: 100,
      });
      insertFailure(pid, {
        messageId: "m2",
        callId: "c2",
        session: "s1",
        tool: "b",
        errorType: "network",
        createdAt: 200,
      });
      insertFailure(pid, {
        messageId: "m3",
        callId: "c3",
        session: "s2",
        tool: "c",
        errorType: "timeout",
        createdAt: 200,
      });

      const all = toolTrace.recentSessionFailures(PROJECT, "s1");
      expect(all.length).toBe(2);
      // Ordered newest first.
      expect(all[0].created_at).toBe(200);

      const windowed = toolTrace.recentSessionFailures(PROJECT, "s1", {
        sinceMs: 150,
      });
      expect(windowed.length).toBe(1);
      expect(windowed[0].tool).toBe("b");

      const limited = toolTrace.recentSessionFailures(PROJECT, "s1", {
        limit: 1,
      });
      expect(limited.length).toBe(1);
    });
  });

  describe("text helpers", () => {
    test("toolGotchaTitle is deterministic", () => {
      expect(toolTrace.toolGotchaTitle("bash", "timeout")).toBe(
        "Recurring bash failure: timeout",
      );
      expect(toolTrace.toolGotchaTitle("bash", null)).toBe(
        "Recurring bash failure: unknown error",
      );
    });

    test("toolGotchaContent includes counts and sample", () => {
      const content = toolTrace.toolGotchaContent({
        tool: "edit",
        error_type: "edit_noop",
        failure_count: 5,
        session_count: 3,
        sample_message: "oldString not found",
      });
      expect(content).toContain("edit");
      expect(content).toContain("edit_noop");
      expect(content).toContain("3 sessions");
      expect(content).toContain("5 total failures");
      expect(content).toContain("oldString not found");
      expect(content.length).toBeLessThanOrEqual(1200);
    });
  });

  describe("formatToolFailureSection", () => {
    beforeEach(() => {
      const pid = ensureProject(PROJECT);
      db().query("DELETE FROM tool_calls WHERE project_id = ?").run(pid);
    });

    test("returns '' when no failures", () => {
      expect(toolTrace.formatToolFailureSection(PROJECT)).toBe("");
      expect(toolTrace.formatToolFailureSection(PROJECT, "s1")).toBe("");
    });

    test("project-wide section lists recurring failures", () => {
      const pid = ensureProject(PROJECT);
      insertFailure(pid, {
        messageId: "m1",
        callId: "c1",
        session: "s1",
        tool: "bash",
        errorType: "timeout",
      });
      const section = toolTrace.formatToolFailureSection(PROJECT);
      expect(section).toContain("Recurring Tool Failures");
      expect(section).toContain("bash");
      expect(section).toContain("timeout");
    });

    test("session-scoped section lists this session's failures", () => {
      const pid = ensureProject(PROJECT);
      insertFailure(pid, {
        messageId: "m1",
        callId: "c1",
        session: "s1",
        tool: "read",
        errorType: "not_found",
      });
      const section = toolTrace.formatToolFailureSection(PROJECT, "s1");
      expect(section).toContain("Tool Failures (this session)");
      expect(section).toContain("read");
      expect(section).toContain("not_found");
    });
  });
});
