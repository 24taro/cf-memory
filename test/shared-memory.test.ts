// 共有の記憶 (2026-08-20)。個人の記憶は個人のまま、プロジェクトの記憶は共有物に。
//
// ここで守りたいのは2つで、片方だけでは意味がない:
//   1. 種類どおりに共有される(project/reference は共有、user/feedback は個人)
//   2. 共有を足したことで個人の記憶が漏れない ← こちらが本命
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { makeServices } from "../src/services";
import { TEST_RESOURCE, accessEnvVars, bearerTokenFor, rsEnvVars, setupAccessAuth } from "./helpers";

const ALICE = { id: "u_alice", handle: "alice", email: "alice@example.com", account: "01KSPALICE00000000000000000" };
const BOB = { id: "u_bob", handle: "bob", email: "bob@example.com", account: "01KSPBOB0000000000000000000" };
const REPO_A = "github.com/acme/shopapp-taskhub";
const REPO_B = "github.com/acme/shopapp-career-ai";
const OTHER_REPO = "github.com/acme/auth";

let mf: Miniflare;
let db: D1Database;
let env: Parameters<typeof app.request>[2];
let aliceToken: string;
let bobToken: string;

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

async function seed(p: typeof ALICE): Promise<void> {
  await db
    .prepare("INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at,auth_user_id) VALUES (?,?,?,?,'',0,0,?)")
    .bind(p.id, p.handle, p.handle, p.email, p.account)
    .run();
}

const req = (path: string, token: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return app.request(`https://memory.test${path}`, { ...init, headers }, env);
};
const put = (token: string, body: unknown) =>
  req("/api/v1/notes", token, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const text = async (r: Response) => JSON.stringify(await r.json());

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: ["DB"] }));
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applyMigrations(db);
  await setupAccessAuth();
  await seed(ALICE);
  await seed(BOB);
  env = { DB: db, OWNER_HANDLE: ALICE.handle, ...accessEnvVars(ALICE.email), ...rsEnvVars() } as unknown as Parameters<typeof app.request>[2];
  aliceToken = await bearerTokenFor({ sub: `user:${ALICE.account}`, aud: TEST_RESOURCE, scopes: "notes:read notes:write", email: ALICE.email });
  bobToken = await bearerTokenFor({ sub: `user:${BOB.account}`, aud: TEST_RESOURCE, scopes: "notes:read notes:write", email: BOB.email });
});
afterAll(async () => { await mf?.dispose(); });

describe("種類が保存先を決める", () => {
  it("project はその scope の空間へ共有される", async () => {
    const res = await put(aliceToken, { slug: "fav-decision", body_md: "月末に API 廃止", type: "project", scope: REPO_A });
    expect(await res.json()).toMatchObject({ stored: "shared" });
  });

  it("reference も共有される", async () => {
    const res = await put(aliceToken, { slug: "fav-dashboard", body_md: "ダッシュボードは https://x", type: "reference", scope: REPO_A });
    expect(await res.json()).toMatchObject({ stored: "shared" });
  });

  it("user と feedback は同じ scope でも個人に留まる", async () => {
    for (const t of ["user", "feedback"]) {
      const res = await put(aliceToken, { slug: `alice-${t}`, body_md: `alice-private-${t}`, type: t, scope: REPO_A });
      expect(await res.json()).toMatchObject({ stored: "personal" });
    }
  });

  it("種類を省略すると個人。安全側が既定", async () => {
    const res = await put(aliceToken, { slug: "alice-untyped", body_md: "alice-private-untyped", scope: REPO_A });
    expect(await res.json()).toMatchObject({ stored: "personal" });
  });

  it("scope に関係なく、種類だけで決まる", async () => {
    // 器を作る操作が無くなったので「共有先が無いから個人に落ちる」という状態も無い。
    // 新しいプロジェクトに触っても事前準備が要らないのは、この単純さの帰結。
    const g = await put(aliceToken, { slug: "fav-global", body_md: "global でも共有", type: "project" });
    expect(await g.json()).toMatchObject({ stored: "shared" });
    const o = await put(aliceToken, { slug: "auth-note", body_md: "未登録リポジトリでも共有", type: "project", scope: OTHER_REPO });
    expect(await o.json()).toMatchObject({ stored: "shared" });
  });

  it("shared を明示すると種類の既定を上書きできる", async () => {
    const a = await put(aliceToken, { slug: "alice-secret-project", body_md: "alice-private-override", type: "project", shared: false });
    expect(await a.json()).toMatchObject({ stored: "personal" });
    const b = await put(aliceToken, { slug: "shared-pref", body_md: "共有したい好み", type: "user", shared: true });
    expect(await b.json()).toMatchObject({ stored: "shared" });
  });
});

