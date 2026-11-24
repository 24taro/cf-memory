import { Hono, type Context } from "hono";
import type { FC } from "hono/jsx";
import { allows, callerIsAdmin, effectiveScopes } from "./auth";
import { protectedResourceMetadata, unauthorizedChallenge } from "./rs-introspect";
import { estimateTokens, now, parseValidTs, ulid } from "./db";
import { isNoteKind, isNoteType } from "./spaces";
import { BlockFullError } from "./memory";
import { parseWikilinks, uniqueTargets } from "./links";
import { renderMarkdown, type WikiResolver } from "./markdown";
import { handleMcp, MCP_TOOL_NAMES, storedTitle } from "./mcp";
import { NoteInputError, StaleUpsertError, storedAs } from "./notes";
import { searchFilters, SearchInputError, standaloneSearch } from "./search";
import { atomFeed, buildPrompt, changesMd, networkMd, noteMd, profileMd, rankingMd, type GraphData } from "./serialize";
import { blockWriteResult, ensureOwner, getUserByHandle, getUserById, makeServices, resolvePrincipal, serverStatus, type Services, type UserRow } from "./services";
import { attachmentDisposition, BundleQuotaError, BundlesUnconfiguredError, MAX_BUNDLE_FILE_BYTES, resolveServeContentType, validateBundlePath } from "./bundle";
import { boundedBytes, MAX_REQUEST_BODY_BYTES, RequestBodyTooLargeError } from "./bounded-body";
import { SkillsRepo, type SkillInput, type SkillRow } from "./skills";
import { slugify, slugifyPath } from "./slug";
import type { Env, Principal } from "./types";
import { isReadable, readableSqlFor } from "./visibility";
import { pruneLogs, logSettings } from './logs';
import { Layout } from "./web/layout";
import { CaptureInputError, CaptureService } from './capture';
import { AgentHealthPage, CaptureEventPage, CapturePage, CaptureSessionPage, CaptureSessionsPage, ProvenancePage } from './web/agent-pages';
import { type ActivityRow, ActivityPage, ChangesPage, EditPage, HomePage, MemoryPage, MissingNotePage, NetworkPage, NotePage, PreviewPage, ProfilePage, RankingPage, SearchPage, SkillEditPage, SkillPage, SkillsListPage } from "./web/pages";
import { toRecallSections } from "./web/recall-sections";

type Vars = {
  services: Services;
  owner: UserRow;
  principal: Principal;
  budget: number;
  // Per-request CSP nonce for the one static inline <script> (network graph).
  // Defense-in-depth alongside markdown.ts's output sanitization: script-src
  // carries no 'unsafe-inline', so any attacker-controlled markup that somehow
  // slipped an inline <script> past the sanitizer still can't execute.
  cspNonce: string;
};

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

// W1: HTTP methods the CSRF Origin check below treats as state-changing.
// GET/HEAD are read-only and OPTIONS is a preflight, never a real state change,
// so all three are excluded.
const CSRF_GUARDED_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

app.use("*", async (c, next) => {
  const privateCapture = /^\/(?:capture(?:\/|$)|api\/v1\/capture(?:\/|$)|agent-health$|provenance\/|version$)/.test(new URL(c.req.url).pathname);
  if (privateCapture) c.header('Cache-Control', 'private, no-store');
  const env = c.env;
  c.set("services", makeServices(env.DB, env.BUNDLES ?? null, env, task => {
    try { c.executionCtx.waitUntil(task); }
    catch { return task; } // Direct app/test callers without an ExecutionContext.
  }));
  c.set("owner", await ensureOwner(env.DB, env));
  const url = new URL(c.req.url);
  const principal = await resolvePrincipal(env.DB, env, c.req.raw.headers);
  c.set("principal", principal);
  // W1 (security, defense-in-depth): CSRF Origin check for cookie-authenticated
  // state-changing requests. Cloudflare Access's session cookie (CF_Authorization,
  // which replaced the deleted eg_session cookie) gets its SameSite attribute from
  // the Zero Trust dashboard configuration -- NOT from this code -- so that
  // protection is config-dependent and unverifiable from here. Worse, several
  // cookie-authenticated write sinks live under /@:handle/* (keys mint/revoke,
  // note/skill edit, skill delete/fork) OUTSIDE the /access* edge Access
  // application boundary, so the edge app's own gate can't backstop them either.
  // This check is the code-side backstop: an Access-cookie-authenticated caller
  // (authSource "access") making a state-changing request (anything but
  // GET/HEAD/OPTIONS) is rejected when it carries an Origin header that doesn't
  // match this request's own origin. An ABSENT Origin header is allowed through --
  // CSRF exploits require a browser, and browsers attach Origin to every
  // cross-origin (and same-origin) POST/PUT/PATCH/DELETE; only non-browser
  // callers (curl, wrangler-dev smoke tests, this repo's test harness) omit it,
  // so those keep working unaffected. Bearer callers (authSource "bearer") never
  // carry the vulnerable cookie in the first place and are untouched here.
  if (principal.authSource === "access" && CSRF_GUARDED_METHODS.has(c.req.method)) {
    const origin = c.req.header("origin");
    if (origin && origin !== url.origin) {
      return c.json({ error: "forbidden: cross-origin request rejected" }, 403);
    }
  }
  c.set("budget", Number(env.RECALL_TOKEN_BUDGET ?? "2000") || 2000);
  const nonce = crypto.randomUUID();
  c.set("cspNonce", nonce);
  await next();
  // requireRead may replace the prepared headers with a new Response.
  if (privateCapture) c.header('Cache-Control', 'private, no-store');
  // Defense-in-depth against stored XSS (markdown.ts sanitizes renderMarkdown's
  // output, but this is a second, independent layer): a restrictive CSP on every
  // response. No 'unsafe-inline' for script-src — the one legitimate inline
  // <script> (NetworkPage's graph renderer) carries this request's nonce instead.
  // style-src keeps 'unsafe-inline' for the static, hardcoded CSS in web/layout.tsx
  // (never derived from note/skill/bio content, so it isn't part of the XSS
  // threat model this header defends against). The redesign loads three Google
  // web fonts, so style-src also allows the stylesheet host (fonts.googleapis.com)
  // and font-src the font-file host (fonts.gstatic.com); script-src is untouched
  // (still no 'unsafe-inline', nonce-gated) so the XSS posture is unchanged.
  c.header(
    "Content-Security-Policy",
    `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' https: data:; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
  );
  // 2026-11-14: a note may embed an image from any https host (img-src above) and
  // link anywhere, and the page URL names the member and the note. Send no
  // Referer to another origin. `same-origin`, not `no-referrer`: under
  // `no-referrer` a browser sends `Origin: null` on a form POST, which the CSRF
  // Origin check above would refuse for every edit form. Rendered <img> tags also
  // carry referrerpolicy="no-referrer" (markdown.ts). The image host still sees
  // the reader's IP address and the time of the request.
  c.header("Referrer-Policy", "same-origin");
});

// Fail-closed gate (decision 9: the visibility axis is retired). Everything
// except the short allowlist below requires an authenticated principal:
// browsers get redirected to /access/login (Cloudflare Access SSO, Task 5),
// API/MCP/machine surfaces get 401 JSON. The data layer is ALSO closed
// (accessClause binds user_id to the VIEWER; anonymous matches nothing and one
// account never matches another's rows), so this gate is presentation-level
// fail-closed on top of an already-closed substrate, not the only lock.
//
// 2026-08-18: this used to say "owner-only instance", which was true when there
// was one account. The mechanism did not change — every row has carried user_id
// all along — but "owner-only" now reads as "there is no isolation to get
// wrong", which is the opposite of the truth.
// `/.well-known/oauth-protected-resource*` MUST be reachable unauthenticated:
// it is how an MCP client discovers WHERE to authenticate (RFC 9728). Gating it
// behind the very auth it advertises makes the discovery loop unsolvable — the
// client gets a 401 whose remedy it cannot find. The document itself is pure
// metadata (issuer, scope names) and exposes no data.
/** Access は通ったが cf-memory に招待されていない人に見せる唯一の画面。
 *
 * tasks の非メンバー画面と同じ3要素にしてある: 見出し、判定に使った住所、入り直す導線。
 * 住所を出すのは、この拒否の実際の原因が「メンバーでない」より「別の Google
 * アカウントでログインしている」の方が多いから(2026-08-18 の実測)。そのとき必要な
 * 操作は待つことでも再試行でもなく、入り直すことで、住所が出ていないと本人にも
 * どちらか分からない。 */
const NotInvitedPage: FC<{ email: string }> = ({ email }) => (
  <Layout title="not invited">
    <h1>cf-memory にまだ招待されていません</h1>
    {email ? (
      <p class="muted">
        <strong>{email}</strong> としてログインしています。
      </p>
    ) : null}
    <p>
      <a href="/cdn-cgi/access/logout">ログアウトして入り直す</a>
    </p>
  </Layout>
);

const OPEN_PATHS = [/^\/access(\/|$)/, /^\/\.well-known\/oauth-protected-resource/];
app.use("*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (OPEN_PATHS.some((re) => re.test(path))) return next();
  if (!c.var.principal.anonymous) return next();

  // Cloudflare Access vouched for this person, but cf-memory has no row for them.
  // This must NOT fall through to the redirect below: they already passed the
  // SSO it points at, so sending them back loops. And it must not read as a
  // temporary failure — waiting does not help, an invitation does.
  const p = c.var.principal;
  if (p.notInvited) {
    if (path.startsWith("/api/") || path === "/mcp" || !(c.req.header("accept") ?? "").includes("text/html")) {
      return c.json(
        {
          error: { code: "NOT_INVITED", message: "cf-memory にまだ招待されていません", details: { email: p.email } },
        },
        403,
      );
    }
    return c.html(<NotInvitedPage email={p.email ?? ""} />, 403);
  }

  // Machine surfaces: JSON 401. Everything else (the human web garden,
  // .md twins, feed.xml) redirects a browser to /access/login; non-HTML
  // accepts get the JSON 401 too so curl/agents see a clean fail-closed signal.
  const wantsHtml = (c.req.header("accept") ?? "").includes("text/html");
  if (path.startsWith("/api/") || path === "/mcp" || !wantsHtml) {
    // The challenge is what makes the 401 actionable: it names the metadata
    // document, and an MCP client walks from there to the authorization server
    // and opens a browser. Without this header the client can only report a
    // dead server (RFC 6750 §3 / RFC 9728 §5.1).
    const issuer = c.env.AUTH_ISSUER?.trim();
    // No authorization server configured (single-owner mode): there is no
    // metadata document to point at, so the challenge is the bare scheme.
    if (!issuer) {
      return c.json(
        { error: "unauthorized: present this instance's API token as a Bearer token (Authorization: Bearer <token>), or sign in." },
        401,
        { "www-authenticate": "Bearer" },
      );
    }
    return c.json(
      {
        error: `unauthorized: present a Bearer access token from ${issuer}, or sign in. Every account has its own space — reads without a credential return nothing rather than someone else's notes.`,
      },
      401,
      Object.fromEntries(unauthorizedChallenge(resourceMetadataUrl(c.env, c.req.url), "notes:read notes:write")),
    );
  }
  return c.redirect(`/access/login?next=${encodeURIComponent(path)}`);
});

