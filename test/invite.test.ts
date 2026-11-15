// 招待の口。cf-memory に行があること = このサービスを使えること、なので行を作る操作が
// そのまま招待になる(2026-08-19)。ここが壊れると誰も cf-memory に入れなくなるか、
// 逆に誰でも自分を招待できるようになる。
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { TEST_RESOURCE, accessEnvVars, bearerTokenFor, setupAccessAuth } from "./helpers";

let mf: Miniflare;
let db: D1Database;
let env: Parameters<typeof app.request>[2];
let jwtFor: (email: string) => Promise<string>;

const OWNER = "owner@example.com";

async function applyMigrations(d: D1Database): Promise<void> {
  const dir = join(process.cwd(), "migrations");
  for (const f of readdirSync(dir).filter((x) => /^\d+_.*\.sql$/.test(x)).sort()) {
    const raw = readFileSync(join(dir, f), "utf8")
      .split("\n")
      .map((line) => { const i = line.indexOf("--"); return i >= 0 ? line.slice(0, i) : line; })
      .join("\n");
    for (const stmt of raw.split(";")) { const t = stmt.trim(); if (t) await d.prepare(t).run(); }
  }
}

/** ブラウザから、その住所の人として叩く。 */
async function as(email: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("cookie", `CF_Authorization=${await jwtFor(email)}`);
  headers.set("origin", "https://memory.test");
  return app.request(`https://memory.test${path}`, { ...init, headers }, env);
}

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: ["DB"] }));
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applyMigrations(db);
  jwtFor = await setupAccessAuth();
  env = { DB: db, OWNER_HANDLE: "owner", ...accessEnvVars(OWNER) } as unknown as Parameters<typeof app.request>[2];
});
afterAll(async () => { await mf?.dispose(); });

const invite = (by: string, email: string) =>
  as(by, "/api/v1/admin/members", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });

describe("招待", () => {
  it("所有者は人を招ける。招かれた人はその瞬間から入れる", async () => {
    // 招待前は断られる。
    expect((await as("newbie@example.com", "/api/v1/notes")).status).toBe(403);

    const res = await invite(OWNER, "newbie@example.com");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ handle: "newbie", created: true });

    // 招待後は入れて、自分の空の領域を得る。
    expect((await as("newbie@example.com", "/api/v1/notes")).status).toBe(200);
  });

  it("招待されただけの人は他人を招けない", async () => {
    // cf-memory は招待された人の中で権限を分けないが、「招待できる」だけは別。
    // ここが開くと、1人入れた時点で誰でも入れられるのと同じになる。
    const res = await invite("newbie@example.com", "intruder@example.com");
    expect(res.status).toBe(403);
    const row = await db.prepare("SELECT id FROM users WHERE lower(email)=?").bind("intruder@example.com").first();
    expect(row).toBeNull();
  });

  it("招待されていない人も他人を招けない", async () => {
    const res = await invite("stranger@example.com", "intruder2@example.com");
    expect(res.status).toBe(403);
    const row = await db.prepare("SELECT id FROM users WHERE lower(email)=?").bind("intruder2@example.com").first();
    expect(row).toBeNull();
  });

  it("機械のトークンでは招けない", async () => {
    // 招待は人の行を作る。作られた行はトークンを失効させても残るので、
    // 「失効は次のリクエストで効く」という保証を素通りする永続的な権限になる。
    const tok = await bearerTokenFor({ sub: "machine:build-agent", aud: TEST_RESOURCE, scopes: "notes:read notes:write" });
    const res = await app.request(
      "https://memory.test/api/v1/admin/members",
      { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify({ email: "bot-invited@example.com" }) },
      env,
    );
    expect(res.status).toBe(403);
  });

  it("同じ住所を二度招いても行は増えない", async () => {
    const again = await invite(OWNER, "newbie@example.com");
    expect(await again.json()).toMatchObject({ created: false });
    const rows = await db.prepare("SELECT COUNT(*) AS n FROM users WHERE lower(email)=?").bind("newbie@example.com").first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it("所有者は外せない", async () => {
    // 外すと誰も招待できなくなり、復旧手段が D1 直叩きしか残らない。
    const res = await as(OWNER, "/api/v1/admin/members/owner", { method: "DELETE" });
    expect(res.status).toBe(400);
    expect((await as(OWNER, "/api/v1/notes")).status).toBe(200);
  });

  it("取り消して招き直すと、同じ行に戻る（ノートを失わない）", async () => {
    // 2026-08-20、実地確認の準備中に発覚。取り消しが email を NULL にしていたので、
    // 再招待は email で行を引けず新しい行を作り、元の行とノートが孤児になっていた。
    // 「取り消して戻す」だけでその人の記憶が消える形。
    await invite(OWNER, "roundtrip@example.com");
    const before = await db.prepare("SELECT id FROM users WHERE handle='roundtrip'").first<{ id: string }>();
    // その人が何か書いた状態にする。
    await db
      .prepare("INSERT INTO notes (id,user_id,slug,title,body_md,frontmatter_json,kind,content_hash,created_at,updated_at) VALUES (?,?,?,?,?,'{}','note','h',1,1)")
      .bind("n_roundtrip", before!.id, "roundtrip-note", "残るべきノート", "roundtrip-body")
      .run();

    await as(OWNER, "/api/v1/admin/members/roundtrip", { method: "DELETE" });
    expect((await as("roundtrip@example.com", "/api/v1/notes")).status).toBe(403);

    const again = await invite(OWNER, "roundtrip@example.com");
    expect(await again.json()).toMatchObject({ handle: "roundtrip", restored: true });

    // 行が増えていないこと。増えていたら元のノートは孤児。
    const rows = await db.prepare("SELECT COUNT(*) AS n FROM users WHERE handle LIKE 'roundtrip%'").first<{ n: number }>();
    expect(rows?.n).toBe(1);
    const after = await db.prepare("SELECT id FROM users WHERE handle='roundtrip'").first<{ id: string }>();
    expect(after?.id).toBe(before?.id);
    // 書いたものが自分から見えること。
    expect(await (await as("roundtrip@example.com", "/api/v1/notes")).text()).toContain("roundtrip-note");
  });

  it("招待を取り消すと入れなくなるが、書いたものは消えない", async () => {
    const before = await db.prepare("SELECT id FROM users WHERE handle='newbie'").first<{ id: string }>();
    const res = await as(OWNER, "/api/v1/admin/members/newbie", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await as("newbie@example.com", "/api/v1/notes")).status).toBe(403);
    // 行は残す。ノートが user_id で紐づいているので、消すと孤児になる。
    const after = await db.prepare("SELECT id FROM users WHERE handle='newbie'").first<{ id: string }>();
    expect(after?.id).toBe(before?.id);
  });
});
