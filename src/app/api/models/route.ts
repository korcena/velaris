import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/models — Phase 1 returns 501.
 * Phase 2 proxies OpenCode's `GET /api/model` via the engine.
 */
export async function GET() {
  return NextResponse.json(
    { error: "Model list not available until Phase 2" },
    { status: 501 },
  );
}