// Read-scope gate, default-on (2026-11-14). Every authenticated GET/HEAD needs
// notes:read unless its path is listed here. requireRead used to be called
// handler by handler, and the handlers that forgot it (slug-keyed notes, links,
// skill detail/install, graph, the whole web garden and its .md twins) served a
// Bearer token that had not been granted notes:read. A new GET route is now
// covered without doing anything; test/security/read-scope.test.ts walks the
// registered routes. Only paths that return no stored memory belong in this
// list: identity, the static door listing, and /mcp, which decides per tool
// (src/mcp.ts toolScopeRefusal). The human door carries no scopes and allows()
// answers true for it, so nothing changes there. Reads that are not GETs
// (POST /recall, /prompt) and every write keep their own requireRead/requireWrite.
const READ_SCOPE_EXEMPT = new Set(["/api/v1/whoami", "/api/v1/openapi", "/mcp"]);
app.use("*", async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
  const path = new URL(c.req.url).pathname;
  if (OPEN_PATHS.some((re) => re.test(path)) || READ_SCOPE_EXEMPT.has(path)) return next();
  return requireRead(c) ?? next();
});

// MCP parses its own bounded JSON and bundle PUT has a smaller byte limit after
// its ownership check. Bound the other body-consuming routes before Hono parses.
app.use("*", async (c, next) => {
  const request = c.req.raw;
  if (c.req.path !== "/mcp" && request.body && CSRF_GUARDED_METHODS.has(request.method) && request.method !== "PUT") {
    c.req.raw = new Request(request, { body: await boundedBytes(request, MAX_REQUEST_BODY_BYTES) });
  }
  return next();
});

/** Canonical resource URI of this instance == the `aud` every access token must
 * carry. Unset, it is this request's own origin: an advertisement can never
 * name another deployment. (Token validation never uses this fallback — it
 * requires RESOURCE_URI, see resolvePrincipal.) */
function resourceUri(env: Env, requestUrl: string): string {
  return env.RESOURCE_URI?.trim() || `${new URL(requestUrl).origin}/mcp`;
}

function resourceMetadataUrl(env: Env, requestUrl: string): string {
  const u = new URL(resourceUri(env, requestUrl));
  // RFC 9728 path insertion: a resource at /mcp advertises its metadata at
  // /.well-known/oauth-protected-resource/mcp.
  return `${u.origin}/.well-known/oauth-protected-resource${u.pathname === "/" ? "" : u.pathname}`;
}

/** Protected Resource Metadata (RFC 9728), at the path-inserted location only.
 * A document served at the root would have to name the root as its `resource`
 * to be consistent, and this server's resource is `…/mcp` — advertising the
 * same body at both paths makes one of them wrong. The WWW-Authenticate header
 * points here, so nothing has to probe. */
app.get("/.well-known/oauth-protected-resource/mcp", (c) => {
  const issuer = c.env.AUTH_ISSUER?.trim();
  // Single-owner mode has no authorization server to advertise.
  if (!issuer) return c.json({ error: "not found: this instance has no authorization server (it accepts its API token)" }, 404);
  return c.json(
    protectedResourceMetadata({
      resource: resourceUri(c.env, c.req.url),
      issuer,
      scopes: ["notes:read", "notes:write"],
    }),
    200,
    { "cache-control": "public, max-age=300" },
  );
});

// A retry-exhausted upsert on the REST/web write door throws StaleUpsertError after
// its bounded CAS retry loop gives up under sustained same-slug contention. Without
// a handler that surfaces as a bare Hono 500 ("Internal Server Error") with no
// retry signal. Map it to 409 Conflict + a Retry-After hint so clients back off and
// retry the write. (The MCP door already wraps tool errors into a structured,
// retryable toolError, so this only shapes the REST/web responses.)
app.onError((err, c) => {
  if (err instanceof RequestBodyTooLargeError) return c.json({ error: err.message }, 413);
  if (err instanceof StaleUpsertError) {
    return c.json({ error: "conflict", message: "write conflict under concurrent updates; retry the request" }, 409, { "Retry-After": "1" });
  }
  // Input the note repository refuses (an over-long body, an unknown kind) is the
  // caller's to fix, not a 500.
  if (err instanceof NoteInputError) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: "internal", message: "internal server error" }, 500);
});

// Every c.notFound() call on the human/web door (unknown handle, note, skill,
// lookups — 15+ call sites) previously fell through to Hono's
// default undecorated English plaintext "404 Not Found". Render a proper
// lang="ja" Layout-wrapped page instead. JSON API callers (/api/v1/*) keep a
// plain JSON 404 body — this handler only swaps the human-facing HTML door's
// response, it doesn't change the REST contract.
app.notFound((c) => {
  if (c.req.path.startsWith("/api/v1/")) {
    return c.json({ error: "not found" }, 404);
  }
  return c.html(
    <Layout title="not found">
      <h1>見つかりませんでした</h1>
      <p class="muted">お探しのページは存在しないか、削除された可能性があります。</p>
    </Layout>,
    404,
  );
});

async function resolveWiki(db: D1Database, viewerId: string, handle: string, body: string): Promise<WikiResolver> {
  const targets = uniqueTargets(parseWikilinks(body));
  const existing = new Map<string, string>();
  const wikiVis = readableSqlFor("", viewerId);
  if (targets.length) {
    const ph = targets.map(() => "?").join(",");
    const res = await db
      // 2026-08-22: 独自の述語を手書きし user_id を二重に束縛していた(庭の主と
      // 閲覧者の両方)。結果は正しいが、共有ノートへの [[wikilink]] が解決されず
      // 「まだ書かれていない」と描かれる —— あるものを無いと言う形。
      //
      // 庭の主で絞らないのは、共有ノートが庭を跨ぐから。誰の庭を見ていても、
      // 閲覧者が読める行なら解決してよい。読める範囲は readableSql が唯一の定義。
      .prepare(
        `SELECT slug, title FROM notes WHERE deleted_at IS NULL AND ${wikiVis.sql} AND slug IN (${ph})`,
      )
      .bind(...wikiVis.args, ...targets)
      .all<{ slug: string; title: string }>();
    for (const r of res.results ?? []) existing.set(r.slug, r.title);
  }
  return (slugText, h) => {
    const s = slugifyPath(slugText);
    return { href: `/@${h ?? handle}/n/${s}`, exists: existing.has(s), title: existing.get(s) };
  };
}

// Builds the wikilink graph for the /network view (web + /network.md + the
// GET /api/v1/:handle/graph JSON mount).
//
// The PAGE stays owner-gated: visiting someone else's /network gives an EMPTY
// graph, exactly as before (forgetting that check would hand the whole mesh —
// slugs, titles, edges — to any invited teammate; round-1 review P0).
//
// What changed 2026-08-22 is the CONTENT of your own graph: the rows are picked
// by readableSql (yours + shared) instead of a hand-written `user_id = ?`.
// Since 2026-08-20 resolveWiki resolves a [[wikilink]] against every readable
// row, so a link to a teammate's shared note renders as a real link on the note
// page — while this function, still bound to your user_id, could not see that
// row and drew it as a "wanted" stub. The graph said the note had not been
// written yet, about a note that exists and that you had just followed. A map
// that contradicts the territory is worse than no map.
//
// This was the fourth hand-written read predicate; #150 fixed the other three.
async function buildGraph(db: D1Database, userId: string, isOwner: boolean): Promise<GraphData> {
  if (!isOwner) return { nodes: [], edges: [] };
  const vis = readableSqlFor("n", userId);
  const notesRes = await db
    .prepare(`SELECT slug, title FROM notes n WHERE ${vis.sql} AND deleted_at IS NULL AND n.kind != 'block' `)
    .bind(...vis.args)
    .all<{ slug: string; title: string }>();
  const visible = new Set((notesRes.results ?? []).map((n) => n.slug));
  const nodes = (notesRes.results ?? []).map((n) => ({ id: n.slug, label: n.title || n.slug, stub: false }));
  // Edges are the links OUT OF readable notes. Bound on the source note's own
  // readability (not links.user_id, which records the row owner) so a shared
  // note's outgoing links are part of the mesh too.
  const srcVis = readableSqlFor("s", userId);
  const edgesRes = await db
    .prepare(`SELECT s.slug AS src, l.target_slug AS tgt, l.resolved AS resolved FROM links l JOIN notes s ON s.id=l.src_note_id WHERE ${srcVis.sql} AND s.deleted_at IS NULL AND l.kind='wikilink'`)
    .bind(...srcVis.args)
    .all<{ src: string; tgt: string; resolved: number }>();
  // Resolvedness is derived from VISIBILITY here, not read off links.resolved.
  //
  // rebuildOutgoingLinks still resolves a [[wikilink]] within the writer's own
  // namespace (`WHERE user_id=? AND slug=?`), so a link to a teammate's SHARED
  // note is stored resolved=0 even though the note plainly exists. Trusting that
  // column would keep drawing the shared target as a "wanted" stub — and once
  // the target became visible here, the old branch structure dropped the edge
  // entirely (neither the resolved-and-visible arm nor the unresolved-and-not-
  // visible arm matched), so the link vanished from the map altogether.
  //
  // resolveWiki already decides the same question the same way — does a readable
  // row with this slug exist — so the note page and the graph now agree by
  // construction. Fixing links.resolved at WRITE time would be the deeper fix
  // (it would also repair backlinks across shared notes) but it changes what
  // target_note_id means and how stubs auto-resolve; that is its own change.
  const edges: Array<{ source: string; target: string }> = [];
  const stubSeen = new Set<string>();
  for (const e of edgesRes.results ?? []) {
    if (!visible.has(e.src)) continue;
    if (!visible.has(e.tgt) && !stubSeen.has(e.tgt)) {
      stubSeen.add(e.tgt);
      nodes.push({ id: e.tgt, label: e.tgt, stub: true });
    }
    edges.push({ source: e.src, target: e.tgt });
  }
  return { nodes, edges };
}

// ---------------------------------------------------------------- web (human)
app.get("/", async (c) => {
  const { services, owner, principal } = c.var;
  // Full per-viewer home (issue #91, supersedes #57's owner-name notice): an
  // AUTHENTICATED viewer is sent to their OWN garden, exactly like the bare nav
  // paths (/network, /ranking, ...) redirect just below. Keyed off
  // principal.anonymous/handle (covers BOTH Bearer and Access auth). Anonymous
  // visitors keep the instance owner's public landing (unchanged).
  if (!principal.anonymous) return c.redirect(`/@${principal.handle}`);
  const changes = await services.notes.changes(owner.id, principal, 30);
  return c.html(<HomePage handle={owner.handle} sessionHandle={sessionHandle(c)} changes={changes} />);
});

