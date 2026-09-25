/**
 * Unit tests — Ollama tool registry & tools (Phase 5 Stage D).
 *
 * Covers:
 *  - registry selection by config (tools list + network opt-in)
 *  - fs_read inside allowlist succeeds; outside is flagged for gating (not executed)
 *  - fs_write inside allowlist writes a temp file; the NEW-FILE parent-resolution +
 *    symlink-escape safety is tested explicitly
 *  - shell_exec runs `true`/`echo` and returns an exit code; a cwd outside the
 *    allowlist is refused; a multi-token/shell-string command is rejected
 *  - network (web_fetch) is ABSENT by default and only present when allowed
 *  - tool-definition shape matches the Ollama tools[] contract
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildToolRegistry, toOllamaToolDefs } from "@/server/execution/ollama/tools/registry";
import { fsRead, fsWrite, fsList, resolveWriteTarget } from "@/server/execution/ollama/tools/fs";
import { shellExec, isInterpreter } from "@/server/execution/ollama/tools/shell";
import { git } from "@/server/execution/ollama/tools/git";
import { webFetch, isBlockedFetchHost } from "@/server/execution/ollama/tools/web-fetch";
import type { HouseConfiguration } from "@/shared/types";

let workspace: string;
let outside: string;

function makeConfig(overrides: Partial<HouseConfiguration["permissions"] & { tools?: string[] }> = {}): HouseConfiguration {
  return {
    systemPrompt: "x",
    executionProvider: "ollama",
    aiProvider: "ollama-cloud",
    modelId: "m",
    workspaceAllowlist: [workspace],
    tools: overrides.tools ?? ["fs", "shell"],
    permissions: {
      fileSystem: "allow",
      shell: "allow",
      network: "deny",
      git: "allow",
      ...(overrides.fileSystem ? { fileSystem: overrides.fileSystem } : {}),
      ...(overrides.shell ? { shell: overrides.shell } : {}),
      ...(overrides.network ? { network: overrides.network } : {}),
      ...(overrides.git ? { git: overrides.git } : {}),
    },
    approvalPolicy: "always",
    concurrency: 1,
  };
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-tools-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-tools-outside-"));
  fs.writeFileSync(path.join(workspace, "a.txt"), "hello world");
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe("buildToolRegistry", () => {
  it("selects fs/shell/git families from the tools list", () => {
    const reg = buildToolRegistry(makeConfig({ tools: ["fs", "shell", "git"] }));
    const names = reg.map((t) => t.name);
    expect(names).toContain("fs_read");
    expect(names).toContain("fs_write");
    expect(names).toContain("fs_list");
    expect(names).toContain("shell_exec");
    expect(names).toContain("git_status");
    expect(names).toContain("git");
  });

  it("web_fetch is ABSENT by default (network denied) even if network is in tools", () => {
    const reg = buildToolRegistry(makeConfig({ tools: ["network", "fs"] }));
    expect(reg.map((t) => t.name)).not.toContain("web_fetch");
  });

  it("web_fetch is present only when permissions.network === 'allow'", () => {
    const reg = buildToolRegistry(makeConfig({ tools: ["fs"], network: "allow" }));
    expect(reg.map((t) => t.name)).toContain("web_fetch");
  });
});

describe("toOllamaToolDefs — tools[] contract", () => {
  it("emits function defs with type/function.name/description/parameters", () => {
    const defs = toOllamaToolDefs(buildToolRegistry(makeConfig({ tools: ["fs"] })));
    for (const d of defs) {
      expect(d.type).toBe("function");
      expect(typeof d.function.name).toBe("string");
      expect(typeof d.function.description).toBe("string");
      expect(typeof d.function.parameters).toBe("object");
      expect((d.function.parameters as { type?: string }).type ?? "object").toBe("object");
    }
    expect(defs.some((d) => d.function.name === "fs_read")).toBe(true);
  });
});

describe("fs tools", () => {
  it("fs_read inside the allowlist succeeds", async () => {
    const target = path.join(workspace, "a.txt");
    const res = await fsRead.execute(
      { workingDirectory: workspace, allowlist: [workspace] },
      { path: target },
    );
    expect(res.ok).toBe(true);
    expect(res.output).toContain("hello world");
  });

  it("fs_read outside the allowlist fails (does NOT execute) so the gate can ask", async () => {
    const target = path.join(outside, "a.txt");
    fs.writeFileSync(target, "secret");
    const res = await fsRead.execute({ workingDirectory: workspace, allowlist: [workspace] }, { path: target });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/outside|allowlist/);
  });

  it("fs_list reads a directory", async () => {
    const res = await fsList.execute(
      { workingDirectory: workspace, allowlist: [workspace] },
      { path: workspace },
    );
    expect(res.ok).toBe(true);
    expect(res.output).toContain("a.txt");
  });

  it("fs_write writes a temp file inside the allowlist", async () => {
    const target = path.join(workspace, "new", "nested.txt");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const res = await fsWrite.execute(
      { workingDirectory: workspace, allowlist: [workspace] },
      { path: target, content: "fresh" },
    );
    expect(res.ok).toBe(true);
    expect(res.filesTouched).toEqual([target]);
    expect(fs.readFileSync(target, "utf8")).toBe("fresh");
  });

  it("fs_write to a NEW file resolves the PARENT directory then prefix-checks (risk 4)", () => {
    // fs_write to a path whose parent does not exist inside the workspace is a
    // new-file write. resolveWriteTarget must return inside:true for a genuine
    // new file under a real allowlisted parent…
    const inside = path.join(workspace, "brand-new.txt");
    expect(resolveWriteTarget(inside, [workspace]).inside).toBe(true);
    expect(resolveWriteTarget(inside, [workspace]).resolved).toBe(inside);
  });

  it("fs_write to a NEW file whose parent is outside the allowlist is NOT inside (symlink/escape)", () => {
    const escape = path.join(outside, "brand-new.txt");
    expect(resolveWriteTarget(escape, [workspace]).inside).toBe(false);
  });

  it("fs_write rejects a symlink whose parent escapes the allowlist", async () => {
    // Make an allowlisted dir contain a symlink pointing outside the workspace.
    const link = path.join(workspace, "escape");
    fs.symlinkSync(outside, link);
    const target = path.join(link, "file.txt");
    // The symlink parent resolves (realpath) to outside → escape detected.
    const r = resolveWriteTarget(target, [workspace]);
    expect(r.inside).toBe(false);
    const res = await fsWrite.execute({ workingDirectory: workspace, allowlist: [workspace] }, { path: target, content: "x" });
    expect(res.ok).toBe(false);
  });

  it("fs_write outside allowlist fails (does NOT execute) so the gate can ask", async () => {
    const target = path.join(outside, "file.txt");
    const res = await fsWrite.execute({ workingDirectory: workspace, allowlist: [workspace] }, { path: target, content: "x" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/allowlist|outside/);
  });
});

describe("shell tool", () => {
  it("shell_exec runs an executable with an argv array and returns an exit code", async () => {
    const res = await shellExec.execute(
      { workingDirectory: workspace, allowlist: [workspace] },
      { command: "echo", args: ["-n", "hi"] },
    );
    expect(res.ok).toBe(true);
    expect(res.output).toContain("hi");
  });

  it("shell_exec runs `true` (exit 0)", async () => {
    const res = await shellExec.execute(
      { workingDirectory: workspace, allowlist: [workspace] },
      { command: "true" },
    );
    expect(res.ok).toBe(true);
  });

  it("shell_exec with a cwd outside the allowlist is refused", async () => {
    const res = await shellExec.execute(
      { workingDirectory: workspace, allowlist: [workspace] },
      { command: "true", cwd: outside },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/cwd outside|allowlist/);
  });

  it("shell_exec rejects a shell-string command with metacharacters (no shell interpolation)", async () => {
    const res = await shellExec.execute(
      { workingDirectory: workspace, allowlist: [workspace] },
      { command: "echo; rm -rf /", args: [] },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/single executable token/);
  });

  it("shell_exec reports a non-zero exit code", async () => {
    const res = await shellExec.execute(
      { workingDirectory: workspace, allowlist: [workspace] },
      { command: "false" },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/exit/);
  });

  it("M2: rejects an interpreter code-string invocation (bash -c '<arbitrary>' — unbounded host access)", async () => {
    // `bash -c "<string>"` would run a NEW shell with FULL host access — the
    // allowlist only gates the cwd, so this must be refused BEFORE exec.
    const res = await shellExec.execute(
      { workingDirectory: workspace, allowlist: [workspace] },
      { command: "bash", args: ["-c", "cat /etc/shadow"] },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/code-string|cannot run/);
  });

  it("M2: rejects python -c / node -e / perl -e / ruby -e code-string flags", async () => {
    const bad: Array<[string, string[]]> = [
      ["python", ["-c", "import os; os.system('curl http://169.254.169.254/')"]],
      ["node", ["-e", "require('child_process').execSync('whoami')"]],
      ["perl", ["-e", "system('id')"]],
      ["ruby", ["-e", "system('cat /etc/passwd')"]],
      ["python3", ["--eval", "x"]],
    ];
    for (const [cmd, args] of bad) {
      const res = await shellExec.execute(
        { workingDirectory: workspace, allowlist: [workspace] },
        { command: cmd, args },
      );
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/code-string|cannot run/);
    }
  });

  it("M2: a bare interpreter WITH a real script file (no code flag) is still allowed", async () => {
    // `node script.js` has no code-string flag, so it remains a legitimate
    // arg-array execution (the script is a file inside the workspace).
    const script = path.join(workspace, "hello.js");
    fs.writeFileSync(script, "console.log('node-ok');");
    const res = await shellExec.execute(
      { workingDirectory: workspace, allowlist: [workspace] },
      { command: "node", args: [script] },
    );
    expect(res.ok).toBe(true);
    expect(res.output).toContain("node-ok");
  });

  it("M2: git -c config override (alias escape) is rejected by the git tool", async () => {
    const res = await git.execute(
      { workingDirectory: workspace, allowlist: [workspace] },
      { args: ["-c", "alias.run=!sh", "log"] },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/'?\-c'?|-c/);
  });

  it("M2: git alias.*=<string> definition is rejected by the git tool", async () => {
    const res = await git.execute(
      { workingDirectory: workspace, allowlist: [workspace] },
      { args: ["config", "alias.evil", "!echo pwned"] },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/alias/);
  });

  it("MINOR: fs_write with a missing intermediate directory reports an accurate reason (not 'outside allowlist')", async () => {
    const target = path.join(workspace, "missing-subdir", "nested.txt");
    const res = await fsWrite.execute(
      { workingDirectory: workspace, allowlist: [workspace] },
      { path: target, content: "x" },
    );
    expect(res.ok).toBe(false);
    // Not the out-of-allowlist misdiagnosis — a genuine missing-parent reason.
    expect(res.error).toMatch(/parent directory does not exist/);
    expect(res.error).not.toMatch(/outside workspace allowlist/);
  });
});

describe("web_fetch tool", () => {
  it("is not invoked by the registry when network is denied", () => {
    // Registry absence is the primary gate; this just documents webFetch exists.
    expect(webFetch.name).toBe("web_fetch");
    expect(webFetch.permissionClass).toBe("network");
  });

  it("MINOR/SSRF: blocks loopback, link-local, metadata and private RFC1918 hosts even when network is allowed", async () => {
    expect(isBlockedFetchHost("localhost")).toBe(true);
    expect(isBlockedFetchHost("127.0.0.1")).toBe(true);
    expect(isBlockedFetchHost("127.8.8.8")).toBe(true); // 127.0.0.0/8
    expect(isBlockedFetchHost("::1")).toBe(true);
    expect(isBlockedFetchHost("169.254.169.254")).toBe(true);
    expect(isBlockedFetchHost("metadata.google.internal")).toBe(true);
    expect(isBlockedFetchHost("10.0.0.5")).toBe(true); // private RFC1918 10/8
    expect(isBlockedFetchHost("172.16.0.5")).toBe(true); // 172.16/12
    expect(isBlockedFetchHost("172.31.255.255")).toBe(true); // 172.16/12 upper
    expect(isBlockedFetchHost("192.168.1.100")).toBe(true); // 192.168/16
    // Legit public hosts pass.
    expect(isBlockedFetchHost("example.com")).toBe(false);
    expect(isBlockedFetchHost("8.8.8.8")).toBe(false);
  });

  it("MINOR/SSRF: web_fetch.execute refuses a loopback URL before any fetch", async () => {
    const res = await webFetch.execute(
      { workingDirectory: workspace, allowlist: [workspace] },
      { url: "http://localhost:5000/admin" },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/blocked/);
  });
});
