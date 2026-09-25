/**
 * Web fetch tool — web_fetch (Phase 5 Stage D).
 *
 * OFF BY DEFAULT (decision Q6): the tool is ABSENT from the registry unless the
 * house explicitly allows network access (`permissions.network === 'allow'`) or
 * explicitly enables the `network` tool. When absent from the registry it is
 * also absent from the `tools[]` payload sent to Ollama, so the model cannot
 * call a tool that is not defined.
 *
 * Network access itself is gated by `permissions.network` in Stage E. This tool
 * only makes the fetch when the gate says execute. Raw `fetch`, no dependency.
 */

import { z } from "zod";
import type { OllamaTool, ToolContext, ToolResult } from "./types";

/** Cap on the response body captured for a tool result. */
const MAX_WEB_FETCH_BYTES = 256_000;

/**
 * Phase 5 MINOR — SSRF protection. Even when the house opts into
 * `permissions.network='allow'`, we never fetch loopback / link-local / metadata /
 * private RFC1918 addresses: the model could otherwise hit the host's
 * cloud-instance metadata (`169.254.169.254`), localhost services, or the
 * private LAN. These are blocked regardless of the allow setting. There is no
 * explicit opt-in to re-enable them (they are never legitimately needed by an
 * agent fetching public content).
 */
export function isBlockedFetchHost(hostname: string): boolean {
  const host = (hostname || "").toLowerCase().replace(/\.$/, "");
  // Literal loopback / link-local / metadata names.
  if (host === "localhost") return true;
  if (host === "metadata.google.internal") return true;
  if (host.endsWith(".localhost")) return true;
  // IPv4 forms.
  // - parse dotted-quad or bare "127.0.0.1"
  const v4m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4m) {
    const [a, b, c, d] = v4m.slice(1).map(Number);
    if (a <= 255 && b <= 255 && c <= 255 && d <= 255) {
      // 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 0.0.0.0/8
      if (a === 127) return true;
      if (a === 10) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      if (a === 169 && b === 254) return true;
      if (a === 0) return true;
    }
  }
  // IPv6 loopback ::1 and link-local fe80::/10.
  if (host === "::1" || host === "::") return true;
  if (/^fe80:/i.test(host)) return true;
  return false;
}

export const webFetch: OllamaTool = {
  name: "web_fetch",
  description: "Fetch a URL's text content (GET). Only available when the house allows network access.",
  permissionClass: "network",
  parameters: {
    type: "object",
    properties: { url: { type: "string", description: "Absolute http(s) URL to fetch" } },
    required: ["url"],
  },
  argsSchema: z.object({ url: z.string().url() }),
  async execute(ctx: ToolContext, args): Promise<ToolResult> {
    const url = (args as { url: string }).url;
    if (!/^https?:\/\//.test(url)) {
      return { ok: false, output: "", error: "web_fetch: only http(s) URLs are allowed" };
    }
    // SSRF guard (MINOR): reject loopback/link-local/private hosts up front.
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      return { ok: false, output: "", error: "web_fetch: invalid URL" };
    }
    if (isBlockedFetchHost(hostname)) {
      return { ok: false, output: "", error: `web_fetch: fetch to ${hostname} is blocked (loopback/private/metadata address)` };
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      const text = await res.text();
      const trimmed = text.length > MAX_WEB_FETCH_BYTES ? `${text.slice(0, MAX_WEB_FETCH_BYTES)}\n…(truncated)` : text;
      return { ok: res.ok, output: trimmed };
    } catch (err) {
      return { ok: false, output: "", error: `web_fetch: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};