describe("共有されたものは相手にも見える", () => {
  it("bob は alice が共有した決定を読める", async () => {
    const body = await text(await req("/api/v1/notes", bobToken));
    expect(body).toContain("fav-decision");
    expect(body).toContain("fav-dashboard");
  });

  it("別のリポジトリで作業していても共有ノートは出る", async () => {
    // ShopApp の本題。REPO_A で書いた決定が REPO_B で作業中にも出ること。
    const body = await text(await req(`/api/v1/notes?context=${encodeURIComponent(REPO_B)}`, bobToken));
    expect(body).toContain("fav-decision");
  });

  it("bob も同じ空間に書ける。共有は読み専用ではない", async () => {
    const res = await put(bobToken, { slug: "bob-decision", body_md: "bob の決定", type: "project", scope: REPO_B });
    expect(await res.json()).toMatchObject({ stored: "shared" });
    expect(await text(await req("/api/v1/notes", aliceToken))).toContain("bob-decision");
  });
});

describe("個人の記憶は漏れない ← 本命", () => {
  it("bob は alice の個人ノートを1件も見られない", async () => {
    // 2026-08-21 修正: ここは本文の文字列("alice-private-user" など)を探していたが、
    // この一覧は id/slug/title しか返さない —— 本文は最初から含まれないので、
    // 分離が壊れていても永久に合格する検査だった。「本命」と名付けたテストが
    // 何も試していなかった。slug で判定し、対照を並べる。
    const res = await req("/api/v1/notes", bobToken);
    const notes = ((await res.json()) as { notes?: Array<{ slug: string }> }).notes ?? [];
    const slugs = notes.map((n) => n.slug);
    for (const hidden of ["alice-user", "alice-feedback", "alice-untyped", "alice-secret-project"]) {
      expect(slugs).not.toContain(hidden);
    }
    // 対照: 共有ノートは同じ一覧に出ること。出ないなら一覧ごと死んでいて、
    // 上の「含まれない」は何も証明していない。
    expect(slugs).toContain("fav-decision");
  });

  it("検索でも漏れない", async () => {
    for (const mode of ["keyword", "hybrid"]) {
      const res = await req(`/api/v1/search?q=alice-private&mode=${mode}`, bobToken);
      // 応答は問い合わせ文字列をそのまま含むので、本文全体を見ると
      // エコーに反応して「漏れた」と誤判定する。結果だけを見ること。
      const hits = ((await res.json()) as { hits?: unknown[] }).hits ?? [];
      expect(JSON.stringify(hits)).not.toContain("alice-private");
      expect(hits.length).toBe(0);
    }
  });

  it("同じ検索で共有ノートは出る(検索が生きていることの対照)", async () => {
    // この対照が無いと、上の「0件」がキー名の綴り違いでも通ってしまう。
    // 実際、最初に results と書いていて、漏洩テストは常に空配列を見ていた。
    const res = await req("/api/v1/search?q=fav-decision&mode=keyword", bobToken);
    const hits = ((await res.json()) as { hits?: unknown[] }).hits ?? [];
    expect(hits.length).toBeGreaterThan(0);
  });

  it("id を直接指定しても読めない", async () => {
    const row = await db.prepare("SELECT id FROM notes WHERE slug='alice-untyped'").first<{ id: string }>();
    expect((await req(`/api/v1/notes/${row?.id}`, bobToken)).status).toBe(404);
  });

  it("共有ノートは id 指定で読める(共有が機能していることの対照)", async () => {
    // この対照が無いと、上の 404 が「共有も含めて全部見えない」だけかもしれない。
    const row = await db.prepare("SELECT id FROM notes WHERE slug='fav-decision'").first<{ id: string }>();
    expect((await req(`/api/v1/notes/${row?.id}`, bobToken)).status).toBe(200);
  });
});

