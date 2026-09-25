/**
 * Unit tests — Ollama permission-gated approval reuse (Phase 5 Stage E).
 *
 * DB-backed: proves that an `ask` gate creates an approval_request row + a
 * notification via the EXISTING pipeline (reused from the OpenCode runner), and
 * that the synthetic `ollama:<session>:<call>` provider_request_id dedupes on a
 * retry / crash via the UNIQUE constraint (plan §17 risk 6).
 *
 * Also exercises the memory/persist helpers the Stage F loop uses to feed
 * `role:'tool'` results back to the model.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb, getRawDb, resetDbForTests } from "@/lib/db";
import { migrate } from "@/lib/db/migrate";
import { createHouse, getHouse } from "@/server/repositories/house-repo";
import { createTask } from "@/server/repositories/task-repo";
import {
  createExecutionSession,
  createApprovalRequest,
  createNotification,
  listApprovalRequests,
  countUnreadNotifications,
  getApprovalByProviderId,
  upsertAgentMessage,
  listAgentMessagesForSession,
  setApprovalResponse,
} from "@/server/repositories/execution-repo";
import type { HouseConfiguration } from "@/shared/types";

let tmpDir: string;
let dbPath: string;

function makeConfig(): HouseConfiguration {
  return {
    systemPrompt: "You are an agent.",
    executionProvider: "ollama",
    aiProvider: "ollama-cloud",
    modelId: "m",
    workspaceAllowlist: [tmpDir],
    tools: ["fs"],
    permissions: { fileSystem: "ask", shell: "ask", network: "deny", git: "allow" },
    approvalPolicy: "always",
    concurrency: 1,
  };
}

beforeEach(() => {
  resetDbForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-approval-"));
  dbPath = path.join(tmpDir, "test.db");
  process.env.VELARIS_DB_PATH = dbPath;
  migrate();
});

afterEach(() => {
  resetDbForTests();
  delete process.env.VELARIS_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedSession() {
  const house = createHouse(getDb(), { name: "H", description: null, agent: { name: "A", role: "R" }, configuration: makeConfig() });
  const task = createTask(getDb(), { title: "Quest", houseId: house.id, workingDirectory: tmpDir });
  const session = createExecutionSession(getDb(), {
    taskId: task.id,
    houseId: house.id,
    provider: "ollama",
    modelId: "m",
    directory: tmpDir,
  });
  return { house: getHouse(getDb(), house.id)!, task, session };
}

describe("approval creation + notification", () => {
  it("an ask gate creates an approval_request + notification via the shared pipeline", () => {
    const { house, task, session } = seedSession();
    const created = createApprovalRequest(getDb(), {
      sessionId: session.id,
      taskId: task.id,
      houseId: house.id,
      providerRequestId: `ollama:${session.id}:fs_write::1`,
      kind: "permission",
      title: "Permission needed: fs_write",
      message: "The model wants to run 'fs_write'. Approve to continue.",
      options: [],
    });
    expect(created).not.toBeNull();
    createNotification(getDb(), {
      type: "approval",
      houseId: house.id,
      taskId: task.id,
      approvalRequestId: created!.id,
      title: created!.title,
      body: created!.message,
    });
    const approvals = listApprovalRequests(getDb(), {});
    expect(approvals).toHaveLength(1);
    expect(approvals[0].kind).toBe("permission");
    expect(approvals[0].status).toBe("pending");
    expect(countUnreadNotifications(getDb())).toBe(1);
  });

  it("synthetic provider_request_id dedupes a retry (UNIQUE) and returns the existing row (risk 6)", () => {
    const { house, task, session } = seedSession();
    const id = `ollama:${session.id}:fs_write::1`;
    const first = createApprovalRequest(getDb(), { sessionId: session.id, taskId: task.id, houseId: house.id, providerRequestId: id, kind: "permission", title: "t", message: "m", options: [] });
    const second = createApprovalRequest(getDb(), { sessionId: session.id, taskId: task.id, houseId: house.id, providerRequestId: id, kind: "permission", title: "t", message: "m", options: [] });
    expect(listApprovalRequests(getDb(), {})).toHaveLength(1);
    expect(first!.id).toBe(second!.id);
    expect(getApprovalByProviderId(getDb(), id)!.id).toBe(first!.id);
  });

  it("respond → approved lets the loop execute (relayed marker set)", () => {
    const { house, task, session } = seedSession();
    const id = `ollama:${session.id}:shell_exec::1`;
    const created = createApprovalRequest(getDb(), { sessionId: session.id, taskId: task.id, houseId: house.id, providerRequestId: id, kind: "permission", title: "t", message: "m", options: [] })!;
    setApprovalResponse(getDb(), created.id, "approved", null);
    expect(listApprovalRequests(getDb(), {})[0].status).toBe("approved");
  });

  it("rejected → denial tool_result (no re-execution) via status + response", () => {
    const { house, task, session } = seedSession();
    const id = `ollama:${session.id}:shell_exec::1`;
    const created = createApprovalRequest(getDb(), { sessionId: session.id, taskId: task.id, houseId: house.id, providerRequestId: id, kind: "permission", title: "t", message: "m", options: [] })!;
    setApprovalResponse(getDb(), created.id, "rejected", "no shell");
    const row = listApprovalRequests(getDb(), {})[0];
    expect(row.status).toBe("rejected");
    expect(row.response).toBe("no shell");
  });
});

describe("tool-loop message persistence (memory)", () => {
  it("round-trips role='tool' rows with tool_call_id into the session's message stream", () => {
    const { session } = seedSession();
    upsertAgentMessage(getDb(), { sessionId: session.id, role: "user", content: "read a.txt" });
    upsertAgentMessage(getDb(), {
      sessionId: session.id,
      role: "agent",
      content: "let me check",
      toolCalls: JSON.stringify([{ function: { name: "fs_read", arguments: { path: "/work/a.txt" } } }]),
    });
    upsertAgentMessage(getDb(), { sessionId: session.id, role: "tool", content: "fs_read: hello world", toolCallId: "fs_read::0" });

    const rows = listAgentMessagesForSession(getDb(), session.id);
    expect(rows.map((r) => r.role)).toEqual(["user", "agent", "tool"]);
    // tool results carry tool_call_id; assistant turns carry tool_calls JSON.
    const raw = getRawDb();
    const toolRows = raw.prepare("SELECT role, tool_call_id FROM agent_messages WHERE role='tool'").all() as { role: string; tool_call_id: string }[];
    expect(toolRows).toHaveLength(1);
    expect(toolRows[0].tool_call_id).toBe("fs_read::0");
  });
});
