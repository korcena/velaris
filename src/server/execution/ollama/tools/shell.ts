/**
 * Shell tool — shell_exec (Phase 5 Stage D).
 *
 * EXECUTION SAFETY:
 *  - Executes via `node:child_process` `execFile` with an ARGUMENT ARRAY — NEVER
 *    a shell-string interpolated from model output. execFile does not spawn a
 *    shell, so metacharacters inside `args` are literal data and cannot chain a
 *    second command.
 *  - `cwd` (optional) is validated via `resolveSafePath` against the allowlist.
 *  - A hard timeout caps runaway commands; the child is killed on timeout.
 *  - The default shell permission mode is `ask` (Stage E) — every shell call is
 *    approval-gated unless the house opts into `allow`.
 *
 * THREAT MODEL — WHAT IS CONTAINED, WHAT IS NOT (honest):
 *  - The workspace allowlist scopes the WORKING DIRECTORY ONLY. It does NOT
 *    constrain what a command can reach. `cat /etc/shadow`, `curl`, `find /`, or
 *    any non-interpreter binary still runs with the engine's full host
 *    privileges. shell_exec is "run a program on this host", not a sandbox; the
 *    permission mode + approval gate is the real control.
 *  - On top of that this module enforces a DEFENSE-IN-DEPTH interpreter guard:
 *    an interpreter invoked with an inline-code flag (`bash -c '<code>'`,
 *    `python -c`, `node -e`, `pwsh -Command`, …) is REJECTED. That single flag
 *    turns an approved, inspectable argv into an arbitrary unbounded host
 *    command and is trivially machine-driven, so it is refused outright. The
 *    guard:
 *      • normalises the interpreter identity via basename + realpath, so `bash`,
 *        `/bin/bash`, `./bash` and a symlink to bash all resolve to `bash`;
 *      • detects combined short flags (`-lc`, `-ic`, `-xc`), attached/`=` forms
 *        (`-c=`, `--command=`) and unique long-flag abbreviations (`--co`);
 *      • rejects privilege-elevation wrappers (sudo/doas/su/pkexec/runuser);
 *      • for a NAMED set of command-carrying wrappers (`env`, `nice`, `timeout`,
 *        `command`, `nohup`, `xargs`, `stdbuf`, `setsid`, `ionice`, `chrt`,
 *        `unbuffer`, `busybox`, `time`), locates the first wrapped interpreter
 *        and re-applies the interpreter rule from there — so `env bash -c`,
 *        `nice bash -c`, `timeout 5 bash -c`, `xargs bash -c`, `busybox sh -c`
 *        and nested chains (`env nice bash -c`) are caught;
 *      • rejects `env -S/--split-string`, which hides a command inside one
 *        string token and so evades token-level scanning.
 *  - RESIDUAL RISK the guard does NOT close (be honest):
 *      • a non-interpreter program that can itself execute code or write files
 *        (`awk 'BEGIN{system(...)}'`, `find -exec`, `make`, `docker`, package
 *        scripts, `tar --to-command`, …) is still reachable;
 *      • an UNKNOWN wrapper not in the named set (`strace bash -c`,
 *        `ltrace bash -c`, `script -c 'bash -c …'`) can still smuggle a wrapped
 *        interpreter — the set covers the common wrappers only;
 *      • interpreter environment injection (`env BASH_ENV=… bash script.sh`,
 *        `LD_PRELOAD`, `NODE_OPTIONS`, `--rcfile`, `-i`/interactive startup
 *        files) is not inspected;
 *      • `deno eval` is caught, but other interpreters' code-as-subcommand
 *        forms are only covered when explicitly listed.
 *    Containing a determined model requires OS-level isolation
 *    (namespaces/seccomp/container), which this tool does not provide. Approval
 *    prompts are the boundary; the guard only removes the "one obvious flag"
 *    foot-gun.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolveSafePath } from "@/lib/paths";
import type { OllamaTool, ToolContext, ToolResult } from "./types";

/** Default per-call timeout (ms). Overridable per runtime for tests. */
export const DEFAULT_SHELL_TIMEOUT_MS = 30_000;
/** Hard cap on stdout/stderr captured to avoid unbounded memory. */
export const MAX_SHELL_OUTPUT = 64_000;