describe("監査が見つけた穴（2026-08-21）", () => {
  it("不正な type は入口で断る（12回リトライしない）", async () => {
    // 検証がどこにも無く、唯一の検査が CHECK 制約だった。upsert は制約違反を
    // 同時書き込みの衝突と区別できず12回再試行し、そのたびに埋め込みを計算し直す。
    const res = await put(aliceToken, { slug: "bad-type", body_md: "x", type: "nonsense" as never });
    expect(res.status).toBe(400);
    const row = await db.prepare("SELECT id FROM notes WHERE slug='bad-type'").first();
    expect(row).toBeNull();
  });

  it("REST が内部向けの値を素通ししない", async () => {
    // body を丸ごと展開していたので、型検査を受けない値が upsert に届いていた。
    // 受け取る値を明示したので、知らない鍵は落ちる。
    const res = await put(aliceToken, { slug: "extra-keys", body_md: "x", user_id: BOB.id, id: "forced-id" } as never);
    expect([200, 201]).toContain(res.status);
    const row = await db.prepare("SELECT id, user_id FROM notes WHERE slug='extra-keys'").first<{ id: string; user_id: string }>();
    expect(row?.id).not.toBe("forced-id");
    expect(row?.user_id).toBe(ALICE.id);
  });

  it("共有ノートへの [[wikilink]] が解決される", async () => {
    // 2026-08-22: resolveWiki が独自の述語を手書きし user_id を二重に束縛していた。
    // 結果は正しい(他人の個人ノートは出ない)が、共有ノートへのリンクが未作成扱いに
    // なり、あるものを「無い」と描いていた。
    await put(aliceToken, { slug: "wiki-target", title: "リンク先", body_md: "本文", type: "project", scope: REPO_A });
    await put(bobToken, { slug: "wiki-source", body_md: "参照: [[wiki-target]]" });

    const html = await (await req(`/@${BOB.handle}/n/wiki-source`, bobToken, { headers: { accept: "text/html" } })).text();
    // 解決済みなら class="wikilink"、未解決なら "wikilink stub" + title="Not yet written"
    // (markdown.ts:102)。文字列 "未作成" はコードのどこにも無く、最初に書いた
    // テストはそれを探していたので何を壊しても通っていた。
    expect(html).toContain("wiki-target");
    expect(html).not.toContain("Not yet written");
  });

  it("他人の個人ノートへの [[wikilink]] は解決されない", async () => {
    // 対照。共有だけが解決されるのであって、述語が緩んだわけではない。
    await put(aliceToken, { slug: "wiki-private", body_md: "alice-private-wiki" });
    await put(bobToken, { slug: "wiki-source2", body_md: "参照: [[wiki-private]]" });
    const html = await (await req(`/@${BOB.handle}/n/wiki-source2`, bobToken, { headers: { accept: "text/html" } })).text();
    // 他人の個人ノートは解決されない = stub のまま。
    expect(html).toContain("Not yet written");
    expect(html).not.toContain("alice-private-wiki");
  });

  it("他人の同義語が自分の検索を勝手に広げない", async () => {
    // synonyms は user_id を記録しているのに、読み取りが述語なしで全員分を読んでいた。
    // 結果が静かに変わるだけなので、気づく手段が無い。
    await db.prepare("INSERT INTO synonyms (user_id, term, synonym) VALUES (?,?,?)").bind(BOB.id, "zzsyn", "alice-secret").run();
    await put(aliceToken, { slug: "syn-target", body_md: "alice-secret 本文" });

    // bob の同義語なので、alice の検索では展開されない。
    const res = await req("/api/v1/search?q=zzsyn&mode=keyword", aliceToken);
    const hits = ((await res.json()) as { hits?: Array<{ slug: string }> }).hits ?? [];
    expect(hits.map((h) => h.slug)).not.toContain("syn-target");

    // 対照: alice 自身の同義語なら効くこと。効かないなら同義語機能ごと死んでいて、
    // 上の「出ない」は何も証明していない。
    await db.prepare("INSERT INTO synonyms (user_id, term, synonym) VALUES (?,?,?)").bind(ALICE.id, "zzmine", "alice-secret").run();
    const own = await req("/api/v1/search?q=zzmine&mode=keyword", aliceToken);
    const ownHits = ((await own.json()) as { hits?: Array<{ slug: string }> }).hits ?? [];
    expect(ownHits.map((h) => h.slug)).toContain("syn-target");
  });

  it("searches a bounded set of aliases from a larger saved dictionary", async () => {
    const aliases = Array.from({ length: 12 }, (_, index) => `syn-fixture-${String(index).padStart(2, "0")}`);
    await db.batch(aliases.map(alias => db.prepare("INSERT INTO synonyms (id,user_id,term,synonym) VALUES (?,?,?,?)")
      .bind(crypto.randomUUID(), ALICE.id, "boundedlookup", alias)));
    await put(aliceToken, { slug: "syn-recent-alias", body_md: aliases[0] });
    await put(aliceToken, { slug: "syn-excess-alias", body_md: aliases.at(-1) });
    const response = await req("/api/v1/search?q=boundedlookup&mode=keyword", aliceToken);
    const { hits } = await response.json() as { hits: Array<{ slug: string }> };
    const selected = hits.map(hit => hit.slug);
    expect(selected).toContain("syn-recent-alias");
    expect(selected).not.toContain("syn-excess-alias");
  });

  it("共有ノートへの追記が、影の個人コピーを作らない", async () => {
    // 読みは「自分の行 → 共有行」で解決するのに、書きは自分の名前空間に固定
    // されていた。共有ノートに書くと同じ slug の別の行ができ、以後その人には
    // 自分のコピーだけが見える —— 共有ノートが永久に影に隠れる。
    await put(aliceToken, { slug: "joint-note", body_md: "alice の初稿", type: "project", scope: REPO_A });
    const before = await db.prepare("SELECT id, user_id FROM notes WHERE slug='joint-note'").first<{ id: string; user_id: string }>();

    // 2026-11-14: 種類も shared も無い全文書き込みは個人扱いになった(本人の行を作る)。
    // 他人の共有ノートを直すのは、共有の意図を明示した書き込み(共有の種類 / shared:true)か追記。
    await put(bobToken, { slug: "joint-note", body_md: "bob が直した", shared: true });

    // 行が増えていないこと。増えていたら影ができている。
    const rows = await db.prepare("SELECT COUNT(*) AS n FROM notes WHERE slug='joint-note' AND deleted_at IS NULL").first<{ n: number }>();
    expect(rows?.n).toBe(1);
    // 同じ行が編集され、著者は alice のまま。
    const after = await db.prepare("SELECT id, user_id, body_md, shared FROM notes WHERE slug='joint-note'").first<{ id: string; user_id: string; body_md: string; shared: number }>();
    expect(after?.id).toBe(before?.id);
    expect(after?.user_id).toBe(before?.user_id);
    expect(after?.body_md).toContain("bob が直した");
    expect(after?.shared).toBe(1); // 編集で共有が外れないこと

    // 両方から同じものが見えること。
    for (const t of [aliceToken, bobToken]) {
      expect(await text(await req("/api/v1/notes", t))).toContain("joint-note");
    }
  });

  it("他人の共有ノートを編集しても、自分のタグは増えない", async () => {
    // 付随データを編集者に紐づけると、他人のノートを直しただけでタグが生える。
    await put(aliceToken, { slug: "tagged-shared", body_md: "本文", type: "project", scope: REPO_A, tags: ["alpha"] });
    const bobTagsBefore = await db.prepare("SELECT COUNT(*) AS n FROM tags WHERE user_id=?").bind(BOB.id).first<{ n: number }>();

    // 2026-11-14: 種類も shared も無い全文書き込みは個人扱いになった(本人の行を作る)。
    // 他人の共有ノートを直すのは、共有の意図を明示した書き込み(共有の種類 / shared:true)か追記。
    await put(bobToken, { slug: "tagged-shared", body_md: "bob が直した", tags: ["beta"], shared: true });

    const bobTagsAfter = await db.prepare("SELECT COUNT(*) AS n FROM tags WHERE user_id=?").bind(BOB.id).first<{ n: number }>();
    expect(bobTagsAfter?.n).toBe(bobTagsBefore?.n);
    // タグは著者側に付くこと。
    const aliceHasBeta = await db.prepare("SELECT COUNT(*) AS n FROM tags WHERE user_id=? AND slug='beta'").bind(ALICE.id).first<{ n: number }>();
    expect(aliceHasBeta?.n).toBe(1);
  });

  it("個人ノートの slug は他人から書き換えられない", async () => {
    // 対照。共有だけが共同編集になるのであって、名前空間が消えたわけではない。
    await put(aliceToken, { slug: "alice-only", body_md: "alice-private-only" });
    await put(bobToken, { slug: "alice-only", body_md: "bob-separate" });

    const alice = await db.prepare("SELECT body_md FROM notes WHERE slug='alice-only' AND user_id=?").bind(ALICE.id).first<{ body_md: string }>();
    expect(alice?.body_md).toBe("alice-private-only"); // 触られていない
    const bob = await db.prepare("SELECT body_md FROM notes WHERE slug='alice-only' AND user_id=?").bind(BOB.id).first<{ body_md: string }>();
    expect(bob?.body_md).toBe("bob-separate"); // bob には自分の行ができる
  });

  it("削除した共有ノートの slug に書き直しても、勝手に共有されない", async () => {
    // getRowBySlug は deleted_at を見ないので、蘇生した行が前の shared を引き継いでいた。
    // 共有ノートを消したあと同じ slug に別の内容を書くと、黙って公開される形。
    await put(aliceToken, { slug: "recycled", body_md: "最初は共有", type: "project", scope: REPO_A });
    // 削除は id 指定。slug を渡していたので削除が起きておらず、テストが何も
    // 試していなかった(最初に書いたときの取り違え)。
    const row = await db.prepare("SELECT id FROM notes WHERE slug='recycled'").first<{ id: string }>();
    const del = await req(`/api/v1/notes/${row?.id}`, aliceToken, { method: "DELETE" });
    expect(del.status).toBe(200);
    const gone = await db.prepare("SELECT deleted_at FROM notes WHERE slug='recycled'").first<{ deleted_at: number | null }>();
    expect(gone?.deleted_at).not.toBeNull(); // 前提の確認

    const again = await put(aliceToken, { slug: "recycled", body_md: "alice-private-recycled 別の内容" });
    expect(await again.json()).toMatchObject({ stored: "personal" });
    expect(await text(await req("/api/v1/notes", bobToken))).not.toContain("recycled");
  });

  it("他人の共有ノートは supersede できない（書き込み側で止まる）", async () => {
    // 監査は「supersede する側に可視性の条件が無い」と指摘したが、実際には
    // 書き込み側が `target.user_id === userId` で止めていた(notes.ts:306)。
    // 読み取り側の条件は二枚目の鍵として足したが、一枚目はここ。
    await put(aliceToken, { slug: "team-decision", body_md: "チームの決定", type: "project", scope: REPO_A });
    const target = await db.prepare("SELECT id FROM notes WHERE slug='team-decision'").first<{ id: string }>();

    await put(bobToken, { slug: "bob-private-supersede", body_md: "bob の私見", supersedes: target?.id });

    // supersedes が記録されていないこと(記録されたら一枚目が破れている)。
    const bobRow = await db.prepare("SELECT supersedes FROM notes WHERE slug='bob-private-supersede'").first<{ supersedes: string | null }>();
    expect(bobRow?.supersedes).toBeNull();
    // alice の recall にも残っていること。
    const res = await req("/api/v1/recall", aliceToken, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "チームの決定", budget: 800 }),
    });
    expect(await text(res)).toContain("team-decision");
  });

  it("直接 DB に書かれた他人の supersede でも、共有ノートは取り下げられない", async () => {
    // 二枚目の鍵。書き込み側を迂回して supersedes が入っても(移行や不具合、
    // あるいは将来の別経路)、読み取り側が「見えない supersede は効かない」を守る。
    const target = await db.prepare("SELECT id FROM notes WHERE slug='team-decision'").first<{ id: string }>();
    await db
      .prepare("INSERT INTO notes (id,user_id,slug,title,body_md,frontmatter_json,kind,content_hash,created_at,updated_at,supersedes) VALUES (?,?,?,?,?,'{}','note','h',1,1,?)")
      .bind("n_sneaky", BOB.id, "sneaky-supersede", "bob の私見", "bob-private", target?.id)
      .run();
    const res = await req("/api/v1/recall", aliceToken, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "チームの決定", budget: 800 }),
    });
    expect(await text(res)).toContain("team-decision");
  });

  it("ブロックの中のリンクがバックリンク一覧に出ない", async () => {
    await put(aliceToken, { slug: "link-target", body_md: "リンク先", type: "project", scope: REPO_A });
    // ブロックは memory_set が作る。`block-` で始まる slug というだけでは
    // kind='block' にならない —— 最初に書いたテストはそこを取り違えていた。
    await req("/mcp", aliceToken, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "memory_set", arguments: { label: "linky", value: "参照: [[link-target]]" } },
      }),
    });
    const blk = await db.prepare("SELECT kind FROM notes WHERE slug='block-linky'").first<{ kind: string }>();
    expect(blk?.kind).toBe("block"); // 前提の確認。これが note なら以下は何も試していない
    const tgt = await db.prepare("SELECT id FROM notes WHERE slug='link-target'").first<{ id: string }>();

    // 自分から見てもブロックは出ない(作業記憶であって公開物ではない)。
    expect(await text(await req(`/api/v1/notes/${tgt?.id}/backlinks`, aliceToken))).not.toContain("block-linky");
    expect(await text(await req(`/api/v1/notes/${tgt?.id}/backlinks`, bobToken))).not.toContain("block-linky");
  });
});

