#!/usr/bin/env node
/**
 * `npm run start` — starts the built web app (production Next) and the
 * Velaris Engine together, mirroring `npm run dev` but against the production build.
 */

import { spawn } from "node:child_process";

const children = [];

function start(name, cmd, args, envExtra = {}) {
  const child = spawn(cmd, args, {
    stdio: "inherit",
    env: { ...process.env, ...envExtra },
  });
  children.push(child);
  child.on("exit", () => shutdownAll(new Error(`${name} exited`)));
  return child;
}

let shuttingDown = false;
function shutdownAll(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reason) console.error("Stopping processes:", reason?.message ?? reason);
  for (const c of children) if (!c.killed) c.kill("SIGTERM");
}

function handleSignal(signal) {
  shutdownAll({ message: signal });
  setTimeout(() => process.exit(0), 500);
}

start("web", "npx", ["next", "start"], { PORT: process.env.VELARIS_PORT || "3000" });
start("engine", "npx", ["tsx", "src/engine/main.ts"]);

process.on("SIGINT", () => handleSignal("SIGINT"));
process.on("SIGTERM", () => handleSignal("SIGTERM"));
