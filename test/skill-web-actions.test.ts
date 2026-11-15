// issue #54: wire up the skill detail page's edit/fork/delete buttons to the
// existing skills_put/skills_fork/skills_delete backend operations. Drives the
// REAL Hono app (middleware -> door -> service) on a Miniflare D1 with the
// full migration set, mirroring the pattern in test/curator-web-actions.test.ts.
//
// Covers:
//   1. GET/POST /@:handle/skills/:slug/edit -- owner-only (sessionHandle===
//      handle, gated behind a verified Access-JWT / CF_Authorization cookie,
//      which resolves ONLY to the single owner); an anonymous caller is
//      redirected to /access/login, a non-owner (Bearer) caller is denied with
//      a flat 403 (W2 — a login redirect would dead-end an already-authenticated
//      caller); neither ever mutates the skill.
//   2. POST /@:handle/skills/:slug/fork -- an authenticated (notes:write)
//      viewer who can read the skill forks it into their OWN account; since
//      decision 9 (owner-only) that means self-forks only. Forking another
//      user's skill 404s and creates nothing. Anonymous fork attempts
//      redirect to /login (or 401 for non-browser accepts).
//   3. POST /@:handle/skills/:slug/delete -- owner-only (fetched via
//      principal.userId, mirroring softDelete's own fail-closed re-check); a
//      non-owner's attempt is a silent no-op (no 500), the skill still exists
//      afterward.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { accessEnvVars, bearerKeyFixture, rsEnvVars, setupAccessAuth } from "./helpers";

const OWNER = "u_skill_web_actions_owner";
const OWNER_HANDLE = "skill-web-actions-owner";
const OWNER_EMAIL = "owner-skill-web-actions@example.com";
let OWNER_BEARER = "";
const OTHER = "u_skill_web_actions_other";
const OTHER_HANDLE = "skill-web-actions-other";
let OTHER_BEARER = "";

let mf: Miniflare;
let db: D1Database;
let env: Parameters<typeof app.request>[2];
let jwtFor: (email: string) => Promise<string>;

async function applyMigrations(database: D1Database): Promise<void> {
  const dir = join(process.cwd(), "migrations");
  const files = readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  for (const f of files) {
    const raw = readFileSync(join(dir, f), "utf8")
      .split("\n")
      .map((line) => {
        const i = line.indexOf("--");
        return i >= 0 ? line.slice(0, i) : line;
      })
      .join("\n");
    for (const stmt of raw.split(";")) {
      const s = stmt.trim();
      if (s) await database.prepare(s).run();
    }
  }
}

async function req(path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(`https://memory.test${path}`, init, env);
}

// The owner's Access-JWT cookie door (Task 3), replacing the old password
// login + web-session-cookie flow. Access resolves ONLY to OWNER_HANDLE.
async function ownerCookie(): Promise<string> {
  return `CF_Authorization=${await jwtFor(OWNER_EMAIL)}`;
}

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: ["DB"] }));
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applyMigrations(db);

  await db
    .prepare("INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .bind(OWNER, OWNER_HANDLE, "owner", OWNER_EMAIL, "", 0, 0)
    .run();
  OWNER_BEARER = await bearerKeyFixture(db, OWNER, "notes:read,notes:write");

  await db
    .prepare("INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .bind(OTHER, OTHER_HANDLE, "other", "other-skill-web-actions@example.com", "", 0, 0)
    .run();
  OTHER_BEARER = await bearerKeyFixture(db, OTHER, "notes:read,notes:write");

  jwtFor = await setupAccessAuth();
  env = { DB: db, ...rsEnvVars(), OWNER_HANDLE, ...accessEnvVars(OWNER_EMAIL) } as unknown as Parameters<typeof app.request>[2];
});

afterAll(async () => {
  await mf?.dispose();
});