// Post-SSO landing (design 2026-07-25 §5.2): the edge Access app covers
// /access*, so a browser reaching this route has just passed (or already
// holds) SSO — the global middleware resolved its JWT into a principal.
// Bounce to `next` (relative paths only — same open-redirect guard as the
// old /login). Anonymous here means a valid-but-disallowed identity or a
// direct hit with no JWT: fail closed with a denial page, never a loop.
// The Cloudflare Access application is attached to this path, so SSO lands here
// after a successful login. The key console it used to render is gone (the keys
// it minted authenticate nothing now), but landing on a 404 after signing in
// reads as a broken login — send the owner to their garden instead.
app.get("/access", (c) => {
  const p = c.var.principal;
  return c.redirect(p.anonymous ? "/access/login" : `/@${p.handle}`);
});

app.get("/access/login", (c) => {
  const nextRaw = c.req.query("next") ?? "/";
  // Open-redirect guard: normalize through the URL parser (which strips the
  // same control chars browsers strip). Accept the result only if it stayed
  // on our sentinel origin — anything that escapes (//host, /\host, /\t/host)
  // resolves to a foreign origin and falls back to "/".
  //
  // 2026-11-14: the origin check alone is not the guard. The parser drops a dot
  // segment but keeps the empty segment after it, so `/.//host` (and `/..//host`,
  // `/%2e//host`, `/./\host`) stays on the sentinel origin while its pathname
  // becomes `//host` — which a browser reads as another site. The string checked
  // has to be the string sent: exactly one leading slash, then neither `/` nor
  // `\`, and no control character anywhere.
  let next = "/";
  if (nextRaw.startsWith("/")) {
    try {
      const u = new URL(nextRaw, "https://next.invalid");
      const target = u.pathname + u.search + u.hash;
      if (u.origin === "https://next.invalid" && /^\/(?![/\\])[^\x00-\x1f\x7f]*$/.test(target)) next = target;
    } catch {
      /* keep "/" */
    }
  }
  if (!c.var.principal.anonymous) return c.redirect(next);
  return c.html(
    <Layout title="access denied">
      <h1>アクセスできません</h1>
      <p class="muted">このインスタンスはオーナー専用です。許可されたアカウントで SSO ログインしてください。</p>
    </Layout>,
    403,
  );
});

function searchQueryFilters(query: Record<string, string>, form = false) {
  const raw: Record<string, unknown> = { ...query };
  if (form) for (const key of ['memory_type', 'file_ref', 'created_since', 'created_until', 'updated_since', 'updated_until']) if (raw[key] === '') delete raw[key];
  if (raw.current_only != null) {
    if (!['true', 'false'].includes(String(raw.current_only))) throw new SearchInputError('invalid current_only');
    raw.current_only = raw.current_only === 'true';
  }
  return searchFilters(raw);
}

app.get("/search", async (c) => {
  const { services, owner, principal } = c.var;
  const q = c.req.query("q") ?? "";
  // `mode` is ignored: semantic search was removed (2026-10-31) and every mode
  // is keyword search, so the page no longer offers a mode selector.
  const rawScope = c.req.query("scope");
  const scope: "notes" | "skills" | "all" = rawScope === "notes" || rawScope === "skills" ? rawScope : "all";
  // #117: `context` is the project-scope filter (labelled スコープ in the UI), distinct
  // from `scope` (the corpus). Validate it against the caller's readable scopes so an
  // out-of-range/crafted value falls back to "no filter" instead of reaching hybrid.
  const scopes = await services.search.listScopes(principal);
  // この画面は <select> で1つ選ぶ UI なので単数のまま。複数指定は API / MCP 側の話。
  const rawContext = c.req.query("context");
  const context = rawContext && scopes.includes(rawContext) ? rawContext : null;
  try {
    const filters = searchQueryFilters(c.req.query(), true);
    const result = q ? await standaloneSearch(services.search, principal, q, { ...filters, scope, context, limit: 30 }) : null;
    return c.html(<SearchPage handle={owner.handle} sessionHandle={sessionHandle(c)} q={q} scope={scope} scopes={scopes} context={context} filters={filters} hits={result?.hits ?? []} />);
  } catch (error) {
    if (error instanceof SearchInputError) return c.text(error.message, 400);
    throw error;
  }
});

// Bare nav paths redirect to the caller's own canonical /@handle routes when
// authenticated (so a teammate lands on their own garden, not always the
// instance owner's); anonymous visitors keep the old owner-handle default.
for (const p of ["network", "ranking", "changes", "feed.xml", "index.md"]) {
  app.get(`/${p}`, (c) => c.redirect(`/@${c.var.principal.anonymous ? c.var.owner.handle : c.var.principal.handle}/${p}`));
}

const H = "/:h{@[^/]+}";

app.get(H, async (c) => {
  const { services, principal, owner } = c.var;
  const handle = c.req.param("h").slice(1);
  const user = await getUserByHandle(c.env.DB, handle);
  if (!user) return c.notFound();
  const notes = await services.notes.list(principal, { ownerId: user.id });
  const bioHtml = user.bio_md ? renderMarkdown(user.bio_md, () => ({ href: "#", exists: false })) : "";
  // Core-memory ("常に読まれる記憶") glance on the owner's own home. Owner-gated
  // exactly like the /memory route: listBlocks is scoped to the CALLING principal,
  // so only fetch/pass it when the browser session IS the page's owner — a
  // teammate viewing /@owner never receives the owner's private blocks.
  const blocks = sessionHandle(c) === handle ? await services.memory.listBlocks(principal) : [];
  return c.html(<ProfilePage handle={handle} sessionHandle={sessionHandle(c)} bioHtml={bioHtml} notes={notes} blocks={blocks} />);
});

app.get(`${H}/changes`, async (c) => {
  const { services, principal } = c.var;
  const handle = c.req.param("h").slice(1);
  const user = await getUserByHandle(c.env.DB, handle);
  if (!user) return c.notFound();
  const changes = await services.notes.changes(user.id, principal, 60);
  return c.html(<ChangesPage handle={handle} sessionHandle={sessionHandle(c)} changes={changes} />);
});

// --- dual surface: a `.md` twin (and Atom feed) for every view ---
app.get(`${H}/changes.md`, async (c) => {
  const { services, principal } = c.var;
  const handle = c.req.param("h").slice(1);
  const user = await getUserByHandle(c.env.DB, handle);
  if (!user) return c.notFound();
  return c.text(changesMd(handle, await services.notes.changes(user.id, principal, 100)));
});
app.get(`${H}/ranking.md`, async (c) => {
  const { services, principal } = c.var;
  const handle = c.req.param("h").slice(1);
  const user = await getUserByHandle(c.env.DB, handle);
  if (!user) return c.notFound();
  return c.text(rankingMd(handle, await services.notes.ranking(user.id, principal, 100)));
});
app.get(`${H}/network.md`, async (c) => {
  const { principal } = c.var;
  const handle = c.req.param("h").slice(1);
  const user = await getUserByHandle(c.env.DB, handle);
  if (!user) return c.notFound();
  return c.text(networkMd(handle, await buildGraph(c.env.DB, user.id, principal.userId === user.id)));
});
app.get(`${H}/index.md`, async (c) => {
  const { services, principal } = c.var;
  const handle = c.req.param("h").slice(1);
  const user = await getUserByHandle(c.env.DB, handle);
  if (!user) return c.notFound();
  const [notes, skills] = await Promise.all([services.notes.list(principal, { ownerId: user.id }), services.skills.list(principal, { ownerId: user.id })]);
  return c.text(profileMd(handle, notes, skills));
});
app.get(`${H}/feed.xml`, async (c) => {
  const { services, principal } = c.var;
  const handle = c.req.param("h").slice(1);
  const user = await getUserByHandle(c.env.DB, handle);
  if (!user) return c.notFound();
  const xml = atomFeed(handle, new URL(c.req.url).origin, await services.notes.changes(user.id, principal, 50));
  return c.body(xml, 200, { "content-type": "application/atom+xml; charset=utf-8" });
});

app.get(`${H}/network`, async (c) => {
  const { principal } = c.var;
  const handle = c.req.param("h").slice(1);
  const user = await getUserByHandle(c.env.DB, handle);
  if (!user) return c.notFound();
  const g = await buildGraph(c.env.DB, user.id, principal.userId === user.id);
  // Seed every node at degree 0 FIRST (issue #33) — building `deg` from
  // g.edges alone never registers a node with zero in/out links, so an
  // orphan silently never appears in topConnected even though it's counted
  // in g.nodes.length elsewhere (e.g. networkMd's "nodes: N" header).
  const deg = new Map<string, number>(g.nodes.map((n) => [n.id, 0]));
  for (const e of g.edges) {
    deg.set(e.source, (deg.get(e.source) ?? 0) + 1);
    deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
  }
  const stubSet = new Set(g.nodes.filter((n) => n.stub).map((n) => n.id));
  const topConnected = [...deg.entries()]
    .map(([id, degree]) => ({ id, label: g.nodes.find((n) => n.id === id)?.label ?? id, degree, stub: stubSet.has(id) }))
    .sort((a, b) => b.degree - a.degree)
    .slice(0, 15);
  const edges = g.edges.slice(0, 50).map((e) => ({ ...e, stub: stubSet.has(e.target) }));
  return c.html(<NetworkPage handle={handle} sessionHandle={sessionHandle(c)} topConnected={topConnected} edges={edges} nonce={c.var.cspNonce} />);
});

app.get(`${H}/ranking`, async (c) => {
  const { services, principal } = c.var;
  const handle = c.req.param("h").slice(1);
  const user = await getUserByHandle(c.env.DB, handle);
  if (!user) return c.notFound();
  const rows = await services.notes.ranking(user.id, principal, 50);
  return c.html(<RankingPage handle={handle} sessionHandle={sessionHandle(c)} rows={rows} />);
});

// issue #89: dedicated skills-listing screen (the スキル nav points here).
// skills.list is owner-only (decision 9).
app.get(`${H}/skills`, async (c) => {
  const { services, principal } = c.var;
  const handle = c.req.param("h").slice(1);
  const user = await getUserByHandle(c.env.DB, handle);
  if (!user) return c.notFound();
  const skills = await services.skills.list(principal, { ownerId: user.id });
  return c.html(<SkillsListPage handle={handle} sessionHandle={sessionHandle(c)} skills={skills} />);
});

app.get(`${H}/skills/:slug/SKILL.md`, async (c) => {
  const { services, principal } = c.var;
  const user = await getUserByHandle(c.env.DB, c.req.param("h").slice(1));
  if (!user) return c.notFound();
  const s = await services.skills.getBySlug(user.id, slugify(c.req.param("slug")));
  if (!s || !isReadable(s, principal)) return c.notFound();
  return c.text(s.skill_md);
});