function run(command: string, argv: string[], opts: { cwd?: string; timeoutMs: number }): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    execFile(
      command,
      argv,
      { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: MAX_SHELL_OUTPUT, windowsHide: true },
      (err, stdout, stderr) => {
        const signal = (err as { signal?: string } | null)?.signal;
        const timedOut = signal === "SIGTERM";
        const code = err
          ? (err as { code?: number | null } | null)?.code ?? null // ENOENT (spawn fail) has code -2
          : 0;
        const out = (typeof stdout === "string" ? stdout : String(stdout));
        const errText = typeof stderr === "string" ? stderr : String(stderr);
        // A spawn-time failure (ENOENT / invalid command) surfaces as an err with
        // a non-exit code + a message, not a normal exit code.
        if (err && code === null) {
          resolve({ stdout: out, stderr: (err as { message?: string })?.message ?? errText, code: -2 });
          return;
        }
        resolve({ stdout: out, stderr: errText, code: timedOut ? null : code });
      },
    );
  });
}

export const shellExec: OllamaTool = {
  name: "shell_exec",
  description:
    "Run a command in the house workspace. Supply the command as the executable name and an " +
    "array of arguments (no shell interpolation). Optionally give a cwd inside the workspace.",
  permissionClass: "shell",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Executable path or name on PATH" },
      args: { type: "array", items: { type: "string" }, description: "Argument array (never a shell string)" },
      cwd: { type: "string", description: "Optional working directory (absolute, inside workspace)" },
    },
    required: ["command"],
  },
  argsSchema: z.object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    cwd: z.string().optional(),
  }),
  async execute(ctx: ToolContext, args): Promise<ToolResult> {
    const { command, cwd } = args as { command: string; args?: string[]; cwd?: string };
    // Command must be a single executable token (never a shell string). execFile
    // would fail to spawn a multi-token command, but we reject early so the model
    // learns the correct contract instead of getting an opaque ENOENT.
    try {
      assertNoShellMetachars(command);
    } catch (err) {
      return {
        ok: false,
        output: "",
        error: err instanceof Error ? err.message : String(err),
      };
    }
    // A model-supplied cwd must stay inside the allowlist. Resolve it BEFORE the
    // command-identity check so relative interpreter paths (`./bash`, `bin/sh`)
    // normalize against the directory execFile will actually use.
    let resolvedCwd: string | undefined = ctx.workingDirectory;
    if (cwd) {
      try {
        resolvedCwd = resolveSafePath(cwd, ctx.allowlist);
      } catch (err) {
        return {
          ok: false,
          output: "",
          error: `shell_exec: cwd outside workspace allowlist (${err instanceof Error ? err.message : String(err)})`,
        };
      }
    }
    // Phase 5 M2 — interpreter code-string rejection. Even with an argument
    // array, execFile of an interpreter like `bash -c "<arbitrary string>"` gets
    // the string as a NEW shell command with FULL host access (the allowlist
    // only gates the working directory, not the command's reach). Reject any
    // invocation that can smuggle a code string through a flag, BEFORE exec.
    const argv = (args as { args?: string[] }).args ?? [];
    const injection = describeCodeStringInjection(command, argv, resolvedCwd);
    if (injection) {
      return {
        ok: false,
        output: "",
        error: `shell_exec: refused — ${injection}. Interpreter code-string flags ('-c', '-e', '--eval', '-p', '-J', '--command', …) and command-carrying wrappers are not allowed: they would run an unbounded host command. Use a subcommand/script file inside the workspace instead.`,
      };
    }
    try {
      const { stdout, stderr, code } = await run(command, argv, {
        cwd: resolvedCwd,
        timeoutMs: DEFAULT_SHELL_TIMEOUT_MS,
      });
      if (code !== 0) {
        return {
          ok: false,
          output: stdout,
          error: `shell_exec: exit ${code ?? "timeout"} — ${stderr.slice(0, 2000)}`,
        };
      }
      return { ok: true, output: stdout || (stderr ? `(stderr) ${stderr}` : "(no output)") };
    } catch (err) {
      return {
        ok: false,
        output: "",
        error: `shell_exec: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

/** Ensure `command` is just a single token (no shell metacharacters). */
export function assertNoShellMetachars(command: string): void {
  if (/[\s;&|<>`$(){}!]/.test(command)) {
    throw new Error(`shell_exec: command must be a single executable token, got: ${command}`);
  }
}