async function createSkill(bearer: string, slug: string, opts: { name?: string; description?: string; instructions?: string } = {}) {
  const res = await req("/api/v1/skills", {
    method: "POST",
    headers: { get authorization() { return `Bearer ${bearer}`; }, "content-type": "application/json" },
    body: JSON.stringify({
      slug,
      name: opts.name ?? slug,
      description: opts.description ?? "元の説明",
      instructions: opts.instructions ?? "元の手順",
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; slug: string };
}

describe("skill detail page renders the edit/fork/delete buttons (issue #54)", () => {
  it("shows ✎ 編集する and 🗑 削除する only to the owner's own Access-JWT caller, and always shows 🔀 フォークする with its explainer caption", async () => {
    await createSkill(OWNER_BEARER, "sw-page-buttons");

    const ownerView = await req("/@skill-web-actions-owner/skills/sw-page-buttons", { headers: { cookie: await ownerCookie() } });
    const ownerHtml = await ownerView.text();
    expect(ownerHtml).toContain("✎ 編集する");
    expect(ownerHtml).toContain("🗑 削除する");
    expect(ownerHtml).toContain("🔀 フォークする");
    expect(ownerHtml).toContain("他の人のスキルを、自分用に編集できる形でコピーします");

    // A Bearer-authenticated (non-browser-session) view of the same page: the
    // owner-session-gated edit/delete buttons stay hidden, fork stays visible.
    const bearerView = await req("/@skill-web-actions-owner/skills/sw-page-buttons", { headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; } } });
    const bearerHtml = await bearerView.text();
    expect(bearerHtml).not.toContain("✎ 編集する");
    expect(bearerHtml).not.toContain("🗑 削除する");
    expect(bearerHtml).toContain("🔀 フォークする");
  });
});

describe("GET/POST /@:handle/skills/:slug/edit (owner-only)", () => {
  it("the owner can GET the prefilled edit form and POST an update; the skill page reflects the change afterward", async () => {
    await createSkill(OWNER_BEARER, "sw-edit-owner", { name: "元の名前", description: "元の説明", instructions: "元の手順" });
    const cookie = await ownerCookie();

    const editForm = await req("/@skill-web-actions-owner/skills/sw-edit-owner/edit", { headers: { cookie } });
    expect(editForm.status).toBe(200);
    const formHtml = await editForm.text();
    expect(formHtml).toContain("元の名前");
    expect(formHtml).toContain("元の説明");
    expect(formHtml).toContain("元の手順");

    const postRes = await req("/@skill-web-actions-owner/skills/sw-edit-owner/edit", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: "name=" + encodeURIComponent("新しい名前") + "&description=" + encodeURIComponent("新しい説明") + "&instructions=" + encodeURIComponent("新しい手順"),
    });
    expect(postRes.status).toBe(302);
    expect(postRes.headers.get("location")).toBe("/@skill-web-actions-owner/skills/sw-edit-owner");

    const after = await req("/@skill-web-actions-owner/skills/sw-edit-owner", { headers: { cookie } });
    const afterHtml = await after.text();
    expect(afterHtml).toContain("新しい名前");
    expect(afterHtml).toContain("新しい説明");
    expect(afterHtml).toContain("新しい手順");
  });

  it("an anonymous caller hitting GET .../edit is redirected to /login", async () => {
    await createSkill(OWNER_BEARER, "sw-edit-anon-get");
    const res = await req("/@skill-web-actions-owner/skills/sw-edit-anon-get/edit", { headers: { accept: "text/html" } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(`/login`);
  });

  it("a non-owner's Bearer key hitting GET .../edit is denied with a flat 403, not shown the owner's form", async () => {
    await createSkill(OWNER_BEARER, "sw-edit-nonowner-get");
    const res = await req("/@skill-web-actions-owner/skills/sw-edit-nonowner-get/edit", { headers: { get authorization() { return `Bearer ${OTHER_BEARER}`; } } });
    expect(res.status).toBe(403);
  });

  it("a non-owner's POST to .../edit is denied with a flat 403 and does not mutate the owner's skill", async () => {
    await createSkill(OWNER_BEARER, "sw-edit-nonowner-post", { name: "変更されないはず" });

    const res = await req("/@skill-web-actions-owner/skills/sw-edit-nonowner-post/edit", {
      method: "POST",
      headers: { get authorization() { return `Bearer ${OTHER_BEARER}`; }, "content-type": "application/x-www-form-urlencoded" },
      body: "name=" + encodeURIComponent("乗っ取り") + "&description=x&instructions=x",
    });
    expect(res.status).toBe(403);

    const check = await req("/@skill-web-actions-owner/skills/sw-edit-nonowner-post", { headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; } } });
    const html = await check.text();
    expect(html).toContain("変更されないはず");
    expect(html).not.toContain("乗っ取り");
  });

  it("an unauthenticated (Bearer-only, no Access-JWT) caller's POST to .../edit does not mutate the skill either (Bearer alone is not enough for this owner-only gate)", async () => {
    await createSkill(OWNER_BEARER, "sw-edit-bearer-only", { name: "ベアラーだけでは変更不可" });
    const res = await req("/@skill-web-actions-owner/skills/sw-edit-bearer-only/edit", {
      method: "POST",
      headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; }, "content-type": "application/x-www-form-urlencoded" },
      body: "name=" + encodeURIComponent("エージェント経由の変更") + "&description=x&instructions=x",
    });
    expect(res.status).toBe(403);

    const check = await req("/@skill-web-actions-owner/skills/sw-edit-bearer-only", { headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; } } });
    expect(await check.text()).toContain("ベアラーだけでは変更不可");
  });
});

