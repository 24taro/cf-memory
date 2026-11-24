import { describe, expect, it } from "vitest";
import { applyBlockOp, BlockFullError } from "../src/memory";
import { handleMcp } from "../src/mcp";
import type { NoteRow, Principal } from "../src/types";

// The two write tools (notes_delete, memory_replace) are thin wiring over
// already-tested service methods (notes.softDelete, memory.setBlock →
// applyBlockOp). We black-box the MCP handler with a fake Services to assert
// the wiring (scope gate, note resolution, op/replaceTarget forwarding) without
// standing up D1 (handlers are otherwise wrangler-smoke-tested).

const OWNER = "u_owner";

function principal(scopes: string[], opts: Partial<Principal> = {}): Principal {
  return {
    userId: OWNER,
    handle: "owner",
    scopes: new Set(scopes),
    anonymous: false,
    actor: "agent",
    authSource: "bearer",
    isAdminFlag: false,
    ...opts,
  } as Principal;
}

function noteRow(over: Partial<NoteRow> = {}): NoteRow {
  return {
    id: "n_1",
    user_id: OWNER,
    slug: "wrong-note",
    title: "Wrong note",
    body_md: "oops",
    frontmatter_json: "{}",
    kind: "note",
    stage: "seedling",
    scope: "global",
    last_viewed_at: null,
    archived_at: null,
    pinned_block_label: null,
    char_limit: null,
    content_hash: "h",
    word_count: 1,
    view_count: 0,
    score: 0,
    created_at: 0,
    updated_at: 0,
    deleted_at: null,
    valid_from: null,
    valid_until: null,
    superseded_by: null,
    supersedes: null,
    ...over,
  };
}

interface Calls {
  softDelete: Array<{ id: string }>;
  setBlock: Array<{ label: string; op: string; value: string; charLimit?: number | null; replaceTarget?: string }>;
}

function makeCtx(p: Principal, opts: { note?: NoteRow | null; block?: { label: string; value: string; char_limit: number | null } } = {}) {
  const calls: Calls = { softDelete: [], setBlock: [] };
  const note = opts.note === undefined ? noteRow() : opts.note;
  const services = {
    notes: {
      getRowById: async (id: string) => (note && note.id === id ? note : null),
      getRowBySlug: async (_owner: string, slug: string) => (note && note.slug === slug ? note : null),
      // Mirrors getRowBySlug's slug-only matching in this fake; the real access
      // decision happens afterward via visibleToCaller/isReadable, same as
      // production's two-step resolveNote().
      getRowBySlugForCaller: async (_pr: Principal, slug: string) => (note && note.slug === slug ? note : null),
      softDelete: async (_pr: Principal, id: string) => {
        calls.softDelete.push({ id });
        return true;
      },
    },
    memory: {
      setBlock: async (_pr: Principal, label: string, op: string, value: string, charLimit?: number | null, replaceTarget?: string) => {
        calls.setBlock.push({ label, op, value, charLimit, replaceTarget });
        const current = opts.block?.value ?? "";
        const next = applyBlockOp(current, { op: op as "set" | "append" | "replace", value, charLimit, replaceTarget });
        return { label, title: label, value: next, char_limit: charLimit ?? null };
      },
    },
  };
  const ctx = {
    principal: p,
    services: services as never,
    budget: 2000,
  };
  return { ctx, calls };
}

async function call(ctx: unknown, name: string, args: Record<string, unknown>) {
  const req = new Request("http://x/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  // biome-ignore lint/suspicious/noExplicitAny: test cast for the internal ToolCtx
  const res = await handleMcp(req, ctx as any);
  const body = (await res.json()) as { result?: { content?: Array<{ text: string }>; isError?: boolean } };
  const text = body.result?.content?.[0]?.text ?? "";
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* plain-text error */
  }
  return { isError: body.result?.isError === true, text, parsed: parsed as Record<string, unknown> };
}