// Raw bundle file (phase 2b). Visibility gated by isReadable only; 404 on
// unreadable/missing so a private
// skill's existence never leaks. Served defensively against stored XSS: an
// authoritative content-type (resolveServeContentType never emits active types —
// html/js/svg all collapse to application/octet-stream), X-Content-Type-Options:
// nosniff (no MIME sniffing), and Content-Disposition: attachment for everything
// except inline-safe raster images — so an uploaded .html/.js/.svg downloads
// instead of executing on the app's own cookie origin. (The global middleware also
// stamps its page CSP on this response; it is moot for an attachment download but
// harmless.)
app.get(`${H}/skills/:slug/files/:path{.+}`, async (c) => {
  if (!c.env.BUNDLES) return c.notFound();
  const { services, principal } = c.var;
  const user = await getUserByHandle(c.env.DB, c.req.param("h").slice(1));
  if (!user) return c.notFound();
  const s = await services.skills.getBySlug(user.id, slugify(c.req.param("slug")));
  if (!s || !isReadable(s, principal)) return c.notFound();
  const path = validateBundlePath(c.req.param("path"));
  if (!path) return c.notFound();
  const f = await services.skills.getFile(s.id, path);
  if (!f) return c.notFound();
  const { type, inline } = resolveServeContentType(f.row.content_type);
  const headers: Record<string, string> = { "content-type": type, "x-content-type-options": "nosniff" };
  if (!inline) headers["content-disposition"] = attachmentDisposition(path);
  return new Response(f.bytes, { headers });
});

app.get(`${H}/skills/:slug`, async (c) => {
  const { services, principal } = c.var;
  const handle = c.req.param("h").slice(1);
  const user = await getUserByHandle(c.env.DB, handle);
  if (!user) return c.notFound();
  const s = await services.skills.getBySlug(user.id, slugify(c.req.param("slug")));
  if (!s || !isReadable(s, principal)) return c.notFound();
  const bodyHtml = renderMarkdown(s.instructions_md, () => ({ href: "#", exists: false }));

  // issue #65: fork lineage. The service methods already gate every surfaced row
  // through isReadable(); here we only resolve owner handles (parent/children may
  // belong to DIFFERENT users than :handle) to build /@<owner>/skills/<slug> links.
  // A parent that exists but isn't readable yields parentPrivate (a muted note),
  // never its slug/name/handle. handleFor caches by user_id to avoid N lookups.
  const handleCache = new Map<string, string | null>([[user.id, handle]]);
  const handleFor = async (uid: string): Promise<string | null> => {
    if (handleCache.has(uid)) return handleCache.get(uid) ?? null;
    const u = await getUserById(c.env.DB, uid);
    handleCache.set(uid, u?.handle ?? null);
    return u?.handle ?? null;
  };

  const lineage = await services.skills.parentOf(s, principal);
  let parent: { handle: string; slug: string; name: string } | null = null;
  let parentPrivate = false;
  if (lineage.status === "ok") {
    const ph = await handleFor(lineage.skill.user_id);
    // A readable parent whose owner row somehow can't be resolved is treated as
    // hidden rather than rendered with a broken link — fail closed.
    if (ph) parent = { handle: ph, slug: lineage.skill.slug, name: lineage.skill.name };
    else parentPrivate = true;
  } else if (lineage.status === "hidden") {
    parentPrivate = true;
  }

  const childRows = await services.skills.childrenOf(s.id, principal);
  const forks: Array<{ handle: string; slug: string; name: string }> = [];
  for (const child of childRows) {
    const ch = await handleFor(child.user_id);
    if (ch) forks.push({ handle: ch, slug: child.slug, name: child.name });
  }

  return c.html(<SkillPage handle={handle} sessionHandle={sessionHandle(c)} slug={s.slug} name={s.name} description={s.description} version={s.version} bodyHtml={bodyHtml} isOwner={sessionHandle(c) === handle} parent={parent} parentPrivate={parentPrivate} forks={forks} usageCount={s.usage_count} lastUsedAt={s.last_used_at} provenanceUrl={'/provenance/skill/' + s.id} />);
});

// issue #54: skill edit form -- owner-only (sessionHandle===handle, same
// browser-session-only ownership notion,
// intentionally stricter than noteEditGet's plain allows() check since the
// issue explicitly requires this to be gated to the authenticated OWNER).
// Fetches via principal.userId (not the URL handle's user id) -- consistent
// with noteEditGet/noteEditPost's convention of operating on the caller's own
// resources; the :h path param is only used for the login-redirect/back-link.
app.get(`${H}/skills/:slug/edit`, async (c) => {
  const { services, principal } = c.var;
  const handle = c.req.param("h").slice(1);
  if (sessionHandle(c) !== handle) return ownerOnlyDenied(c);
  const slug = slugify(c.req.param("slug"));
  const skill = await services.skills.getBySlug(principal.userId, slug);
  if (!skill) return c.notFound();
  return c.html(
    <SkillEditPage handle={handle} sessionHandle={sessionHandle(c)} slug={skill.slug} name={skill.name} description={skill.description} instructions={skill.instructions_md} version={skill.version} />,
  );
});

app.post(`${H}/skills/:slug/edit`, async (c) => {
  const { services, principal } = c.var;
  const handle = c.req.param("h").slice(1);
  if (sessionHandle(c) !== handle) return ownerOnlyDenied(c);
  const slug = slugify(c.req.param("slug"));
  const body = await c.req.parseBody();
  await services.skills.upsert(principal, {
    slug,
    name: String(body.name ?? ""),
    description: String(body.description ?? ""),
    instructions: String(body.instructions ?? ""),
    // Empty -> undefined so upsert keeps its auto-patch-bump; a filled value
    // sets that exact version (issue #71).
    version: String(body.version ?? "").trim() || undefined,
  });
  return c.redirect(`/@${handle}/skills/${slug}`);
});

// issue #54: fork someone else's (or your own) readable skill into your own
// account. Visible to any viewer who can read the skill (per the issue), but
// actually performing it requires notes:write -- same redirect-to-login
// pattern every other write route in this file uses, rather than hiding the
// button client-side.
app.post(`${H}/skills/:slug/fork`, async (c) => {
  const { services, principal } = c.var;
  const handle = c.req.param("h").slice(1);
  if (!allows(principal, "notes:write")) return ownerOnlyDenied(c);
  const user = await getUserByHandle(c.env.DB, handle);
  if (!user) return c.notFound();
  const src = await services.skills.getBySlug(user.id, slugify(c.req.param("slug")));
  if (!src || !isReadable(src, principal)) return c.notFound();
  const result = await services.skills.fork(principal, src);
  return c.redirect(`/@${principal.handle}/skills/${result.skill.slug}`);
});

// issue #54: owner-only delete, mirroring skills.softDelete's own fail-closed
// re-check (user_id === principal.userId) -- fetched via principal.userId so a
// non-owner's request simply finds nothing and no-ops, no 500, no redundant
// second ownership check duplicated here.
app.post(`${H}/skills/:slug/delete`, async (c) => {
  const { services, principal } = c.var;
  const handle = c.req.param("h").slice(1);
  if (!allows(principal, "notes:write")) return ownerOnlyDenied(c);
  const slug = slugify(c.req.param("slug"));
  const skill = await services.skills.getBySlug(principal.userId, slug);
  if (skill) await services.skills.softDelete(principal, skill.id);
  return c.redirect(`/@${handle}`);
});

// issue #81: 基本記憶 (core-memory blocks) — first web view of the owner's
// persona/human/conventions/context blocks. Owner-gated (blocks are private —
// listBlocks returns [] for anonymous) like /preview.
app.get(`${H}/memory`, async (c) => {
  const { services, principal } = c.var;
  const handle = c.req.param("h").slice(1);
  const user = await getUserByHandle(c.env.DB, handle);
  if (!user) return c.notFound();
  const sh = sessionHandle(c);
  if (sh !== handle) return ownerOnlyDenied(c);
  const blocks = await services.memory.listBlocks(principal);
  return c.html(<MemoryPage handle={handle} sessionHandle={sh} blocks={blocks} />);
});

// issue #56: recall preview screen ("記憶プレビュー") -- a human-visible window
// into what recall()/build_prompt() actually retrieve for a query. recall() is
// scoped to the CALLING principal, not to the `:handle` in the URL -- there is
// no owner-id separation here like ranking()/skills.list() have (those take an
// explicit ownerId). If this page naively rendered "recall results for
// whichever handle is in the URL", a logged-in viewer opening a teammate's
// /@handle/preview would see THEIR OWN memory mislabeled as the teammate's.
// To avoid that: gate on sessionHandle===handle, but
// (per the issue) render a soft "準備中" placeholder for any other viewer
// (anonymous or a different account) instead of the sessionHandle-gated
// redirect other owner-only pages use (a dead end now that /login is
// deleted) -- still 200, still the same page component, just isOwner=false and
// services.recall.recall() is NEVER called in that branch.
app.get(`${H}/preview`, async (c) => {
  const { services, principal } = c.var;
  const handle = c.req.param("h").slice(1);
  const user = await getUserByHandle(c.env.DB, handle);
  if (!user) return c.notFound();
  const sh = sessionHandle(c);
  const isOwner = sh === handle;
  if (!isOwner) {
    return c.html(<PreviewPage handle={handle} sessionHandle={sh} isOwner={false} />);
  }
  const q = c.req.query("q") ?? "";
  if (!q) {
    return c.html(<PreviewPage handle={handle} sessionHandle={sh} isOwner={true} q="" />);
  }
  const pack = await services.recall.recall(principal, q, c.var.budget, undefined);
  const sections = toRecallSections(pack.sections);
  return c.html(<PreviewPage handle={handle} sessionHandle={sh} isOwner={true} q={q} sections={sections} used={pack.used} budget={pack.budget} />);
});

app.get(`${H}/tags/:tag`, async (c) => {
  const { services, principal } = c.var;
  const handle = c.req.param("h").slice(1);
  const user = await getUserByHandle(c.env.DB, handle);
  if (!user) return c.notFound();
  const notes = await services.notes.list(principal, { ownerId: user.id, tag: c.req.param("tag") });
  return c.html(<ProfilePage handle={handle} sessionHandle={sessionHandle(c)} bioHtml="" notes={notes} blocks={[]} tag={c.req.param("tag")} />);
});

// Note routes accept one-level namespaced slugs (e.g. `mnemo/about`). The handler
// logic is shared; single- and namespaced-segment routes both feed `rawSlug`.
type AppCtx = Context<{ Bindings: Env; Variables: Vars }>;

async function noteEditGet(c: AppCtx, handle: string, rawSlug: string): Promise<Response> {
  const { services, principal } = c.var;
  const slug = slugifyPath(rawSlug);
  if (!allows(principal, "notes:write")) return ownerOnlyDenied(c);
  // The form edits the caller's OWN row at this slug, whatever handle is in the
  // URL, and noteEditPost writes only that row (ownOnly).
  const note = await services.notes.getRowBySlug(principal.userId, slug);
  const tags = note ? await services.notes.tagsFor(note.id) : [];
  return c.html(<EditPage handle={handle} sessionHandle={sessionHandle(c)} slug={slug} title={note?.title ?? ""} body={note?.body_md ?? ""} tags={tags} isNew={!note} />);
}

