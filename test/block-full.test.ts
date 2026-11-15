// P0 forcing-function (memory-compression research): a core-memory block write
// that would exceed char_limit is REJECTED with BlockFullError instead of being
// silently truncated, at BOTH write points — applyBlockOp (set/replace) and the
// notes.upsert append clamp (append) — and the block is left UNCHANGED (no partial
// write). The MCP door surfaces a machine-readable `block_full` so the agent
// self-corrects. Drives the real services + app on a Miniflare D1.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleMcp } from "../src/mcp";
import { BlockFullError } from "../src/memory";
import { makeServices, type Services } from "../src/services";
import { principalFixture } from "./helpers";
import type { Principal } from "../src/types";

const OWNER = "u_bf_owner";
const p: Principal = principalFixture({ userId: OWNER, handle: "bf-owner" });
let mf: Miniflare;
let db: D1Database;
let services: Services;

async function applyMigrations(database: D1Database): Promise<void> {
  const dir = join(process.cwd(), "migrations");
  for (const f of readdirSync(dir).filter((x) => /^\d+_.*\.sql$/.test(x)).sort()) {
    const raw = readFileSync(join(dir, f), "utf8").split("\n").map((l) => { const i = l.indexOf("--"); return i >= 0 ? l.slice(0, i) : l; }).join("\n");
    for (const s of raw.split(";")) { const t = s.trim(); if (t) await database.prepare(t).run(); }
  }
}
const currentValue = async (label: string): Promise<string | undefined> => (await services.memory.listBlocks(p)).find((b) => b.label === label)?.value;

async function mcpMemory(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ctx = { principal: p, services: services as never, budget: 2000 };
  const r = new Request("http://x/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const res = await handleMcp(r, ctx as never);
  const body = (await res.json()) as { result?: { content?: Array<{ text: string }> } };
  return JSON.parse(body.result?.content?.[0]?.text ?? "{}") as Record<string, unknown>;
}

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: ["DB"] }));
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applyMigrations(db);
  await db.prepare("INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").bind(OWNER, "bf-owner", "bf-owner", "bf@e.com", "", 0, 0).run();
  services = makeServices(db);
});
afterAll(async () => { await mf?.dispose(); });

describe("block_full forcing-function — writes reject instead of truncating", () => {
  it("SET rejects an over-limit value and does not create/mutate the block", async () => {
    await expect(services.memory.setBlock(p, "bf-set", "set", "x".repeat(40), 20, undefined)).rejects.toBeInstanceOf(BlockFullError);
    expect(await currentValue("bf-set")).toBeUndefined(); // nothing written
  });

  it("APPEND (notes.upsert clamp path) rejects an overflowing append and leaves the block UNCHANGED", async () => {
    await services.memory.setBlock(p, "bf-app", "set", "12345", 10, undefined); // len 5, limit 10
    await expect(services.memory.setBlock(p, "bf-app", "append", "6789012", 10, undefined)).rejects.toBeInstanceOf(BlockFullError); // 5+1+7=13 > 10
    expect(await currentValue("bf-app")).toBe("12345"); // NOT partially appended, NOT truncated
    // an append that fits still works
    const ok = await services.memory.setBlock(p, "bf-app", "append", "678", 10, undefined); // 5+1+3=9
    expect(ok.value).toBe("12345\n678");
  });

  it("REPLACE (applyBlockOp path) rejects when the result overflows and leaves the block UNCHANGED", async () => {
    await services.memory.setBlock(p, "bf-rep", "set", "region: here", 20, undefined);
    await expect(services.memory.setBlock(p, "bf-rep", "replace", "x".repeat(40), 20, "here")).rejects.toBeInstanceOf(BlockFullError);
    expect(await currentValue("bf-rep")).toBe("region: here");
  });

  it("MCP memory_append surfaces a machine-readable {ok:false,error:'block_full',length,limit} the agent can self-correct on", async () => {
    await mcpMemory("memory_set", { label: "bf-mcp", value: "abcde", char_limit: 8 });
    const out = await mcpMemory("memory_append", { label: "bf-mcp", value: "fghij" }); // 5+1+5=11 > 8
    expect(out).toMatchObject({ ok: false, error: "block_full", label: "bf-mcp", limit: 8 });
    expect(typeof out.length).toBe("number");
    expect(await currentValue("bf-mcp")).toBe("abcde"); // unchanged via the door too
  });

  it("MCP notes_append to a full block-<label> slug degrades to block_full, not an uncaught 500, and leaves the block UNCHANGED", async () => {
    await mcpMemory("memory_set", { label: "bf-na", value: "abcde", char_limit: 8 }); // slug: block-bf-na, limit 8
    const out = await mcpMemory("notes_append", { slug: "block-bf-na", text: "fghij" }); // 5+1+5=11 > 8
    expect(out).toMatchObject({ ok: false, error: "block_full", limit: 8 });
    expect(typeof out.length).toBe("number");
    expect(await currentValue("bf-na")).toBe("abcde"); // no partial append, no truncation
    // the catch maps ONLY the overflow: a comfortably-fitting notes_append still writes through the notes door
    await mcpMemory("memory_set", { label: "bf-na-ok", value: "hi", char_limit: 100 }); // slug: block-bf-na-ok
    const ok = await mcpMemory("notes_append", { slug: "block-bf-na-ok", text: "world" });
    expect(ok.error).toBeUndefined();
    expect(typeof ok.id).toBe("string");
  });

  it("a null (unlimited) char_limit never rejects", async () => {
    const b = await services.memory.setBlock(p, "bf-unl", "set", "z".repeat(9999), null, undefined);
    expect(b.value).toHaveLength(9999);
  });
});