/**
 * Exact code-string flags from the original guard. Kept verbatim (some are
 * interpreter-specific; rejecting a flag a program does not define is safe and
 * avoids having to model each program's full option grammar). Long names are
 * also matched by unique abbreviation and `=`-attached form below.
 */
const EXPLICIT_CODE_STRING_FLAGS = new Set([
  "-c", "--command", "-e", "--eval", "-p", "--print",
  "-J", "--json", "-P", "--print-functions",
]);

/** The long-form subset of the above, for abbreviation / `--flag=value` matching. */
const LONG_CODE_FLAGS = ["command", "eval", "print", "json", "print-functions"];

/**
 * Interpreter families → the SHORT flag letters whose argument is inline source
 * code. A combined short cluster containing any of these letters is treated as
 * a code flag (`-lc`, `-ic`, `-xc`, `-cfoo`, `-ep`, …).
 */
const INTERPRETER_CODE_LETTERS: Record<string, readonly string[]> = {
  shell: ["c"],
  python: ["c"],
  node: ["e", "p"],
  perl: ["e"],
  ruby: ["e"],
  php: ["r"],
  lua: ["e"],
  osascript: ["e"],
  // PowerShell long options use a single dash; handled by explicit flags below.
  pwsh: [],
};

/**
 * Interpreters that also accept a code string as a literal SUBCOMMAND rather
 * than a flag (`deno eval '...'`). Rejected when such a subcommand is present.
 */
const INTERPRETER_CODE_SUBCOMMANDS: Record<string, readonly string[]> = {
  deno: ["eval"],
};

/**
 * Case-insensitive explicit code flags for interpreters whose long options use
 * a SINGLE dash (PowerShell), which the generic short-cluster test cannot
 * distinguish from a combined short cluster.
 */
const INTERPRETER_EXPLICIT_CODE_FLAGS: Record<string, readonly string[]> = {
  pwsh: ["-c", "-command", "-encodedcommand", "-ec"],
  powershell: ["-c", "-command", "-encodedcommand", "-ec"],
};

const INTERPRETER_FAMILIES: Record<string, keyof typeof INTERPRETER_CODE_LETTERS> = {
  bash: "shell", sh: "shell", zsh: "shell", dash: "shell", ksh: "shell",
  fish: "shell", ash: "shell", csh: "shell", tcsh: "shell",
  python: "python", python2: "python", python3: "python", pypy: "python", pypy3: "python",
  node: "node", nodejs: "node", deno: "node", bun: "node",
  perl: "perl", ruby: "ruby", php: "php",
  lua: "lua", luajit: "lua", osascript: "osascript",
  pwsh: "pwsh", powershell: "pwsh",
};

/**
 * Command-carrying wrappers: the real command can be a later argv element
 * (`env bash -c`, `nice bash -c`, `timeout 5 bash -c`, `xargs bash -c`,
 * `busybox sh -c`, …). When one of these is the command we scan for a wrapped
 * interpreter and re-apply the interpreter rule from that point.
 *
 * NOTE: this is deliberately a NAMED set rather than "scan every argv token for
 * an interpreter". A blind global scan would reject legitimate commands like
 * `grep -c bash file` (pattern is the literal string "bash"). Unknown wrappers
 * (e.g. `strace bash -c`) remain a documented residual risk.
 */
