#!/usr/bin/env node
/**
 * `npm run dev` — starts the Next.js web process and the Velaris Engine stub
 * simultaneously, forwarding Ctrl+C (SIGINT) to both so shutdown is clean.
 *
 * Replaces direct use of `concurrently` (which also works; this gives finer
 * control over signal forwarding on this machine).
 */

import { spawn } from "node:child_process";

const children = [];
const colors = {
  web: "\x1b[36m", // cyan
  engine: "\x1b[35m", // magenta
  reset: "\x1b[0m",
};

function start(name, cmd, args, envExtra = {}) {
  const child = spawn(cmd, args, {
    stdio: "inherit",
    env: { ...process.env, ...envExtra },
  });

  const label = `${colors[name]}[${name}]${colors.reset}`;
  // Tag prefixed output lines so logs are attributable.
  if (child.stdout) {
    child.stdout.on("data", (d) => {
      process.stdout.write(d.toString().split("\n").map((l) => (l ? `${label} ${l}` : "")).join("\n") + (d.toString().endsWith("\n") ? "" : "\n"));
    });
  }
  if (child.stderr) {
    child.stderr.on("data", (d) => {
      process.stderr.write(d.toString().split("\n").map((l) => (l ? `${label} ${l}` : "")).join("\n") + (d.toString().endsWith("\n") ? "" : "\n"));
    });
  }

  child.on("exit", (code, signal) => {
    console.log(`${label} exited (code=${code} signal=${signal})`);
    // If either process dies unexpectedly, tear the other down too.
    shutdownAll(new Error(`${name} exited`));
  });

  children.push(child);
  return child;
}

let shuttingDown = false;

function shutdownAll(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reason) console.error("Stopping dev processes:", reason?.message ?? reason);
  for (const c of children) {
    if (!c.killed) c.kill("SIGTERM");
  }
}

function handleSignal(signal) {
  console.log(`dev.js received ${signal}`);
  shutdownAll({ message: signal });
  // Give children a moment, then force.
  setTimeout(() => process.exit(0), 500);
}

start("web", "npx", ["next", "dev"], { PORT: process.env.VELARIS_PORT || "3000" });
start("engine", "npx", ["tsx", "src/engine/main.ts"]);

process.on("SIGINT", () => handleSignal("SIGINT"));
process.on("SIGTERM", () => handleSignal("SIGTERM"));