describe("core-memory ブロックは共有されない", () => {
  // 2026-08-21、監査が end-to-end に再現した漏洩。notes.ts のコメントは60行上で
  // 「ブロック印がある行は private を強制する」と書いていたが、実装されていたのは
  // kind の側だけだった。一覧と検索は kind != 'block' で除くので誰も気づかず、
  // id / slug の直指定だけが本文を返していた。
  const mcp = async (token: string, name: string, args: Record<string, unknown>) => {
    const res = await req("/mcp", token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const body = (await res.json()) as { result?: { content?: Array<{ text?: string }> } };
    return JSON.parse(body.result?.content?.[0]?.text ?? "{}") as Record<string, unknown>;
  };

  it("notes_put で type:'project' を当てても共有にならない", async () => {
    await mcp(aliceToken, "memory_set", { label: "persona", value: "ALICE-SECRET-PERSONA" });
    // notes_append のツール説明が `block-<label>` を扱えると案内しているので、
    // この slug は agent が普通に触りうる。
    const put = await mcp(aliceToken, "notes_put", {
      slug: "block-persona",
      body_md: "ALICE-SECRET-PERSONA",
      type: "project",
    });
    expect(put).toMatchObject({ stored: "personal" });

    const row = await db.prepare("SELECT kind, shared FROM notes WHERE slug='block-persona'").first<{ kind: string; shared: number }>();
    expect(row).toMatchObject({ kind: "block", shared: 0 });
  });

  it("shared:true を明示しても共有にならない", async () => {
    // 種類による既定だけでなく、明示指定も効いてはいけない。
    const put = await mcp(aliceToken, "notes_put", { slug: "block-persona", body_md: "ALICE-SECRET-PERSONA", shared: true });
    expect(put).toMatchObject({ stored: "personal" });
  });

  it("bob は id でも slug でもブロックを開けない", async () => {
    const row = await db.prepare("SELECT id FROM notes WHERE slug='block-persona'").first<{ id: string }>();
    expect(await mcp(bobToken, "notes_get", { slug: "block-persona" })).toMatchObject({ found: false });
    expect(await mcp(bobToken, "notes_get", { id: row?.id })).toMatchObject({ found: false });
    expect(JSON.stringify(await mcp(bobToken, "notes_get", { id: row?.id }))).not.toContain("ALICE-SECRET");
    // REST 側も同じ。
    const rest = await req(`/api/v1/notes/${row?.id}`, bobToken);
    expect(rest.status).toBe(404);
    // alice 自身は自分の作業記憶を読める(経路が生きている証明)。
    expect(JSON.stringify(await mcp(aliceToken, "memory_get", { label: "persona" }))).toContain("ALICE-SECRET");
  });
});

describe("共有ノートは検索結果の slug でそのまま開ける", () => {
  // 2026-08-20、本番実測で見つかった穴。共有ノートは検索には出るのに、その検索が
  // 返す slug で notes_get できなかった —— slug 解決が呼び出し者の user_id で
  // 束縛されていたため。「見えるのに触れない」は利用者から理由が分からない。
  /** slug 解決は MCP の notes_get だけが通る経路。 */
  const getBySlug = async (token: string, slug: string) => {
    const res = await req("/mcp", token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "notes_get", arguments: { slug } } }),
    });
    const body = (await res.json()) as { result?: { content?: Array<{ text?: string }> } };
    return JSON.parse(body.result?.content?.[0]?.text ?? "{}") as { slug?: string; found?: boolean };
  };

  it("bob は alice が共有したノートを slug で開ける", async () => {
    expect(await getBySlug(bobToken, "fav-decision")).toMatchObject({ slug: "fav-decision" });
  });

  it("同じ slug の他人の個人ノートが先にあっても、共有ノートに辿り着く", async () => {
    // SQL 側の shared=1 が効いていることの検証。これを外すと、同名の古い個人行を
    // 拾ってしまい isReadable が弾く → 読めるはずの共有ノートが開けなくなる。
    // 「他人の個人ノートが見える」形ではなく「共有ノートが見えなくなる」形で壊れる。
    await db
      .prepare("INSERT INTO notes (id,user_id,slug,title,body_md,frontmatter_json,kind,content_hash,created_at,updated_at,shared) VALUES (?,?,?,?,?,'{}','note','h',1,1,0)")
      .bind("n_bob_priv", BOB.id, "clash-slug", "bob の個人", "bob-private-clash")
      .run();
    await put(aliceToken, { slug: "clash-slug", body_md: "alice の共有", type: "project" });

    // bob 自身は自分の個人行が優先される(直接指定はまず自分の名前空間)。
    expect(await getBySlug(bobToken, "clash-slug")).toMatchObject({ slug: "clash-slug" });
    // alice からは自分の共有行。
    expect(await getBySlug(aliceToken, "clash-slug")).toMatchObject({ slug: "clash-slug" });
    // 第三者(招待済み)からは共有行に辿り着けること。
    const carol = await bearerTokenFor({ sub: "user:01KCAROLCLASH00000000000000", aud: TEST_RESOURCE, scopes: "notes:read notes:write", email: "carol-clash@example.com" });
    await db
      .prepare("INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at,auth_user_id) VALUES (?,?,?,?,'',0,0,?)")
      .bind("u_carol_clash", "carol-clash", "carol", "carol-clash@example.com", "01KCAROLCLASH00000000000000")
      .run();
    const seen = await getBySlug(carol, "clash-slug");
    expect(seen).toMatchObject({ slug: "clash-slug" });
    expect(JSON.stringify(seen)).not.toContain("bob-private-clash");
  });

  it("個人ノートは slug でも開けない", async () => {
    // 対照。共有だけが開くのであって、slug 解決が緩んだわけではない。
    expect(await getBySlug(bobToken, "alice-untyped")).toMatchObject({ found: false });
    // alice 自身は開ける(経路が生きている証明)。
    expect(await getBySlug(aliceToken, "alice-untyped")).toMatchObject({ slug: "alice-untyped" });
  });

  // 2026-08-22、実測で再現。上の「同じ slug の他人の個人ノート」の**墓標**版。
  // getRowBySlug は deleted_at を見ないので、その slug で一度書いて消していると
  // 墓標が先に当たり、共有行を探しに行かずに打ち切っていた。isReadable が墓標を
  // 弾くので、結果は「検索には出るのに開けない」—— 直したはずの壊れ方が、
  // 「消したことがある人」にだけ残っていた。
  it("自分がその slug の墓標を持っていても、共有ノートに辿り着く", async () => {
    const OWN = "tombstone-slug";
    const mine = (await (await put(bobToken, { slug: OWN, body_md: "bob-private-tombstone", type: "user" })).json()) as { id: string };
    expect((await req(`/api/v1/notes/${mine.id}`, bobToken, { method: "DELETE" })).status).toBeLessThan(300);
    await put(aliceToken, { slug: OWN, body_md: "alice の共有(墓標の後)", type: "project" });

    // 読み: 墓標で打ち切らず共有行に着く。
    expect(await getBySlug(bobToken, OWN)).toMatchObject({ slug: OWN });

    // 書き: 読みと同じ行に着く。墓標を蘇生させると同じ slug に生きた行が2つ並び、
    // 以後 bob の読みは自分の私物に着いて共有ノートが永久に隠れる。
    // 2026-11-14: 種類も shared も無い全文書き込みは個人扱いになった(本人の行を作る)。
    // 他人の共有ノートを直すのは、共有の意図を明示した書き込み(共有の種類 / shared:true)か追記。
    await put(bobToken, { slug: OWN, body_md: "bob の追記", shared: true });
    const live = await db
      .prepare("SELECT user_id FROM notes WHERE slug=? AND deleted_at IS NULL")
      .bind(OWN)
      .all<{ user_id: string }>();
    expect(live.results).toHaveLength(1);
    expect(live.results?.[0]?.user_id).toBe(ALICE.id);
  });

  // 2026-08-22: ノートページの [[link]] は共有ノートを解決するのに、/network の
  // グラフは user_id で束縛されていたので、その行を「まだ書かれていない」stub として
  // 描いていた。踏めるリンクを地図が否定する形。#150 が直した手書き述語の4つ目。
  it("ネットワーク図に共有ノートが実ノードとして出る(stub ではなく)", async () => {
    // bob が自分のノートから alice の共有ノート fav-decision を指す。
    await put(bobToken, { slug: "bob-graph-src", body_md: "背景は [[fav-decision]] にある", type: "user" });
    const g = (await (await req("/api/v1/@bob/graph", bobToken)).json()) as {
      nodes: Array<{ id: string; stub: boolean }>;
      edges: Array<{ source: string; target: string }>;
    };
    const target = g.nodes.find((n) => n.id === "fav-decision");
    expect(target, "共有ノートがノードとして存在する").toBeDefined();
    expect(target?.stub, "stub(未作成)ではない").toBe(false);
    expect(g.edges).toContainEqual({ source: "bob-graph-src", target: "fav-decision" });
  });

  // 2026-08-22: リンクの解決を書き込み時に直した回であり、上のグラフ修正の本体。
  // rebuildOutgoingLinks が自分の名前空間に閉じていたので、共有ノートへの
  // [[wikilink]] は resolved=0 / target_note_id=NULL で保存されていた。
  // backlinks は target_note_id で引くため、共有ノートを指すリンクは1本も出なかった。
  it("共有ノート同士がリンクで繋がる(backlinks に出る)", async () => {
    await put(bobToken, { slug: "bob-links-in", body_md: "詳細は [[fav-decision]]", type: "project" });
    const target = await db.prepare("SELECT id FROM notes WHERE slug='fav-decision'").first<{ id: string }>();
    const back = (await (await req(`/api/v1/notes/${target?.id}/backlinks`, aliceToken)).json()) as {
      backlinks?: Array<{ slug: string }>;
    };
    expect((back.backlinks ?? []).map((b) => b.slug)).toContain("bob-links-in");
  });

  it("個人ノートからのリンクは相手の backlinks に出ない", async () => {
    // 対照であり、漏洩の検査でもある。target_note_id が他人の行を指せるように
    // なった以上、リンク元の可視性を見落とすと「誰が何を参照しているか」が漏れる。
    // backlinks はリンク元(src)を readableSql で絞っているので、ここは 0 のはず。
    await put(bobToken, { slug: "bob-private-link", body_md: "個人メモから [[fav-decision]]", type: "user" });
    const target = await db.prepare("SELECT id FROM notes WHERE slug='fav-decision'").first<{ id: string }>();
    const back = (await (await req(`/api/v1/notes/${target?.id}/backlinks`, aliceToken)).json()) as {
      backlinks?: Array<{ slug: string }>;
    };
    expect((back.backlinks ?? []).map((b) => b.slug)).not.toContain("bob-private-link");
    // ただし bob 自身からは見える(経路が生きていることの対照)。
    const own = (await (await req(`/api/v1/notes/${target?.id}/backlinks`, bobToken)).json()) as {
      backlinks?: Array<{ slug: string }>;
    };
    expect((own.backlinks ?? []).map((b) => b.slug)).toContain("bob-private-link");
  });

  it("共有ノートを書くと、待っていた他人の stub が解決する", async () => {
    // 庭の成長の仕組み。相手が書いてくれたのに自分の側が「まだ書かれていない」と
    // 言い続けるなら、[[ ]] と書いて待つ意味が無い。
    await put(bobToken, { slug: "bob-waiting", body_md: "後で [[alice-will-write]] に書く", type: "user" });
    const before = await db
      .prepare("SELECT resolved FROM links WHERE target_slug='alice-will-write'")
      .first<{ resolved: number }>();
    expect(before?.resolved).toBe(0);

    await put(aliceToken, { slug: "alice-will-write", body_md: "書いた", type: "project" });
    const after = await db
      .prepare("SELECT resolved, target_note_id FROM links WHERE target_slug='alice-will-write'")
      .first<{ resolved: number; target_note_id: string | null }>();
    expect(after?.resolved).toBe(1);
    expect(after?.target_note_id).toBeTruthy();
  });

  it("個人ノートは他人の stub を解決しない(共有だけが繋ぐことの対照)", async () => {
    await put(bobToken, { slug: "bob-waiting-2", body_md: "[[alice-keeps-private]] を待つ", type: "user" });
    await put(aliceToken, { slug: "alice-keeps-private", body_md: "個人のまま", type: "user" });
    const row = await db
      .prepare("SELECT resolved FROM links WHERE target_slug='alice-keeps-private'")
      .first<{ resolved: number }>();
    expect(row?.resolved, "個人ノートは他人の stub を解決してはいけない").toBe(0);
  });

  it("他人の /network は今までどおり空(ページの所有者ゲートは残す)", async () => {
    // 対照。読める範囲が広がっても、他人のページで庭を覗けるようにはしない。
    const g = (await (await req("/api/v1/@alice/graph", bobToken)).json()) as { nodes: unknown[] };
    expect(g.nodes).toHaveLength(0);
  });

  it("共有行が無ければ墓標は今までどおり蘇生する", async () => {
    // 対照。上の修正が soft-delete からの復帰を壊していないこと。
    const ONLY_MINE = "tombstone-revive";
    const mine = (await (await put(bobToken, { slug: ONLY_MINE, body_md: "消す", type: "user" })).json()) as { id: string };
    await req(`/api/v1/notes/${mine.id}`, bobToken, { method: "DELETE" });
    const again = (await (await put(bobToken, { slug: ONLY_MINE, body_md: "書き直す", type: "user" })).json()) as { id: string };
    expect(again.id).toBe(mine.id);
  });
});