async function noteEditPost(c: AppCtx, handle: string, rawSlug: string): Promise<Response> {
  const { services, principal } = c.var;
  const slug = slugifyPath(rawSlug);
  if (!allows(principal, "notes:write")) return ownerOnlyDenied(c);
  const body = await c.req.parseBody();
  await services.notes.upsert(principal, {
    slug,
    title: String(body.title ?? slug),
    body_md: String(body.body_md ?? ""),
    tags: String(body.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean),
    // Own namespace only: the form above showed the caller's own row (or a blank
    // one), so the save must not replace a teammate's shared note it never showed.
    ownOnly: true,
  });
  // The save went to the caller's namespace; show that note, not the URL handle's.
  return c.redirect(`/@${principal.handle || handle}/n/${slug}`);
}

async function noteGet(c: AppCtx, handle: string, rawSlug: string): Promise<Response> {
  const { services, principal } = c.var;
  const user = await getUserByHandle(c.env.DB, handle);
  if (!user) return c.notFound();

  if (rawSlug.endsWith(".md")) {
    const slug = slugifyPath(rawSlug.slice(0, -3));
    const note = await services.notes.getRowBySlug(user.id, slug);
    // C5: no live note at this slug -> follow a rename redirect (301) if one
    // exists, preserving the .md suffix + query, before 404ing. Gate the 301 on
    // the SAME visibility rule as a direct read (isReadable), else the redirect
    // leaks a private note's existence + new slug to non-readers.
    if (!note) {
      const target = await services.notes.redirectTarget(user.id, slug);
      if (target && isReadable(target, principal)) return c.redirect(`/@${handle}/n/${target.slug}.md${new URL(c.req.url).search}`, 301);
    }
    if (!note || !isReadable(note, principal)) return c.notFound();
    // B1: emit a complete, re-parseable frontmatter so `pull .md -> edit -> push`
    // round-trips slug/tags/date (not just title/stage). date = the
    // note's created_at as a full ISO string so it re-parses to the same instant.
    const mdTags = await services.notes.tagsFor(note.id);
    // decision 10: round-trip the bi-temporal validity window + supersession link
    // (as ISO / a slug) so `pull .md -> edit -> push` preserves them too. supersedes
    // is emitted as the target's SLUG (human-readable + re-resolvable on push).
    let supersedes: string | null = null;
    if (note.supersedes) {
      const sup = await services.notes.getRowById(note.supersedes);
      if (sup && sup.user_id === principal.userId) supersedes = sup.slug;
    }
    // noteMd (serialize.ts) owns the text: it quotes any title/tag/slug that could
    // add or close a frontmatter line, and normalizes the body's trailing newlines.
    return c.text(noteMd({
      title: note.title, slug: note.slug, tags: mdTags, stage: note.stage, createdAt: note.created_at,
      validFrom: note.valid_from, validUntil: note.valid_until, supersedes, body: note.body_md,
    }));
  }

  const slug = slugifyPath(rawSlug);
  const note = await services.notes.getRowBySlug(user.id, slug);
  // C5: no live note here -> follow a rename redirect (301) if one exists,
  // preserving the query string, before falling through to the 404 page. Gate on
  // the SAME visibility rule as a direct read (isReadable) so the redirect never
  // leaks a private note's existence + new slug to non-readers.
  if (!note) {
    const target = await services.notes.redirectTarget(user.id, slug);
    if (target && isReadable(target, principal)) return c.redirect(`/@${handle}/n/${target.slug}${new URL(c.req.url).search}`, 301);
  }
  const canEdit = allows(principal, "notes:write") && principal.userId === user.id;
  if (!note || !isReadable(note, principal)) {
    const backlinks = await services.notes.backlinksBySlug(slug, principal.userId);
    return c.html(<MissingNotePage handle={handle} sessionHandle={sessionHandle(c)} slug={slug} backlinks={backlinks} canEdit={canEdit} />, 404);
  }
  await services.notes.incrementView(note.id);
  const [tags, backlinks, outgoing, resolver] = await Promise.all([
    services.notes.tagsFor(note.id),
    services.notes.backlinks(note.id, principal.userId),
    services.notes.outgoing(note.id, principal.userId),
    resolveWiki(c.env.DB, principal.userId, handle, note.body_md),
  ]);
  const bodyHtml = renderMarkdown(note.body_md, resolver);
  return c.html(
    <NotePage handle={handle} sessionHandle={sessionHandle(c)} slug={note.slug} title={note.title} stage={note.stage} scope={note.scope} updatedAt={note.updated_at} tags={tags} bodyHtml={bodyHtml} backlinks={backlinks} outgoing={outgoing} canEdit={canEdit} provenanceUrl={'/provenance/note/' + note.id} />,
  );
}

const hh = (c: AppCtx) => (c.req.param("h") ?? "").slice(1);
const pp = (c: AppCtx, k: string) => c.req.param(k) ?? "";
app.get(`${H}/n/:slug/edit`, (c) => noteEditGet(c, hh(c), pp(c, "slug")));
app.get(`${H}/n/:ns/:slug/edit`, (c) => noteEditGet(c, hh(c), `${pp(c, "ns")}/${pp(c, "slug")}`));
app.post(`${H}/n/:slug/edit`, (c) => noteEditPost(c, hh(c), pp(c, "slug")));
app.post(`${H}/n/:ns/:slug/edit`, (c) => noteEditPost(c, hh(c), `${pp(c, "ns")}/${pp(c, "slug")}`));
app.get(`${H}/n/:slug`, (c) => noteGet(c, hh(c), pp(c, "slug")));
app.get(`${H}/n/:ns/:slug`, (c) => noteGet(c, hh(c), `${pp(c, "ns")}/${pp(c, "slug")}`));

// ------------------------------------------------------------------ JSON API
const api = new Hono<{ Bindings: Env; Variables: Vars }>();

const clampLimit = (raw: string | undefined, def: number): number => {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 200) : def;
};

/** 読み取りにも scope が要る。
 *
 * 2026-08-21: `notes:read` は認可サーバが広告し、トークンに載り、whoami にも出るのに
 * 誰も確認していなかった —— `allows(p, "notes:read")` の呼び出し元がゼロ。読み権限を
 * 与えていないトークンで空間全体が読めた。広告している制限が効いていないのは、
 * 今回の作業で何度も潰してきた「書いてあることと実態が違う」形そのもの。
 *
 * 人間の扉には scope が無いので allows() が true を返す(委譲が起きていない)。
 * 効くのは機械の扉だけで、そこが本来の対象。 */
function requireRead(c: { var: Vars }): Response | null {
  if (c.var.principal.invalidKey) return requireWrite(c);
  if (!allows(c.var.principal, "notes:read")) {
    return new Response(JSON.stringify({ error: "forbidden: notes:read scope required" }), { status: 403, headers: { "content-type": "application/json" } });
  }
  return null;
}

function requireWrite(c: { var: Vars }): Response | null {
  if (c.var.principal.invalidKey) {
    return new Response(JSON.stringify({ error: "invalid or unknown token", hint: "This token is not valid here — expired, revoked, or issued for a different service. Present this instance's API token, or re-authenticate with its authorization server (MCP clients discover one from /.well-known/oauth-protected-resource/mcp). Call whoami to inspect token_status." }), { status: 401, headers: { "content-type": "application/json" } });
  }
  if (!allows(c.var.principal, "notes:write")) {
    return new Response(JSON.stringify({ error: "forbidden: notes:write scope required" }), { status: 403, headers: { "content-type": "application/json" } });
  }
  return null;
}

async function captureRead(c: Context<{ Bindings: Env; Variables: Vars }>, read: () => Promise<Response>) {
  const denied = requireRead(c); if (denied) return denied;
  try { return await read(); }
  catch (error) {
    if (error instanceof CaptureInputError) return c.json({ error: error.message }, 400);
    throw error;
  }
}
function captureArgs(c: Context<{ Bindings: Env; Variables: Vars }>) {
  const args: Record<string, unknown> = {};
  for (const key of ['q', 'session_id', 'tool_name', 'event_type', 'file_ref', 'repo', 'since', 'until', 'cursor']) {
    const value = c.req.query(key); if (value) args[key] = value;
  }
  if (c.req.query('limit')) args.limit = Number(c.req.query('limit'));
  return args;
}

api.get('/capture/sessions', c => captureRead(c, async () => c.json(await c.var.services.capture.sessions(c.var.principal, captureArgs(c)))));
api.get('/capture/search', c => captureRead(c, async () => c.json(await c.var.services.capture.search(c.var.principal, captureArgs(c)))));
api.get('/capture/events', c => captureRead(c, async () => c.json(await c.var.services.capture.getMany(c.var.principal, { ids: (c.req.query('ids') || '').split(',').filter(Boolean) }))));
api.get('/capture/sessions/:id/events', c => captureRead(c, async () => c.json(await c.var.services.capture.sessionTimeline(c.var.principal, { ...captureArgs(c), session_id: c.req.param('id') }))));


api.get("/whoami", (c) => {
  const p = c.var.principal;
  return c.json({
    handle: p.handle,
    anonymous: p.anonymous,
    actor: p.actor,
    scopes: effectiveScopes(p),
    token_status: p.invalidKey ? "invalid" : p.anonymous ? "none" : "active",
  });
});

api.get("/notes", async (c) => {
  const denied = requireRead(c);
  if (denied) return denied;
  const { services, principal } = c.var;
  const items = await services.notes.listMine(principal, { tag: c.req.query("tag") ?? undefined, limit: clampLimit(c.req.query("limit"), 50) });
  return c.json({ notes: items });
});

api.post("/notes", async (c) => {
  const forbidden = requireWrite(c);
  if (forbidden) return forbidden;
  const { services, principal } = c.var;
  const b = await c.req.json<{ slug?: string; title?: string; body_md: string; tags?: string[]; kind?: "note" | "journal" | "observation"; type?: "user" | "feedback" | "project" | "reference"; shared?: boolean; scope?: string; valid_from?: number | string; valid_until?: number | string; supersedes?: string }>();
  if (!b.slug?.trim() && !b.title?.trim() && !b.body_md?.trim()) return c.json({ error: "empty note: provide at least a slug, title, or body_md" }, 400);
  if (b.type !== undefined && !isNoteType(b.type)) {
    return c.json({ error: "type must be one of user, feedback, project, reference" }, 400);
  }
  // 2026-11-14: `kind` も同じ。'block' は core-memory の印で、memory の扉からしか付かない。
  if (b.kind !== undefined && !isNoteKind(b.kind)) {
    return c.json({ error: "kind must be one of note, journal, observation" }, 400);
  }
  // #117: `scope` (client-resolved project: repo/workdir) is passed RAW — upsert
  // normalizes it, defaults a new note to 'global', and preserves it on an edit.
  // decision 10: valid_from/valid_until accept a ms epoch or an ISO string; supersedes
  // a slug/id of the note this one replaces (upsert stamps superseded_by; the old
  // one drops from recall while THIS note is live, and revives if THIS is deleted).
  // 2026-08-22: body を丸ごと展開していたので、`shared` のような内部向けの値が
  // 型検査を受けずに通っていた(MCP 側は typeof で守っている)。受け取る値を
  // 明示する — 展開は、あとで内部フィールドが増えたときに黙って口を開ける。
  const result = await services.notes.upsert(principal, {
    slug: b.slug,
    title: b.title,
    body_md: b.body_md,
    tags: Array.isArray(b.tags) ? b.tags : undefined,
    kind: b.kind,
    type: b.type === undefined ? undefined : b.type,
    shared: typeof b.shared === "boolean" ? b.shared : undefined,
    scope: typeof b.scope === "string" ? b.scope : undefined,
    valid_from: parseValidTs(b.valid_from),
    valid_until: parseValidTs(b.valid_until),
    supersedes: typeof b.supersedes === "string" ? b.supersedes : undefined,
  });
  // 保存先を必ず返す。種類で共有の既定が決まる以上、結果を見ずに
  // 「共有されたか」を知る方法が無くなる。共有は黙って起きてはいけない。
  // 他人の共有ノートに書き込んだときは `written_through` でそう言う。
  const { note, created } = result;
  return c.json(
    // No title for a caller without notes:read: it may be the stored one (storedTitle).
    { id: note.id, slug: note.slug, ...storedTitle(principal, note.title), created, ...storedAs(result) },
    created ? 201 : 200,
  );
});

