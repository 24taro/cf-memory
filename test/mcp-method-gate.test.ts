import { describe, expect, it } from "vitest";
import { handleMcp } from "../src/mcp";
import type { Principal } from "../src/types";

// #121: GET /mcp used to return a 200 discovery body ({name, tools}). MCP
// Streamable HTTP clients (Claude Code CLI) interpret a 200 on GET as "an SSE
// stream is available here", fail to keep it open, and reconnect-loop — flooding
// the Worker with ~167k GET /mcp/day (99.6% of all traffic). cf-memory has no
// server-initiated notifications, so per the spec the endpoint offers no GET SSE
// stream and must answer non-POST requests with 405 (Allow: POST), which makes
// compliant clients stop retrying.

const ctx = {
  principal: {
    userId: "u_owner",
    handle: "owner",
    scopes: new Set(["notes:read", "notes:write"]),
    anonymous: false,
    actor: "agent",
    authSource: "bearer",
    isAdminFlag: false,
  } as Principal,
  services: {} as never,
  budget: 2000,
};

describe("MCP HTTP method gate (#121)", () => {
  it("GET /mcp returns 405 with Allow: POST (no reconnect-loop 200 discovery)", async () => {
    const res = await handleMcp(new Request("http://x/mcp", { method: "GET" }), ctx as never);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("non-POST methods (DELETE) are also rejected with 405 Allow: POST", async () => {
    const res = await handleMcp(new Request("http://x/mcp", { method: "DELETE" }), ctx as never);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("POST /mcp still handles JSON-RPC (tools/list) unchanged — 200 + tools array", async () => {
    const req = new Request("http://x/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const res = await handleMcp(req, ctx as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { tools?: unknown[] } };
    expect(Array.isArray(body.result?.tools)).toBe(true);
    expect((body.result?.tools ?? []).length).toBeGreaterThan(0);
  });
});
