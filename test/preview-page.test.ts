// issue #56: recall preview screen ("記憶プレビュー") at GET /@:handle/preview.
// Drives the REAL Hono app (middleware -> door -> service) on a Miniflare D1
// with the full migration set, mirroring the pattern in
// test/skill-web-actions.test.ts.
//
// Covers:
//   1. THE CRITICAL SECURITY CASE (the exact bug the issue was written to
//      prevent): recall()/build_prompt() are scoped to the CALLING principal,
//      not to the `:handle` in the URL -- there is no owner-id separation like
//      ranking()/skills.list() have. A different logged-in user (or an
//      anonymous caller) hitting /@<owner>/preview?q=... must NEVER see the
//      owner's actual recalled content -- only a "準備中" placeholder.
//   2. The owner viewing their own /@<own-handle>/preview?q=<query> sees real
//      grouped results (a recognizable JP tier label) plus a token-usage figure.
//   3. An empty ?q= (or no query param) for the owner renders the form only,
//      with no stale/attempted results section.
//   4. Unit tests for the pure view-model mappers (tierLabelFor,
//      toRecallSections), directly against RecallTier[] inputs, with no app/D1
//      harness involved.
//   5. issue #69 robustness: an item whose OWN body contains a line starting
//      with "## " (or "### ") must stay grouped under its real tier and must
//      NOT be re-interpreted as its own tier heading -- the exact corruption
//      the removed line-based `pack.text` re-parser was subject to.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import type { RecallTier } from "../src/recall";
import { tierLabelFor, toRecallSections } from "../src/web/recall-sections";
import { accessEnvVars, bearerKeyFixture, mintTestToken, rsEnvVars, setupAccessAuth } from "./helpers";

const OWNER = "u_preview_page_owner";
const OWNER_HANDLE = "preview-page-owner";
const OWNER_EMAIL = "owner-preview-page@example.com";
let OWNER_BEARER = "";
const OTHER = "u_preview_page_other";
const OTHER_HANDLE = "preview-page-other";

const SECRET_BLOCK_VALUE = "PREVIEW-OWNER-SECRET-MEMORY-CONTENT-42";

let mf: Miniflare;
let db: D1Database;
let env: Parameters<typeof app.request>[2];
let jwtFor: (email: string) => Promise<string>;
let otherBearer: string;

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
  OWNER_BEARER = await mintTestToken(OWNER, "notes:read,notes:write");

  await db
    .prepare("INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .bind(OTHER, OTHER_HANDLE, "other", "other-preview-page@example.com", "", 0, 0)
    .run();

  jwtFor = await setupAccessAuth();
  otherBearer = await bearerKeyFixture(db, OTHER);
  env = { DB: db, ...rsEnvVars(), OWNER_HANDLE, ...accessEnvVars(OWNER_EMAIL) } as unknown as Parameters<typeof app.request>[2];

  // Fixture: a core-memory block for the owner. recall()'s "Working memory
  // (core blocks)" tier lists ALL of the caller's blocks unconditionally (no
  // query-matching required), so this is a deterministic, guaranteed-to-appear
  // tier regardless of query text or search/embedding behavior -- ideal both
  // for asserting the owner sees real grouped content, and for asserting a
  // cross-account viewer does NOT see it.
  const patchRes = await req("/api/v1/memory/blocks/persona", {
    method: "PATCH",
    headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; }, "content-type": "application/json" },
    body: JSON.stringify({ op: "set", value: SECRET_BLOCK_VALUE }),
  });
  expect(patchRes.status).toBe(200);
});

afterAll(async () => {
  await mf?.dispose();
});

describe("GET /@:handle/preview -- cross-account isolation (issue #56's core security requirement)", () => {
  it("a DIFFERENT authenticated (non-owner Bearer) caller viewing the owner's /preview never sees the owner's actual recalled content, only the 準備中 placeholder", async () => {
    const res = await req("/@preview-page-owner/preview?q=anything", { headers: { get authorization() { return `Bearer ${otherBearer}`; } } });
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).not.toContain(SECRET_BLOCK_VALUE);
    expect(html).not.toContain("作業メモリ");
    expect(html).toContain("準備中です。このプレビューはご本人だけが閲覧できます。");
  });

  it("an anonymous caller viewing the owner's /preview is stopped at the fail-closed gate (decision 9) and never sees the owner's recalled content", async () => {
    const res = await req("/@preview-page-owner/preview?q=anything");
    expect(res.status).toBe(401);
    const html = await res.text();
    expect(html).not.toContain(SECRET_BLOCK_VALUE);
    expect(html).not.toContain("作業メモリ");
  });
});

