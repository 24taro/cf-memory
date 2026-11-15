// The machine door: what src/rs-introspect.ts must refuse.
//
// Written after a mutation pass found that every guard in that module could be
// deleted with all 443 tests green — including the audience check, which is the
// only thing stopping a token minted for tasks.example.com from being accepted
// here. search covers the same module in test/agent-door.test.ts and caught it;
// cf-memory had the helper (bearerTokenFor takes an `aud`) and no test using it.
//
// Drives the real Hono app against a Miniflare D1, with the auth Worker replaced
// by helpers.ts's stub so introspection can be made to answer adversarially.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { TEST_RESOURCE, accessEnvVars, bearerTokenFor, rsEnvVars } from "./helpers";

const OWNER_ACCOUNT = "01KDOOROWNER00000000000000";
const OWNER_EMAIL = "door-owner@example.com";
const OTHER_RESOURCE = "https://tasks.example.com/api/v1";

let mf: Miniflare;
let env: Parameters<typeof app.request>[2];

async function applyMigrations(db: D1Database): Promise<void> {
  const dir = join(process.cwd(), "migrations");
  for (const f of readdirSync(dir).filter((x) => /^\d+_.*\.sql$/.test(x)).sort()) {
    const raw = readFileSync(join(dir, f), "utf8")
      .split("\n")
      .map((line) => {
        const i = line.indexOf("--");
        return i >= 0 ? line.slice(0, i) : line;
      })
      .join("\n");
    for (const stmt of raw.split(";")) {
      const s = stmt.trim();
      if (s) await db.prepare(s).run();
    }
  }
}

async function get(path: string, token?: string): Promise<Response> {
  return app.request(
    `https://memory.test${path}`,
    { headers: token ? { authorization: `Bearer ${token}` } : {} },
    env,
  );
}

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: ["DB"] }));
  const db = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applyMigrations(db);
  await db
    .prepare("INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .bind("u_door_owner", "door-owner", "owner", OWNER_EMAIL, "", 0, 0)
    .run();
  env = {
    DB: db,
    OWNER_HANDLE: "door-owner",
    ...accessEnvVars(OWNER_EMAIL),
    ...rsEnvVars(),
  } as unknown as Parameters<typeof app.request>[2];
});

afterAll(async () => {
  await mf?.dispose();
});

describe("agent door — audience binding", () => {
  it("accepts a token whose audience is this server", async () => {
    const token = await bearerTokenFor({ sub: `user:${OWNER_ACCOUNT}`, aud: TEST_RESOURCE, email: OWNER_EMAIL });
    expect((await get("/api/v1/notes", token)).status).toBe(200);
  });

  it("refuses a token minted for another service in the same ecosystem", async () => {
    // Same authorization server, same subject, same scopes — only the audience
    // differs. Without this a tasks token reads and writes this store.
    const token = await bearerTokenFor({ sub: `user:${OWNER_ACCOUNT}`, aud: OTHER_RESOURCE, email: OWNER_EMAIL });
    expect((await get("/api/v1/notes", token)).status).toBe(401);
  });

  it("accepts a token that lists this server among several audiences", async () => {
    // The live machine token carries cf-memory and tasks together.
    const token = await bearerTokenFor({ sub: `user:${OWNER_ACCOUNT}`, aud: [OTHER_RESOURCE, TEST_RESOURCE], email: OWNER_EMAIL });
    expect((await get("/api/v1/notes", token)).status).toBe(200);
  });

  it("refuses a token with no audience at all", async () => {
    const token = await bearerTokenFor({ sub: `user:${OWNER_ACCOUNT}`, aud: [], email: OWNER_EMAIL });
    expect((await get("/api/v1/notes", token)).status).toBe(401);
  });
});

describe("agent door — which account a subject resolves to", () => {
  it("resolves an account subject to that person's row", async () => {
    // 2026-08-17: the subject is `user:<ULID>` and the address rides along as a
    // claim. The row here is linked by that id on first presentation.
    const token = await bearerTokenFor({
      sub: "user:01KDOOROWNER00000000000000",
      aud: TEST_RESOURCE,
      email: OWNER_EMAIL,
    });
    const res = await get("/api/v1/notes", token);
    expect(res.status).toBe(200);
  });

  it("refuses the retired human:<email> subject", async () => {
    // Resolving people by address is what the account id replaced: a rename made
    // someone a different person. The old form must not still work.
    const token = await bearerTokenFor({ sub: `human:${OWNER_EMAIL}`, aud: TEST_RESOURCE });
    expect((await get("/api/v1/notes", token)).status).toBe(401);
  });

  it("resolves a machine subject to the owner, since machines have no row", async () => {
    const token = await bearerTokenFor({ sub: "machine:build-agent", aud: TEST_RESOURCE });
    expect((await get("/api/v1/notes", token)).status).toBe(200);
  });
});

describe("agent door — what introspection says", () => {
  it("refuses a token the authorization server does not know", async () => {
    expect((await get("/api/v1/notes", "at_test_never_issued")).status).toBe(401);
  });

  it("refuses an inactive token even when the response still names a subject", async () => {
    // A revoked machine token, or an expired grant. The real server drops `sub`
    // along with active, so `active` is the guard that has to hold on its own.
    const token = await bearerTokenFor({
      sub: `user:${OWNER_ACCOUNT}`,
      email: OWNER_EMAIL,
      respondWith: { status: 200, body: { active: false, sub: `user:${OWNER_ACCOUNT}`, aud: [TEST_RESOURCE] } },
    });
    expect((await get("/api/v1/notes", token)).status).toBe(401);
  });

  it("refuses when introspection fails rather than treating the failure as a pass", async () => {
    // auth is on this server's request path (the accepted SPOF). Down must mean
    // "not authorised", never "let it through".
    for (const status of [401, 500, 503]) {
      const token = await bearerTokenFor({
        sub: `user:${OWNER_ACCOUNT}`,
      email: OWNER_EMAIL,
        respondWith: { status, body: { active: true, sub: `user:${OWNER_ACCOUNT}`, aud: [TEST_RESOURCE] } },
      });
      expect((await get("/api/v1/notes", token)).status).toBe(401);
    }
  });

  it("refuses every token when INTROSPECTION_SECRET was never deployed", async () => {
    // A missing secret must close the machine door, not open it. This pins the
    // behaviour rather than the early return: without that return the call goes
    // out with a wrong secret and auth answers 401, which lands in the same place.
    const token = await bearerTokenFor({ sub: `user:${OWNER_ACCOUNT}`, aud: TEST_RESOURCE, email: OWNER_EMAIL });
    const misconfigured = { ...(env as Record<string, unknown>), INTROSPECTION_SECRET: undefined };
    const res = await app.request(
      "https://memory.test/api/v1/notes",
      { headers: { authorization: `Bearer ${token}` } },
      misconfigured as Parameters<typeof app.request>[2],
    );
    expect(res.status).toBe(401);
  });

  it("refuses a response with no subject", async () => {
    const token = await bearerTokenFor({
      sub: `user:${OWNER_ACCOUNT}`,
      email: OWNER_EMAIL,
      respondWith: { status: 200, body: { active: true, aud: [TEST_RESOURCE], scope: "notes:read" } },
    });
    expect((await get("/api/v1/notes", token)).status).toBe(401);
  });
});