describe("notes_delete (MCP)", () => {
  it("soft-deletes a resolved note and returns {deleted,slug}", async () => {
    const { ctx, calls } = makeCtx(principal(["notes:write"]));
    const r = await call(ctx, "notes_delete", { slug: "wrong-note" });
    expect(r.isError).toBe(false);
    expect(r.parsed).toMatchObject({ deleted: true, slug: "wrong-note" });
    expect(calls.softDelete).toEqual([{ id: "n_1" }]);
  });

  it("rejects callers missing the notes:write scope (no delete attempted)", async () => {
    const { ctx, calls } = makeCtx(principal([]));
    const r = await call(ctx, "notes_delete", { slug: "wrong-note" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("notes:write");
    expect(calls.softDelete).toEqual([]);
  });

  it("returns deleted:false when the note is not visible/found", async () => {
    const { ctx, calls } = makeCtx(principal(["notes:write"]), { note: null });
    const r = await call(ctx, "notes_delete", { slug: "ghost" });
    expect(r.parsed).toMatchObject({ deleted: false });
    expect(calls.softDelete).toEqual([]);
  });

  it("does not resolve another user's note for a non-owner caller (owner-only, decision 9)", async () => {
    const other = principal(["notes:write"], { userId: "u_other" });
    const { ctx, calls } = makeCtx(other, { note: noteRow() });
    const r = await call(ctx, "notes_delete", { slug: "wrong-note" });
    expect(r.parsed).toMatchObject({ deleted: false });
    expect(calls.softDelete).toEqual([]);
  });
});

describe("memory_replace (MCP)", () => {
  it("forwards a replace op with find as the replaceTarget and honors char_limit", async () => {
    // The block comes back only to a caller that may read it (notes:read).
    const { ctx, calls } = makeCtx(principal(["notes:read", "notes:write"]), { block: { label: "facts", value: "region: us-west", char_limit: null } });
    const r = await call(ctx, "memory_replace", { label: "facts", find: "us-west", replace: "us-east", char_limit: 500 });
    expect(r.isError).toBe(false);
    expect(calls.setBlock).toEqual([{ label: "facts", op: "replace", value: "us-east", charLimit: 500, replaceTarget: "us-west" }]);
    expect((r.parsed.block as { value: string }).value).toBe("region: us-east");
  });

  // The answer depends on the stored block (length, block_full, a match), so a
  // write-only caller is refused before the block is touched.
  it("is refused for a caller without notes:read, without touching the block", async () => {
    const { ctx, calls } = makeCtx(principal(["notes:write"]), { block: { label: "facts", value: "region: us-west", char_limit: null } });
    const r = await call(ctx, "memory_replace", { label: "facts", find: "us-west", replace: "us-east", char_limit: 500 });
    expect(r.isError).toBe(true);
    expect(calls.setBlock).toEqual([]);
  });

  it("requires the notes:write scope", async () => {
    const { ctx, calls } = makeCtx(principal([]), { block: { label: "facts", value: "x", char_limit: null } });
    const r = await call(ctx, "memory_replace", { label: "facts", find: "a", replace: "b" });
    expect(r.isError).toBe(true);
    expect(calls.setBlock).toEqual([]);
  });

  it("rejects missing required args (find/replace)", async () => {
    const { ctx } = makeCtx(principal(["notes:read", "notes:write"]));
    const req = new Request("http://x/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_replace", arguments: { label: "facts" } } }),
    });
    // biome-ignore lint/suspicious/noExplicitAny: test cast for the internal ToolCtx
    const res = await handleMcp(req, ctx as any);
    const body = (await res.json()) as { error?: { message: string } };
    expect(body.error?.message).toContain("find");
  });
});

describe("memory_replace semantics (applyBlockOp replace)", () => {
  it("replaces only the matched substring", () => {
    expect(applyBlockOp("a-b-a", { op: "replace", value: "X", replaceTarget: "a" })).toBe("X-b-X");
  });
  it("is a silent no-op when find matches nothing", () => {
    expect(applyBlockOp("name: bob", { op: "replace", value: "alice", replaceTarget: "carol" })).toBe("name: bob");
  });
  it("REJECTS (block_full) when a replace would exceed char_limit, instead of truncating", () => {
    expect(() => applyBlockOp("region: somewhere", { op: "replace", value: "x".repeat(50), replaceTarget: "somewhere", charLimit: 12 })).toThrow(BlockFullError);
  });
});

describe("tools surface in tools/list", () => {
  it("lists notes_delete, memory_replace, and notes_get_many", async () => {
    const { ctx } = makeCtx(principal(["notes:write"]));
    const req = new Request("http://x/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    // biome-ignore lint/suspicious/noExplicitAny: test cast for the internal ToolCtx
    const res = await handleMcp(req, ctx as any);
    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    const names = body.result.tools.map((t) => t.name);
    expect(names).toContain("notes_delete");
    expect(names).toContain("memory_replace");
    expect(names).toContain("notes_get_many");
  });
});

describe("MCP batch response budget", () => {
  it("keeps completed write receipts and skips later calls after an oversized result", async () => {
    const { ctx, calls } = makeCtx(principal(["notes:read", "notes:write"]));
    const remove = (id: string) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "notes_delete", arguments: { slug: "wrong-note" } } });
    const request = new Request("http://x/mcp", {
      method: "POST",
      body: JSON.stringify([
        remove("first"),
        { jsonrpc: "2.0", id: "一覧", method: "tools/list" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        remove("last"),
      ]),
    });
    const limit = 1800;
    const response = await handleMcp(request, ctx, limit);
    const text = await response.text();
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(limit);
    expect(JSON.parse(text)).toEqual([
      expect.objectContaining({ id: "first", result: expect.any(Object) }),
      expect.objectContaining({ id: "一覧", error: expect.objectContaining({ code: -32002 }) }),
      expect.objectContaining({ id: "last", error: expect.objectContaining({ code: -32001 }) }),
    ]);
    expect(calls.softDelete).toEqual([{ id: "n_1" }]);
  });

  it("returns small batch responses in order and leaves notification responses empty", async () => {
    const { ctx } = makeCtx(principal([]));
    const request = new Request("http://x/mcp", {
      method: "POST",
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "2.0", id: "二", method: "ping" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
      ]),
    });
    expect(await (await handleMcp(request, ctx)).json()).toEqual([
      { jsonrpc: "2.0", id: 1, result: {} },
      { jsonrpc: "2.0", id: "二", result: {} },
    ]);
  });
});