// C5: rename a note's slug (the old slug keeps resolving via a 301 redirect).
api.post("/notes/:slug/rename", async (c) => {
  const forbidden = requireWrite(c);
  if (forbidden) return forbidden;
  const b = await c.req.json<{ new_slug?: string }>().catch((): { new_slug?: string } => ({}));
  if (!b.new_slug?.trim()) return c.json({ ok: false, reason: "provide new_slug" }, 400);
  const r = await c.var.services.notes.rename(c.var.principal, c.req.param("slug"), b.new_slug);
  return r.ok ? c.json({ ok: true, slug: r.note.slug }) : c.json({ ok: false, reason: r.reason }, 400);
});

api.get("/notes/:id", async (c) => {
  const denied = requireRead(c);
  if (denied) return denied;
  const { services, principal } = c.var;
  const note = await services.notes.getRowById(c.req.param("id"));
  if (!note || !isReadable(note, principal)) return c.json({ error: "not found" }, 404);
  // issue #34: mirrors notes_get's MCP counterpart — this REST door was the
  // other silent gap in the anti-graveyard view_count signal (only the human
  // web-garden page counted views before this fix).
  await services.notes.incrementView(note.id);
  const [tags, backlinks, links] = await Promise.all([
    services.notes.tagsFor(note.id),
    services.notes.backlinks(note.id, principal.userId),
    services.notes.outgoing(note.id, principal.userId),
  ]);
  return c.json({ id: note.id, slug: note.slug, title: note.title, body_md: note.body_md, kind: note.kind, stage: note.stage, type: note.type, shared: Boolean(note.shared), scope: note.scope, content_hash: note.content_hash, valid_from: note.valid_from, valid_until: note.valid_until, supersedes: note.supersedes, superseded_by: note.superseded_by, provenance: await services.capture.provenance('note', note.id,principal), tags, backlinks, links });
});

api.patch("/notes/:id", async (c) => {
  const forbidden = requireWrite(c);
  if (forbidden) return forbidden;
  const { services, principal } = c.var;
  const note = await services.notes.getRowById(c.req.param("id"));
  // A deleted note is not addressable by id (GET answers 404 too). Without this
  // the upsert below, which resolves by slug, found no live own row and could
  // write the tombstone's text into whatever else answers to that slug.
  if (!note || note.user_id !== principal.userId || note.deleted_at) return c.json({ error: "not found" }, 404);
  const b = await c.req.json<Partial<{ title: string; body_md: string; tags: string[]; scope: string; valid_from: number | string; valid_until: number | string; supersedes: string }>>();
  const { note: updated } = await services.notes.upsert(principal, {
    slug: note.slug,
    // Bind the write to the row authorised above: upsert refuses (404) unless the
    // caller's own live row at this slug is exactly this id.
    expectedId: note.id,
    title: b.title ?? note.title,
    body_md: b.body_md ?? note.body_md,
    tags: b.tags,
    // #117: omitted → upsert preserves the existing row's scope on an edit.
    scope: typeof b.scope === "string" ? b.scope : undefined,
    // decision 10: omitted → upsert preserves the row's validity/supersession.
    valid_from: parseValidTs(b.valid_from),
    valid_until: parseValidTs(b.valid_until),
    supersedes: typeof b.supersedes === "string" ? b.supersedes : undefined,
  });
  return c.json({ id: updated.id, slug: updated.slug });
});

api.delete("/notes/:id", async (c) => {
  const forbidden = requireWrite(c);
  if (forbidden) return forbidden;
  const ok = await c.var.services.notes.softDelete(c.var.principal, c.req.param("id"));
  return c.json({ deleted: ok }, ok ? 200 : 404);
});

// Cold tier (curator removed 2026-07-17): archive = out of recall, still in
// search; unarchive restores. Both own-note only (setArchived/unArchive gate).
api.post("/notes/:id/archive", async (c) => {
  const forbidden = requireWrite(c);
  if (forbidden) return forbidden;
  const ok = await c.var.services.notes.setArchived(c.var.principal, c.req.param("id"));
  return c.json({ archived: ok }, ok ? 200 : 404);
});

api.post("/notes/:id/unarchive", async (c) => {
  const forbidden = requireWrite(c);
  if (forbidden) return forbidden;
  const ok = await c.var.services.notes.unArchive(c.var.principal, c.req.param("id"));
  return c.json({ unarchived: ok }, ok ? 200 : 404);
});

api.get("/notes/:id/backlinks", async (c) => {
  const { services, principal } = c.var;
  const note = await services.notes.getRowById(c.req.param("id"));
  if (!note || !isReadable(note, principal)) return c.json({ error: "not found" }, 404);
  return c.json({ backlinks: await services.notes.backlinks(note.id, principal.userId) });
});
api.get("/notes/:id/links", async (c) => {
  const { services, principal } = c.var;
  const note = await services.notes.getRowById(c.req.param("id"));
  if (!note || !isReadable(note, principal)) return c.json({ error: "not found" }, 404);
  return c.json({ links: await services.notes.outgoing(note.id, principal.userId) });
});

async function apiNoteBySlug(c: AppCtx, rawSlug: string): Promise<Response> {
  const { services, principal } = c.var;
  const user = await getUserByHandle(c.env.DB, (c.req.param("h") ?? "").slice(1));
  if (!user) return c.json({ error: "not found" }, 404);
  const note = await services.notes.getRowBySlug(user.id, slugifyPath(rawSlug));
  if (!note || !isReadable(note, principal)) return c.json({ error: "not found" }, 404);
  return c.json({ id: note.id, slug: note.slug, title: note.title, body_md: note.body_md, stage: note.stage });
}
api.get(`/:h{@[^/]+}/n/:slug`, (c) => apiNoteBySlug(c, c.req.param("slug") ?? ""));
api.get(`/:h{@[^/]+}/n/:ns/:slug`, (c) => apiNoteBySlug(c, `${c.req.param("ns") ?? ""}/${c.req.param("slug") ?? ""}`));

api.get("/search", async (c) => {
  const denied = requireRead(c);
  if (denied) return denied;
  const { services, principal } = c.var;
  const q = c.req.query("q") ?? "";
  // Accepted for old clients; every mode is keyword search. An unknown value is
  // still a 400 (standaloneSearch validates it).
  const mode = (c.req.query("mode") as "hybrid" | "keyword" | "semantic") ?? "hybrid";
  const rawScope = c.req.query("scope");
  const scope: "notes" | "skills" | "all" = rawScope === "notes" || rawScope === "skills" ? rawScope : "all";
  // #117: `context` (the caller's current project) is distinct from `scope` (the
  // corpus). When set, hybrid pre-filters to rows in that project scope OR 'global'.
  const context = c.req.queries("context") ?? null;
  // Empty-query contract matches the MCP notes_search tool: `{ hits: [], reason: "provide q" }`.
  if (!q) return c.json({ q, mode, scope, hits: [], reason: "provide q" });
  try {
    const result = await standaloneSearch(services.search, principal, q, { ...searchQueryFilters(c.req.query()), mode, scope, context, limit: clampLimit(c.req.query("limit"), 20) });
    return c.json({ q, mode, scope, ...result });
  } catch (error) {
    if (error instanceof SearchInputError) return c.json({ error: error.message }, 400);
    throw error;
  }
});

// skills (procedural memory)
api.get("/skills", async (c) => {
  const denied = requireRead(c);
  if (denied) return denied;
  const { services, principal } = c.var;
  return c.json({ skills: await services.skills.list(principal, { ownerId: principal.userId, limit: clampLimit(c.req.query("limit"), 50) }) });
});

api.post("/skills", async (c) => {
  const forbidden = requireWrite(c);
  if (forbidden) return forbidden;
  const b = await c.req.json<SkillInput>();
  const { skill, created } = await c.var.services.skills.upsert(c.var.principal, b);
  const { principal } = c.var;
  return c.json({ id: skill.id, slug: skill.slug, ...(allows(principal, "notes:read") ? { name: skill.name } : {}), version: skill.version, created }, created ? 201 : 200);
});

// issue #36: soft-delete, own-skill only (mirrors DELETE /notes/:id). Slug-
// keyed (not id-keyed like notes) since that's the natural handle a caller
// already has for their OWN skill, matching GET/POST /skills' own-principal
// scoping above (no :handle path param).
api.delete("/skills/:slug", async (c) => {
  const forbidden = requireWrite(c);
  if (forbidden) return forbidden;
  const { services, principal } = c.var;
  const s = await services.skills.getBySlug(principal.userId, slugify(c.req.param("slug")));
  const ok = s ? await services.skills.softDelete(principal, s.id) : false;
  return c.json({ deleted: ok }, ok ? 200 : 404);
});

// T5 skill-outcome memory: record whether using this skill worked. Own-skill only,
// slug-keyed (mirrors DELETE /skills/:slug). Body: {outcome, note?}.
api.post("/skills/:slug/log-use", async (c) => {
  const forbidden = requireWrite(c);
  if (forbidden) return forbidden;
  const { services, principal } = c.var;
  const b = await c.req.json<{ outcome?: string; note?: string }>().catch(() => ({}) as { outcome?: string; note?: string });
  if (b.outcome !== "success" && b.outcome !== "partial" && b.outcome !== "failure") return c.json({ error: "outcome must be success | partial | failure" }, 400);
  const s = await services.skills.getBySlug(principal.userId, slugify(c.req.param("slug")));
  const res = s ? await services.skills.logUse(principal, s.id, b.outcome, typeof b.note === "string" ? b.note : undefined) : null;
  return res ? c.json({ ok: true, slug: s?.slug, outcome: b.outcome, ...res }) : c.json({ error: "not found" }, 404);
});