describe("REST POST /api/v1/recall wire contract (issue #69)", () => {
  it("does NOT ship the new /preview-only `sections` field, keeping the token-budgeted REST response byte-compatible with pre-#69", async () => {
    const res = await req("/api/v1/recall", {
      method: "POST",
      headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; }, "content-type": "application/json" },
      body: JSON.stringify({ query: "anything" }),
    });
    expect(res.status).toBe(200);
    const pack = (await res.json()) as Record<string, unknown>;
    // Existing fields still present (unchanged contract)...
    expect(pack).toHaveProperty("included");
    expect(pack).toHaveProperty("text");
    expect(pack).toHaveProperty("used");
    // ...but the structured tier grouping is a same-process /preview affordance,
    // deliberately stripped at the REST boundary so it doesn't ~double the
    // payload by re-emitting every kept item's body already in `included`.
    expect(pack).not.toHaveProperty("sections");
  });
});

describe("GET /@:handle/preview -- the owner's own view", () => {
  it("shows real grouped results (a JP tier label) and a token-usage figure for the owner's own query", async () => {
    const res = await req("/@preview-page-owner/preview?q=anything", { headers: { cookie: await ownerCookie() } });
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain("作業メモリ");
    expect(html).toContain(SECRET_BLOCK_VALUE);
    // Token-usage meter/summary.
    expect(html).toMatch(/\d+\s*\/\s*\d+\s*トークン使用/);
    expect(html).toContain("<progress");
  });

  it("renders only the query form (no stale/attempted results) when ?q= is empty or absent", async () => {
    const cookie = await ownerCookie();

    const noQuery = await req("/@preview-page-owner/preview", { headers: { cookie } });
    expect(noQuery.status).toBe(200);
    const noQueryHtml = await noQuery.text();
    expect(noQueryHtml).toContain("見る");
    expect(noQueryHtml).not.toContain("トークン使用");
    expect(noQueryHtml).not.toContain(SECRET_BLOCK_VALUE);

    const emptyQuery = await req("/@preview-page-owner/preview?q=", { headers: { cookie } });
    expect(emptyQuery.status).toBe(200);
    const emptyQueryHtml = await emptyQuery.text();
    expect(emptyQueryHtml).toContain("見る");
    expect(emptyQueryHtml).not.toContain("トークン使用");
    expect(emptyQueryHtml).not.toContain(SECRET_BLOCK_VALUE);
  });

  it("404s for a handle that doesn't exist at all (ordinary not-found, distinct from the auth gate; needs an authenticated caller since decision 9)", async () => {
    const res = await req("/@no-such-preview-page-user/preview?q=x", { headers: { cookie: await ownerCookie() } });
    expect(res.status).toBe(404);
  });
});

describe("GET /@:handle/preview -- issue #69 robustness (item body containing a '## '/'### ' line)", () => {
  // A core-memory block is the deterministic, guaranteed-to-appear tier
  // (recall() lists ALL of the caller's blocks unconditionally), so its body is
  // the reliable way to smuggle a phantom "## "/"### " heading into a recalled
  // item's own text. The bug is tier-agnostic: the removed line-based
  // pack.text re-parser split on ANY body line starting with "## ", promoting
  // it into a bogus tier heading and dropping the item's real grouping. The
  // structured `pack.sections` path can't: the block stays one item under one
  // tier no matter what its body contains.
  const PHANTOM_HEADING = "## これは本文中の偽見出し";
  const PHANTOM_ITEM = "### 偽アイテム";
  const REAL_BODY_MARKER = "PHANTOM-BLOCK-REAL-CONTENT-99";
  const BLOCK_VALUE = `${REAL_BODY_MARKER}\n${PHANTOM_HEADING}\n${PHANTOM_ITEM}\n偽アイテムの本文`;

  it("keeps a block whose body starts a line with '## ' under its real 作業メモリ tier, without spawning a phantom section heading", async () => {
    // Seed a second core block whose VALUE contains a phantom markdown heading.
    const patchRes = await req("/api/v1/memory/blocks/scratch", {
      method: "PATCH",
      headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; }, "content-type": "application/json" },
      body: JSON.stringify({ op: "set", value: BLOCK_VALUE }),
    });
    expect(patchRes.status).toBe(200);

    const res = await req("/@preview-page-owner/preview?q=anything", { headers: { cookie: await ownerCookie() } });
    expect(res.status).toBe(200);
    const html = await res.text();

    // The block surfaced under the real working-memory tier heading.
    expect(html).toContain("作業メモリ");
    // Its real content AND the phantom-heading line are both present as body
    // text (the "## " prefix is preserved verbatim, not stripped).
    expect(html).toContain(REAL_BODY_MARKER);
    expect(html).toContain(PHANTOM_HEADING);

    // KEY ASSERTION: the phantom "## " body line did NOT become its own tier
    // section heading. Tier labels render as <h3>…</h3>; the old parser would
    // have emitted <h3>これは本文中の偽見出し</h3> here (rawLabel after slicing
    // "## ", falling back through tierLabelFor). The structured path never does.
    expect(html).not.toContain("<h3>これは本文中の偽見出し</h3>");
    // ...nor a phantom item heading from the "### " line.
    expect(html).not.toContain("<h3>偽アイテム</h3>");
  });
});