const WRAPPER_COMMANDS = new Set([
  "env", "nice", "timeout", "command", "nohup", "xargs", "stdbuf", "setsid",
  "ionice", "chrt", "unbuffer", "busybox", "time",
]);

/** Privilege elevation is never a legitimate use of this tool. */
const PRIVILEGE_WRAPPERS = new Set(["sudo", "doas", "su", "runuser", "pkexec"]);

/** An interpreter-specific code-subcommand test applied once an interpreter is found. */
function codeSubcommandReason(identity: string, tokens: string[]): string | null {
  const subcommands = INTERPRETER_CODE_SUBCOMMANDS[identity];
  if (!subcommands) return null;
  const sub = tokens.find((a) => !a.startsWith("-") && subcommands.includes(a));
  return sub ? `interpreter '${identity}' invoked with inline-code subcommand '${sub}'` : null;
}

/** Index of the first non-flag, non-`VAR=value` token that is a known interpreter. */
function firstWrappedInterpreterIndex(argv: string[], cwd?: string): number {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("-")) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue; // env assignment
    if (isKnownInterpreterName(resolveCommandIdentity(token, cwd))) return i;
  }
  return -1;
}

function isKnownInterpreterName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(INTERPRETER_FAMILIES, name);
}

function interpreterCodeLetters(name: string): readonly string[] {
  const family = INTERPRETER_FAMILIES[name];
  return family ? INTERPRETER_CODE_LETTERS[family] : [];
}

function findOnPath(name: string): string | null {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not here — keep looking
    }
  }
  return null;
}

/**
 * Normalize a command token to its interpreter identity. `bash`, `/bin/bash`,
 * `./bash`, `bin/bash`, a PATH-resolved `bash` and a symlink whose target is
 * bash all resolve to `"bash"`. Relative paths containing a separator are
 * resolved against `cwd` (the directory execFile will actually use). Falls back
 * to the basename when no realpath is possible.
 */
export function resolveCommandIdentity(command: string, cwd?: string): string {
  const base = path.basename(command);
  if (isKnownInterpreterName(base)) return base;
  let target: string | null = null;
  if (path.isAbsolute(command)) target = command;
  else if (command.includes(path.sep)) target = cwd ? path.resolve(cwd, command) : command;
  else if (base) target = findOnPath(base);
  if (target) {
    try {
      const realBase = path.basename(fs.realpathSync(target));
      if (isKnownInterpreterName(realBase)) return realBase;
    } catch {
      // unreadable/nonexistent — keep the basename
    }
  }
  return base;
}

/** Does this exact argv token carry an inline code string for `identity`? */
function isInlineCodeFlag(arg: string, identity: string): boolean {
  if (EXPLICIT_CODE_STRING_FLAGS.has(arg)) return true;

  // Single-dash long options (PowerShell): -Command, -EncodedCommand, -ec.
  const explicit = INTERPRETER_EXPLICIT_CODE_FLAGS[identity];
  if (explicit?.some((flag) => flag === arg.toLowerCase())) return true;

  const letters = interpreterCodeLetters(identity);

  // Short cluster / attached value. Consider the leading run of ASCII letters
  // after a single dash, up to an `=` or the start of an attached value:
  //   -c, -lc, -ic, -xc   → cluster containing a code letter
  //   -c=whoami           → head "c"
  //   -cfoo, -econsole…   → attached value; leading run contains a code letter
  // A pure flag cluster (all letters) is covered because the whole run is the
  // head. Non-letter-led values stop the run, so `-e<code>` still matches on e.
  if (arg.startsWith("-") && !arg.startsWith("--") && arg.length > 1) {
    const body = arg.slice(1);
    const eq = body.indexOf("=");
    const head = eq >= 0 ? body.slice(0, eq) : body;
    const leadingLetters = /^[A-Za-z]*/.exec(head)?.[0] ?? "";
    if (letters.some((letter) => leadingLetters.includes(letter))) return true;
  }

  // Long flag, unique abbreviation, or `--flag=value`.
  if (arg.startsWith("--")) {
    const eq = arg.indexOf("=");
    const body = (eq >= 0 ? arg.slice(2, eq) : arg.slice(2));
    if (body.length >= 1) {
      return LONG_CODE_FLAGS.some((knownBody) => {
        return knownBody === body || knownBody.startsWith(body);
      });
    }
  }
  return false;
}