api.get(`/:h{@[^/]+}/skills/:slug`, async (c) => {
  const { services, principal } = c.var;
  const user = await getUserByHandle(c.env.DB, c.req.param("h").slice(1));
  if (!user) return c.json({ error: "not found" }, 404);
  const s = await services.skills.getBySlug(user.id, slugify(c.req.param("slug")));
  if (!s || !isReadable(s, principal)) return c.json({ error: "not found" }, 404);
  const files = (await services.skills.listFiles(s.id)).map((f) => ({ path: f.path, content_type: f.content_type, size: f.size, sha256: f.sha256 }));
  return c.json({ id: s.id, slug: s.slug, name: s.name, description: s.description, version: s.version, skill_md: s.skill_md, files });
});

api.get(`/:h{@[^/]+}/skills/:slug/install`, async (c) => {
  const { services, principal } = c.var;
  const user = await getUserByHandle(c.env.DB, c.req.param("h").slice(1));
  if (!user) return c.json({ error: "not found" }, 404);
  const s = await services.skills.getBySlug(user.id, slugify(c.req.param("slug")));
  if (!s || !isReadable(s, principal)) return c.json({ error: "not found" }, 404);
  await services.skills.recordUse(s.id);
  return c.json({ bundle: await services.skills.bundle(s) });
});

// Bundle file upload/delete (phase 2b). ID-keyed, so requireWrite() (scope only)
// is insufficient — additionally hard-check owner (404, not 403, for a readable-
// but-not-owned or deleted skill). Count received bytes before buffering a file.
api.put(`/skills/:id/files/:path{.+}`, async (c) => {
  const forbidden = requireWrite(c);
  if (forbidden) return forbidden;
  if (!c.env.BUNDLES) return c.json({ error: "bundle files not enabled" }, 501);
  const { services, principal } = c.var;
  const skill = await services.skills.getById(c.req.param("id"));
  if (!skill || skill.user_id !== principal.userId || skill.deleted_at) return c.json({ error: "not found" }, 404);
  const path = validateBundlePath(c.req.param("path"));
  if (!path) return c.json({ error: "invalid path" }, 400);
  try {
    const bytes = await boundedBytes(c.req.raw, MAX_BUNDLE_FILE_BYTES);
    const row = await services.skills.putFile(principal, skill, path, bytes, c.req.header("content-type") ?? null);
    return c.json({ ok: true, path: row.path, size: row.size, sha256: row.sha256, content_type: row.content_type });
  } catch (e) {
    if (e instanceof RequestBodyTooLargeError) return c.json({ error: "file too large" }, 413);
    if (e instanceof BundleQuotaError) return c.json({ error: "bundle quota exceeded", reason: e.reason }, 413);
    if (e instanceof BundlesUnconfiguredError) return c.json({ error: "bundle files not enabled" }, 501);
    throw e;
  }
});

api.delete(`/skills/:id/files/:path{.+}`, async (c) => {
  const forbidden = requireWrite(c);
  if (forbidden) return forbidden;
  if (!c.env.BUNDLES) return c.json({ error: "bundle files not enabled" }, 501);
  const { services, principal } = c.var;
  const skill = await services.skills.getById(c.req.param("id"));
  if (!skill || skill.user_id !== principal.userId || skill.deleted_at) return c.json({ error: "not found" }, 404);
  const path = validateBundlePath(c.req.param("path"));
  if (!path) return c.json({ error: "invalid path" }, 400);
  const ok = await services.skills.deleteFile(principal, skill, path);
  return c.json({ deleted: ok }, ok ? 200 : 404);
});

api.post("/recall", async (c) => {
  const denied = requireRead(c);
  if (denied) return denied;
  const { services, principal, budget } = c.var;
  const b = await c.req.json<{ query?: string; budget?: number; context?: string }>().catch(() => ({}) as { query?: string; budget?: number; context?: string });
  // #117: `context` (caller's current project) narrows the note-backed tiers to
  // that scope + globals. Passed RAW as recall()'s 5th arg (null → cross-scope).
  const pack = await services.recall.recall(principal, b.query ?? "", b.budget ?? budget, undefined, typeof b.context === "string" ? b.context : null);
  // `sections` (issue #69) is a /preview-only, same-process server-side
  // affordance; keep it OFF the REST wire so this token-budgeted response isn't
  // ~doubled by re-emitting every kept item's body (already carried in
  // `included`). Keeps the REST /recall contract byte-identical to pre-#69.
  const { sections: _sections, ...wire } = pack;
  return c.json(wire);
});

api.post("/prompt", async (c) => {
  const denied = requireRead(c);
  if (denied) return denied;
  const { services, principal, budget } = c.var;
  const b = await c.req.json<{ query?: string; budget?: number; context?: string }>().catch(() => ({}) as { query?: string; budget?: number; context?: string });
  const query = b.query ?? "";
  const reqBudget = b.budget ?? budget;
  const overhead = estimateTokens(buildPrompt(principal.handle, query, ""));
  // #117: thread `context` (caller's current project) into recall's 5th arg.
  const pack = await services.recall.recall(principal, query, Math.max(0, reqBudget - overhead), undefined, typeof b.context === "string" ? b.context : null);
  const prompt = buildPrompt(principal.handle, query, pack.text);
  return c.json({ prompt, used: estimateTokens(prompt), budget: reqBudget });
});

api.get("/memory/blocks", async (c) => {
  const denied = requireRead(c);
  if (denied) return denied;
  return c.json({ blocks: await c.var.services.memory.listBlocks(c.var.principal) });
});
api.patch("/memory/blocks/:label", async (c) => {
  const forbidden = requireWrite(c);
  if (forbidden) return forbidden;
  const b = await c.req.json<{ op?: "set" | "append" | "replace"; value: string; char_limit?: number; replace?: string }>();
  // append/replace answer according to the stored block (length, block_full, a
  // match): without notes:read that answer is an oracle for the block's text.
  if ((b.op ?? "set") !== "set") {
    const unreadable = requireRead(c);
    if (unreadable) return unreadable;
  }
  try {
    const block = await c.var.services.memory.setBlock(c.var.principal, c.req.param("label"), b.op ?? "set", b.value, b.char_limit, b.replace);
    // The block is returned only to a caller that may read it (blockWriteResult).
    return c.json({ block: blockWriteResult(c.var.principal, block) });
  } catch (e) {
    // P0 forcing-function: a would-overflow block write is rejected, not truncated.
    if (e instanceof BlockFullError) return c.json({ error: "block_full", label: c.req.param("label"), length: e.length, limit: e.limit, hint: "block is full — condense (op=replace), raise char_limit, or archive the overflow to a note" }, 422);
    throw e;
  }
});

api.get(`/:h{@[^/]+}/graph`, async (c) => {
  const user = await getUserByHandle(c.env.DB, c.req.param("h").slice(1));
  if (!user) return c.json({ nodes: [], edges: [] });
  return c.json(await buildGraph(c.env.DB, user.id, c.var.principal.userId === user.id));
});

// REST: fork a skill
api.post(`/:h{@[^/]+}/skills/:slug/fork`, async (c) => {
  const forbidden = requireWrite(c);
  if (forbidden) return forbidden;
  const { services, principal } = c.var;
  const user = await getUserByHandle(c.env.DB, c.req.param("h").slice(1));
  if (!user) return c.json({ error: "not found" }, 404);
  const src = await services.skills.getBySlug(user.id, slugify(c.req.param("slug")));
  if (!src || !isReadable(src, principal)) return c.json({ error: "not found" }, 404);
  const b = await c.req.json<{ new_slug?: string }>().catch(() => ({}) as { new_slug?: string });
  const { skill } = await services.skills.fork(principal, src, b.new_slug);
  return c.json({ id: skill.id, slug: skill.slug, parent: src.slug }, 201);
});

// E5: synonyms for keyword OR-expansion
api.post("/synonyms", async (c) => {
  const forbidden = requireWrite(c);
  if (forbidden) return forbidden;
  const b = await c.req.json<{ term: string; synonyms: string[] }>().catch(() => ({ term: "", synonyms: [] }) as { term: string; synonyms: string[] });
  const term = (b.term ?? "").toLowerCase().trim();
  if (!term) return c.json({ error: "term required" }, 400);
  for (const syn of b.synonyms ?? []) {
    await c.env.DB.prepare("INSERT OR IGNORE INTO synonyms (id,user_id,term,synonym) VALUES (?,?,?,?)").bind(crypto.randomUUID(), c.var.principal.userId, term, String(syn).toLowerCase().trim()).run();
  }
  return c.json({ ok: true, term });
});




// Admin-only audit view: who/when/what for the CALLER's own activity. Surfaces
// the actor the public changes() feed deliberately omits; does NOT widen the
// anonymous /changes feed. Gate is callerIsAdmin() (issue #67) so an Access-
// authenticated owner (isAdminFlag) reaches it too — not only a Bearer
// admin-scope key — which is the prerequisite for the web 最近の活動 screen;
// this matches how every other admin route in this file already gates. The
// bind target is per-caller (must-fix #5): it returns the calling admin's own
// log, not a hard-coded instance owner, closing the side-channel that opened
// once multiple admins could each self-mint a correctly-bound admin credential.
api.get("/audit", async (c) => {
  const { principal } = c.var;
  if (!callerIsAdmin(principal)) return c.json({ error: "admin scope required" }, 403);
  const r = await c.env.DB.prepare("SELECT actor,actor_ref,verb,target_kind,target_id,summary,created_at FROM events WHERE user_id=? ORDER BY created_at DESC LIMIT ?").bind(principal.userId, clampLimit(c.req.query("limit"), 100)).all();
  return c.json({ events: r.results ?? [] });
});

// rebuild FTS indexes (needed once after a tokenizer migration). callerIsAdmin()
// (issue #67) so an Access-authenticated owner (isAdminFlag) can trigger it from
// the browser too, not only a Bearer admin-scope key.
/** 招待。cf-memory に行があること = このサービスを使えること、なので行を作る操作が
 * そのまま招待になる。
 *
 * インスタンス所有者のみ。cf-memory は招待された人の中で権限を分けないので(3人規模)、
 * 「招待できる人」を分けるのもここ1箇所で足りる。
 *
 * 住所しか渡せないのは Cloudflare Access が住所しか教えないから。その人が
 * 初めてトークンを提示したとき、resolveAccount がこの行に account id を結ぶ。 */
function ownerOnly(c: Context<{ Bindings: Env; Variables: Vars }>): Response | null {
  const p = c.var.principal;
  if (!callerIsAdmin(p) || p.handle !== (c.env.OWNER_HANDLE || "owner")) {
    return c.json({ error: "instance owner only" }, 403);
  }
  return null;
}

api.get("/admin/members", async (c) => {
  const denied = ownerOnly(c);
  if (denied) return denied;
  const rows = await c.env.DB.prepare(
    "SELECT handle, email, auth_user_id, created_at, revoked_at FROM users ORDER BY created_at",
  ).all<{ handle: string; email: string | null; auth_user_id: string | null; created_at: number; revoked_at: number | null }>();
  return c.json({ members: rows.results ?? [] });
});