describe("編集で保存先が黙って変わらない", () => {
  it("種類を省いた追記は共有先を保つ", async () => {
    const res = await put(aliceToken, { slug: "fav-decision", body_md: "月末に API 廃止(追記)" });
    expect(await res.json()).toMatchObject({ stored: "shared" });
  });

  it("種類を省いた編集は個人のままにする", async () => {
    const res = await put(aliceToken, { slug: "alice-untyped", body_md: "alice-private-untyped 追記" });
    expect(await res.json()).toMatchObject({ stored: "personal" });
  });

  it("明示的に共有を外せる", async () => {
    const res = await put(aliceToken, { slug: "fav-dashboard", body_md: "やっぱり個人にする", shared: false });
    expect(await res.json()).toMatchObject({ stored: "personal" });
    // 一覧は本文を返さないので、本文の文字列ではなく slug で判定する。
    const notes = ((await (await req("/api/v1/notes", bobToken)).json()) as { notes?: Array<{ slug: string }> }).notes ?? [];
    expect(notes.map((n) => n.slug)).not.toContain("fav-dashboard");
  });

  it("checks current visibility when loading tags and outgoing links", async () => {
    const first = await put(aliceToken, {
      slug: "visibility-metadata", body_md: "[[shared-link]]", tags: ["shared tag"], shared: true,
    });
    const { id } = await first.json() as { id: string };
    expect(first.ok && id).toBeTruthy();
    const notes = makeServices(db).notes;
    expect(await notes.tagsFor(id, BOB.id)).toEqual(["shared tag"]);
    expect(await notes.outgoing(id, BOB.id)).toMatchObject([{ target_slug: "shared-link" }]);

    const updated = await put(aliceToken, {
      slug: "visibility-metadata", body_md: "[[private-link]]", tags: ["private tag"], shared: false,
    });
    expect(updated.ok).toBe(true);
    expect(await notes.tagsFor(id, ALICE.id)).toEqual(["private tag"]);
    expect(await notes.outgoing(id, ALICE.id)).toMatchObject([{ target_slug: "private-link" }]);
    expect(await notes.tagsFor(id, BOB.id)).toEqual([]);
    expect(await notes.outgoing(id, BOB.id)).toEqual([]);
  });
});