/** `env -S`/`--split-string` hides a whole command inside one string token. */
function hasEnvSplitString(argv: string[]): boolean {
  return argv.some((a) => {
    if (a === "--split-string" || a.startsWith("--split-string=")) return true;
    // `--s`, `--sp`, … unique abbreviation of --split-string.
    if (/^--s(p(l(i(t(-(s(t(r(i(n(g)?)?)?)?)?)?)?)?)?)?)?$/.test(a)) return true;
    // `-S` or a cluster containing S (`-iS`).
    return /^-[A-Za-z]*S[A-Za-z]*$/.test(a);
  });
}

/**
 * Phase 5 M2 (hardened) — the containment rule.
 *
 * Reject when ANY of these hold:
 *  1. the (basename/realpath-normalized) command is a known interpreter and any
 *     argv token is an inline-code flag — exact (`-c`), combined (`-lc`),
 *     attached (`-c=`, `-cfoo`), long or long-abbreviated (`--command`, `--co`);
 *  2. the command is a privilege-elevation wrapper (sudo/doas/su/runuser/pkexec);
 *  3. the command is a known command-carrying wrapper (`env`, `nice`, `timeout`,
 *     `xargs`, `busybox`, …) and a later argv element is a wrapped interpreter
 *     that itself carries an inline-code flag (`env bash -c …`);
 *  4. the wrapper is `env` with `-S`/`--split-string`.
 *
 * Returns a human-readable reason, or `null` when the invocation is permitted.
 */
export function describeCodeStringInjection(command: string, argv: string[], cwd?: string): string | null {
  const identity = resolveCommandIdentity(command, cwd);

  if (PRIVILEGE_WRAPPERS.has(identity)) {
    return `privilege-elevation wrapper '${identity}' is not allowed`;
  }

  // Direct interpreter invocation: the command itself is the interpreter.
  if (isKnownInterpreterName(identity)) {
    for (const arg of argv) {
      if (isInlineCodeFlag(arg, identity)) {
        return `interpreter '${identity}' invoked with inline-code flag '${arg}'`;
      }
    }
    const subReason = codeSubcommandReason(identity, argv);
    if (subReason) return subReason;
    return null;
  }

  // Known command-carrying wrapper: locate the wrapped interpreter and re-apply
  // the rule from that point (`env VAR=x bash -c`, `timeout 5 bash -c`,
  // `xargs bash -c`, `busybox sh -c`, `nice bash -c`, …).
  if (WRAPPER_COMMANDS.has(identity)) {
    // `env -S`/`--split-string` folds a whole command into one token so
    // token-level scanning cannot see the wrapped interpreter.
    if (identity === "env" && hasEnvSplitString(argv)) {
      return "env --split-string (which hides a command inside one token) is not allowed";
    }
    const idx = firstWrappedInterpreterIndex(argv, cwd);
    if (idx >= 0) {
      const wrapped = resolveCommandIdentity(argv[idx], cwd);
      for (const arg of argv.slice(idx + 1)) {
        if (isInlineCodeFlag(arg, wrapped)) {
          return `wrapper '${identity}' carries interpreter '${wrapped}' with inline-code flag '${arg}'`;
        }
      }
      const subReason = codeSubcommandReason(wrapped, argv.slice(idx + 1));
      if (subReason) return subReason;
    }
  }

  return null;
}

/** Back-compat boolean form used by callers/tests. */
export function assertNoCodeStringInjection(command: string, argv: string[], cwd?: string): boolean {
  return describeCodeStringInjection(command, argv, cwd) !== null;
}

/** Binaries that accept an inline code string via a flag (not safe to allow). */
export function isInterpreter(command: string, cwd?: string): boolean {
  return isKnownInterpreterName(resolveCommandIdentity(command, cwd));
}