api.post("/admin/members", async (c) => {
  const denied = ownerOnly(c);
  if (denied) return denied;
  const body = await c.req.json<{ email?: string }>().catch(() => ({}) as { email?: string });
  const email = body.email?.trim().toLowerCase();
  if (!email || !email.includes("@")) return c.json({ error: "email is required" }, 400);

  // 取り消し済みの行も拾う。ここで拾わないと、取り消して戻すだけで新しい行ができ、
  // その人のノートが元の行に取り残される。
  const existing = await c.env.DB.prepare("SELECT handle, revoked_at FROM users WHERE lower(email)=?")
    .bind(email)
    .first<{ handle: string; revoked_at: number | null }>();
  if (existing) {
    if (existing.revoked_at !== null) {
      await c.env.DB.prepare("UPDATE users SET revoked_at=NULL WHERE lower(email)=?").bind(email).run();
      return c.json({ handle: existing.handle, created: false, restored: true });
    }
    return c.json({ handle: existing.handle, created: false });
  }

  // handle は URL の一部になるので、他人の庭と衝突させない。英数字とハイフン以外は
  // 潰す(`someone+test` → `someone-test`)。
  const base = (email.split("@")[0] ?? "user").replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "") || "user";
  const ts = now();
  for (let attempt = 0; attempt < 20; attempt++) {
    const handle = attempt === 0 ? base : `${base}-${attempt}`;
    const taken = await c.env.DB.prepare("SELECT id FROM users WHERE handle=?").bind(handle).first<{ id: string }>();
    if (taken) continue;
    await c.env.DB.prepare(
      `INSERT INTO users (id, handle, display_name, email, bio_md, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', ?, ?)`,
    )
      .bind(ulid(), handle, base, email, ts, ts)
      .run()
      .catch(() => {});
    const created = await c.env.DB.prepare("SELECT handle FROM users WHERE lower(email)=?")
      .bind(email)
      .first<{ handle: string }>();
    if (created) return c.json({ handle: created.handle, created: true });
  }
  return c.json({ error: "could not allocate a handle" }, 500);
});

api.delete("/admin/members/:handle", async (c) => {
  const denied = ownerOnly(c);
  if (denied) return denied;
  const handle = c.req.param("handle");
  // 所有者は外せない。外すと誰も招待できなくなり、復旧手段が D1 直叩きしか残らない。
  if (handle === (c.env.OWNER_HANDLE || "owner")) return c.json({ error: "cannot remove the instance owner" }, 400);
  // 行も email も消さない。印を付けるだけ。email を消すと再招待で行を引けず、
  // 新しい行ができてノートが孤児になる(2026-08-20 に実地確認の準備中に発覚)。
  const res = await c.env.DB.prepare("UPDATE users SET revoked_at=? WHERE handle=? AND revoked_at IS NULL")
    .bind(now(), handle)
    .run();
  return c.json({ removed: res.meta?.changes ?? 0 });
});

api.get("/openapi", (c) =>
  c.json({
    name: "cf-memory",
    version: "0.1.0",
    doors: { web: "/@<handle>", rest: "/api/v1", mcp: "/mcp" },
    mcp_tools: MCP_TOOL_NAMES,
  }),
);

// ------------------------------------------------------------- admin console
/** The handle to show a "logout" link for — only when the CURRENT request is
 * actually authenticated via Cloudflare Access SSO (not a Bearer-authenticated
 * agent, and not an anonymous visitor). Passed to every page's Layout so the
 * topbar can offer a logout link with nowhere else to find one. */
function sessionHandle(c: Context<{ Bindings: Env; Variables: Vars }>): string | undefined {
  return c.var.principal.authSource === "access" ? c.var.principal.handle : undefined;
}

function adminDenied(c: Context<{ Bindings: Env; Variables: Vars }>) {
  return c.html(
    <Layout title="access denied">
      <h1>アクセスできません</h1>
      <p class="muted">このインスタンスはオーナー専用です。許可された SSO アカウントでログインするか、admin スコープのキーでアクセスしてください</p>
    </Layout>,
    403,
  );
}

/** In-route guard for authenticated-but-wrong viewers (a Bearer agent browsing
 * HTML, or a cross-handle viewer). The GLOBAL gate already bounced anonymous
 * browsers to /access/login; by the time these fire the caller is authenticated,
 * so a login redirect would loop — deny flatly instead. */
function ownerOnlyDenied(c: Context<{ Bindings: Env; Variables: Vars }>) {
  return c.html(
    <Layout title="access denied">
      <h1>アクセスできません</h1>
      <p class="muted">このページはオーナーのみ利用できます。</p>
    </Layout>,
    403,
  );
}


// Admin-only 活動ログ (issue #93): the HTML sibling of GET /api/v1/audit. Same
// callerIsAdmin() gate and same per-caller (WHERE e.user_id = principal.userId)
// bind, but renders friendly actor attribution: a caller-scoped LEFT JOIN
// resolves an agent row's actor_ref (an api_key prefix) to the key NAME (k.name),
// falling back to the raw prefix in actorAttribution() if the key was deleted.
// Reachable from the /access console via its 活動ログを見る link.
app.get("/activity", async (c) => {
  const { principal } = c.var;
  if (!callerIsAdmin(principal)) return adminDenied(c);
  const r = await c.env.DB.prepare(
    // actor_ref is the token subject (`machine:build-agent` / `human:<email>`),
    // which is already legible — the old join existed to turn a key prefix into a name.
    "SELECT e.actor, e.actor_ref, e.verb, e.target_kind, e.target_id, e.summary, e.created_at, NULL AS key_name FROM events e WHERE e.user_id = ? ORDER BY e.created_at DESC LIMIT ?",
  )
    .bind(principal.userId, clampLimit(c.req.query("limit"), 100))
    .all<ActivityRow>();
  return c.html(<ActivityPage sessionHandle={sessionHandle(c)} events={r.results ?? []} />);
});




app.route("/api/v1", api);

app.get('/version', c => captureRead(c, async () => c.json(await serverStatus(c.var.services, c.var.principal))));
app.get('/capture', c => captureRead(c, async () => {
  const args = captureArgs(c), filters: Record<string, string> = {};
  for (const [key, value] of Object.entries(args)) if (typeof value === 'string' && key !== 'cursor') filters[key] = value;
  const [result, sessions] = await Promise.all([c.var.services.capture.search(c.var.principal, args), c.var.services.capture.sessions(c.var.principal)]);
  return c.html(<CapturePage handle={sessionHandle(c)} hits={result.hits} sessions={sessions.sessions} filters={filters} nextCursor={result.next_cursor} scanned={result.scanned} scanLimit={result.scan_limit} retention={c.var.services.capture.retentionDays} />);
}));
app.get('/capture/sessions/:id', c => captureRead(c, async () => {
  const id = c.req.param('id'), page = await c.var.services.capture.sessionTimeline(c.var.principal, { ...captureArgs(c), session_id: id });
  if (!page.found) return c.notFound();
  return c.html(<CaptureSessionPage handle={sessionHandle(c)} id={id} events={page.events} nextCursor={page.next_cursor} />);
}));
app.get('/capture/sessions', c => captureRead(c, async () => {
  const page = await c.var.services.capture.sessions(c.var.principal, captureArgs(c));
  return c.html(<CaptureSessionsPage handle={sessionHandle(c)} sessions={page.sessions} nextCursor={page.next_cursor} />);
}));
app.get('/capture/events/:id', c => captureRead(c, async () => {
  const id = c.req.param('id'), detail = await c.var.services.capture.getMany(c.var.principal, { ids: [id] });
  if (!detail.events.length) return c.html(<Layout title="原典を閲覧できません" sessionHandle={sessionHandle(c)}><h1>原典を閲覧できません</h1><p>存在しない、保持期限を過ぎた、または閲覧権限のない原典です。</p><a href="/capture">原典の検索へ</a></Layout>, 404);
  const around = await c.var.services.capture.timeline(c.var.principal, { anchor_event_id: id, before: 3, after: 3 });
  return c.html(<CaptureEventPage handle={sessionHandle(c)} event={detail.events[0]} around={around.events} />);
}));
app.get('/agent-health', c => captureRead(c, async () => {
  const [clients, server] = await Promise.all([c.var.services.capture.health(c.var.principal), serverStatus(c.var.services, c.var.principal)]);
  return c.html(<AgentHealthPage handle={sessionHandle(c)} clients={clients} server={server} nonce={c.var.cspNonce} />);
}));
app.get('/provenance/:kind/:id', c => captureRead(c, async () => {
  const kind = c.req.param('kind'), id = c.req.param('id');
  const row = kind === 'note' ? await c.var.services.notes.getRowById(id) : kind === 'skill' ? await c.var.services.skills.getById(id) : null;
  if (!row || row.deleted_at != null || !isReadable(row, c.var.principal)) return c.notFound();
  const owner = await getUserById(c.env.DB, row.user_id);
  const title = 'title' in row ? row.title : row.name;
  const memoryHref = owner ? `/@${owner.handle}/${kind === 'note' ? 'n' : 'skills'}/${row.slug}` : '/';
  return c.html(<ProvenancePage handle={sessionHandle(c)} title={title} memoryHref={memoryHref} sources={await c.var.services.capture.provenance(kind as 'note' | 'skill', id,c.var.principal)} callerId={c.var.principal.userId} />);
}));

// -------------------------------------------------------------- MCP (agents)
app.all("/mcp", async (c) => {
  const { services, principal, budget } = c.var;
  return handleMcp(c.req.raw, { services, principal, budget });
});

export default Object.assign(app, {
  /** Daily maintenance deletes expired Capture originals, orphaned attachments,
   * and old operation logs in bounded batches. */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (env.DB) {
      ctx.waitUntil(new CaptureService(env.DB).prune(controller.scheduledTime, 20).then(removed => {
        if (removed) console.info(JSON.stringify({ event: 'cf_memory_capture_prune', removed }));
      }).catch(() => console.error('[capture] prune failed; retries next run')));
    }
    if (env.BUNDLES) {
      ctx.waitUntil(new SkillsRepo(env.DB, env.BUNDLES).sweepBundleFiles(controller.scheduledTime).then(removed => {
        if (removed) console.info(JSON.stringify({ event: 'cf_memory_bundle_sweep', removed }));
      }).catch(() => console.error('[bundles] sweep failed; retries next run')));
    }
    if (!env.LOGS) return;
    ctx.waitUntil(pruneLogs(env.LOGS, logSettings(env)).then(result => {
      console.info(JSON.stringify({ event: 'cf_memory_log_prune', ...result }));
    }).catch((error: unknown) => console.error('[logs] prune failed; resumes next run', {
      // The cause, with quoted fragments removed (D1 messages carry no bound values).
      name: (error as Error)?.name, message: String((error as Error)?.message ?? error).replace(/'[^']*'|"[^"]*"/g, '…').slice(0, 300),
    })));
  },
});