describe("view-model mappers (unit tests, no app/D1 harness)", () => {
  it("tierLabelFor maps every known raw label to its JP display label", () => {
    expect(tierLabelFor("Working memory (core blocks)")).toBe("作業メモリ");
    expect(tierLabelFor('Relevant notes for "budget season"')).toBe("保存済み知識");
    expect(tierLabelFor("Recent notes")).toBe("保存済み知識");
    expect(tierLabelFor("Relevant skills")).toBe("手順");
    expect(tierLabelFor("Ambient (evergreen)")).toBe("定着した周辺情報");
  });

  it("tierLabelFor falls back to the raw label text for an unrecognized/future tier", () => {
    expect(tierLabelFor("Some Future Tier")).toBe("Some Future Tier");
  });

  it("toRecallSections maps structured tiers to the view-model, translating labels and preserving item order", () => {
    const tiers: RecallTier[] = [
      { tier: "working", label: "Working memory (core blocks)", items: [{ ref: "persona", title: "block:persona", text: "SECRET-VALUE-HERE" }] },
      {
        tier: "archival",
        label: 'Relevant notes for "my query"',
        items: [{ ref: "my-note", title: "My Note Title", text: "first line of note\nsecond line of note" }],
      },
    ];

    const sections = toRecallSections(tiers);
    expect(sections).toHaveLength(2);

    // Working-memory tier -> JP label, item passed through verbatim.
    expect(sections[0].rawLabel).toBe("Working memory (core blocks)");
    expect(sections[0].label).toBe("作業メモリ");
    expect(sections[0].items).toEqual([{ ref: "persona", title: "block:persona", text: "SECRET-VALUE-HERE" }]);

    // The `Relevant notes for "<q>"` variant collapses to the same JP label as
    // "Recent notes"; multi-line body text is preserved unchanged.
    expect(sections[1].rawLabel).toBe('Relevant notes for "my query"');
    expect(sections[1].label).toBe("保存済み知識");
    expect(sections[1].items).toEqual([{ ref: "my-note", title: "My Note Title", text: "first line of note\nsecond line of note" }]);
  });

  it("toRecallSections falls back to the raw label text for an unrecognized/future tier", () => {
    const tiers: RecallTier[] = [{ tier: "future", label: "Some Future Tier", items: [{ ref: "item-ref", title: "item title", text: "item body text" }] }];
    const sections = toRecallSections(tiers);
    expect(sections).toHaveLength(1);
    expect(sections[0].rawLabel).toBe("Some Future Tier");
    expect(sections[0].label).toBe("Some Future Tier");
    expect(sections[0].items).toEqual([{ ref: "item-ref", title: "item title", text: "item body text" }]);
  });

  it("toRecallSections returns no sections for an empty tier list", () => {
    expect(toRecallSections([])).toEqual([]);
  });

  it("toRecallSections keeps an item body that contains a '## ' line intact -- no phantom section split", () => {
    const tiers: RecallTier[] = [
      {
        tier: "working",
        label: "Working memory (core blocks)",
        items: [{ ref: "scratch", title: "block:scratch", text: "本物の本文\n## これは本文中の偽見出し\n### 偽アイテム" }],
      },
    ];
    const sections = toRecallSections(tiers);
    // Exactly one section (the real tier); the body's "## "/"### " lines are
    // carried inside the single item's text, not promoted to their own groups.
    expect(sections).toHaveLength(1);
    expect(sections[0].label).toBe("作業メモリ");
    expect(sections[0].items).toHaveLength(1);
    expect(sections[0].items[0].text).toBe("本物の本文\n## これは本文中の偽見出し\n### 偽アイテム");
  });
});