describe("POST /@:handle/skills/:slug/fork", () => {
  it("the owner forking their OWN skill creates a new copy under their account and redirects to it", async () => {
    await createSkill(OWNER_BEARER, "sw-fork-own", { name: "自分のスキル" });

    const res = await req("/@skill-web-actions-owner/skills/sw-fork-own/fork", {
      method: "POST",
      headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; } },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/@skill-web-actions-owner/skills/sw-fork-own-fork");

    const forked = await req("/@skill-web-actions-owner/skills/sw-fork-own-fork", { headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; } } });
    expect(forked.status).toBe(200);
    expect(await forked.text()).toContain("自分のスキル");
  });

  it("forking ANOTHER user's skill 404s and creates nothing (owner-only, decision 9 — even a skill that exists)", async () => {
    await createSkill(OWNER_BEARER, "sw-fork-foreign", { name: "他人のスキル" });

    const res = await req("/@skill-web-actions-owner/skills/sw-fork-foreign/fork", {
      method: "POST",
      headers: { get authorization() { return `Bearer ${OTHER_BEARER}`; } },
    });
    expect(res.status).toBe(404);

    const notCreated = await req("/@skill-web-actions-other/skills/sw-fork-foreign-fork", { headers: { get authorization() { return `Bearer ${OTHER_BEARER}`; } } });
    expect(notCreated.status).toBe(404);
  });

  it("an anonymous (unauthenticated) fork attempt redirects to /login and creates nothing", async () => {
    await createSkill(OWNER_BEARER, "sw-fork-anon", { name: "匿名フォーク対象" });

    const res = await req("/@skill-web-actions-owner/skills/sw-fork-anon/fork", { method: "POST", headers: { accept: "text/html" } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(`/login`);

    const notCreated = await req("/@skill-web-actions-owner/skills/sw-fork-anon-fork", { headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; } } });
    expect(notCreated.status).toBe(404);
  });
});

describe("POST /@:handle/skills/:slug/delete", () => {
  it("the owner can delete their own skill; the skill page 404s afterward", async () => {
    await createSkill(OWNER_BEARER, "sw-delete-owner", { name: "削除されるスキル" });
    const cookie = await ownerCookie();

    const before = await req("/@skill-web-actions-owner/skills/sw-delete-owner", { headers: { cookie } });
    expect(before.status).toBe(200);

    const res = await req("/@skill-web-actions-owner/skills/sw-delete-owner/delete", {
      method: "POST",
      headers: { cookie },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/@skill-web-actions-owner");

    const after = await req("/@skill-web-actions-owner/skills/sw-delete-owner", { headers: { cookie } });
    expect(after.status).toBe(404);
  });

  it("a non-owner attempting to delete someone else's skill does not delete it and does not 500", async () => {
    await createSkill(OWNER_BEARER, "sw-delete-nonowner", { name: "残るはずのスキル" });

    const res = await req("/@skill-web-actions-owner/skills/sw-delete-nonowner/delete", {
      method: "POST",
      headers: { get authorization() { return `Bearer ${OTHER_BEARER}`; } },
    });
    expect(res.status).toBe(302);

    const stillThere = await req("/@skill-web-actions-owner/skills/sw-delete-nonowner", { headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; } } });
    expect(stillThere.status).toBe(200);
    expect(await stillThere.text()).toContain("残るはずのスキル");
  });

  it("an anonymous delete attempt redirects to /login and does not delete anything", async () => {
    await createSkill(OWNER_BEARER, "sw-delete-anon", { name: "匿名削除耐性スキル" });

    const res = await req("/@skill-web-actions-owner/skills/sw-delete-anon/delete", { method: "POST", headers: { accept: "text/html" } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(`/login`);

    const stillThere = await req("/@skill-web-actions-owner/skills/sw-delete-anon", { headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; } } });
    expect(stillThere.status).toBe(200);
  });
});
