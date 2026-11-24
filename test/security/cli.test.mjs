// Security regressions for the CLI (cli/cf-memory.ts). Runs the real CLI as a child
// process against a loopback stub; HOME/TMPDIR are fresh temp dirs and no
// CF_MEMORY_* variable is inherited. Dummy data only.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, lstatSync, symlinkSync, writeFileSync, chmodSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { noteMd } from "../../src/serialize.ts";
import { parseFrontmatter } from "../../src/frontmatter.ts";

const REPO = resolve(import.meta.dirname, "..", "..");
const CLI = join(REPO, "cli", "cf-memory.ts");
const DUMMY_KEY = "dummy-key-not-a-secret";
const SCOPE = "https://example.invalid/x/y";

let root;
beforeAll(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "cf-memory-sec-cli-"))); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

function scratch(name) {
  const dir = join(root, name);
  const home = join(dir, "home"), tmp = join(dir, "tmp"), work = join(dir, "work");
  for (const d of [home, tmp, work]) mkdirSync(d, { recursive: true });
  return { dir, home, tmp, work };
}

// Minimal environment: nothing inherited except PATH.
function cliEnv(s, extra = {}) {
  return { PATH: process.env.PATH, HOME: s.home, TMPDIR: s.tmp, ...extra };
}

// async spawn (the stub server lives in this process, so we must not block the loop)
function runCli(args, { env, cwd, umask, stdin }) {
  return new Promise((done) => {
    const quoted = [process.execPath, "--experimental-strip-types", "--no-warnings", CLI, ...args].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
    const child = spawn("/bin/sh", ["-c", `umask ${umask ?? "022"}; exec ${quoted}`], { env, cwd, stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    if (stdin !== undefined) child.stdin.end(stdin);
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
    child.on("close", (code) => { clearTimeout(timer); done({ code, stdout, stderr }); });
  });
}

const mode = (p) => (statSync(p).mode & 0o777).toString(8).padStart(4, "0");

// Every file below `dir`, as sorted paths relative to it.
function tree(dir, prefix = "") {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...tree(join(dir, e.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

// Loopback stub. `notes` = the caller's notes ({slug,title,stage,body_md}), `bundle` = the skill-install bundle.
async function stub({ notes = [], bundle } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, raw });
      const json = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      if (req.method === "GET" && req.url === "/api/v1/whoami") return json(200, { handle: "alice", actor: "user", scopes: ["notes:read"], token_status: "active" });
      if (req.method === "GET" && req.url === "/api/v1/notes?limit=200") return json(200, { notes: notes.map((n) => ({ slug: n.slug })) });
      const note = notes.find((n) => req.method === "GET" && req.url === `/api/v1/@alice/n/${n.slug.split("/").map(encodeURIComponent).join("/")}`);
      if (note) return json(200, note);
      if (req.method === "POST" && req.url === "/api/v1/notes") return json(200, { slug: JSON.parse(raw).slug });
      if (bundle && req.method === "GET" && req.url === "/api/v1/@alice/skills/demo/install") return json(200, { bundle });
      return json(404, { error: "not found" });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

const serverEnv = (s, srv) => cliEnv(s, { CF_MEMORY_URL: srv.url, CF_MEMORY_KEY: DUMMY_KEY, CF_MEMORY_HANDLE: "alice" });

async function pullThenPush(name, notes) {
  const s = scratch(name), srv = await stub({ notes });
  try {
    const env = serverEnv(s, srv);
    const garden = join(s.work, "garden");
    const pull = await runCli(["pull", garden], { env, cwd: s.work });
    const files = Object.fromEntries(tree(garden).map((f) => [f, readFileSync(join(garden, f), "utf8")]));
    const push = await runCli(["push", garden, "--scope", SCOPE, "--namespaces"], { env, cwd: s.work });
    const posts = srv.requests.filter((r) => r.method === "POST").map((r) => ({ auth: r.auth, body: JSON.parse(r.raw) }));
    return { pull, push, files, posts };
  } finally { await srv.close(); }
}

describe("cli-config-key-file-default-mode", () => {
  const login = (s, umask) => runCli(["login", "--url", "http://127.0.0.1:9", "--key-stdin", "--handle", "dummy"], { env: cliEnv(s), cwd: s.work, umask, stdin: `${DUMMY_KEY}\n` });
  const dirOf = (s) => join(s.home, ".cf-memory");
  const fileOf = (s) => join(s.home, ".cf-memory", "config.json");

  for (const umask of ["022", "000", "077"]) {
    it(`fresh login under umask ${umask} creates ~/.cf-memory 0700 and config.json 0600`, async () => {
      const s = scratch(`mode-fresh-${umask}`);
      const r = await login(s, umask);
      expect(r.code).toBe(0);
      expect(mode(dirOf(s))).toBe("0700");
      expect(mode(fileOf(s))).toBe("0600");
      expect(JSON.parse(readFileSync(fileOf(s), "utf8"))).toEqual({ url: "http://127.0.0.1:9", key: DUMMY_KEY, handle: "dummy" });
      expect(readdirSync(dirOf(s))).toEqual(["config.json"]); // no temp file left behind
    });
  }

  it("login over a pre-existing 0755 dir / 0644 config.json tightens both", async () => {
    const s = scratch("mode-existing-loose");
    mkdirSync(dirOf(s));
    chmodSync(dirOf(s), 0o755);
    writeFileSync(fileOf(s), JSON.stringify({ url: "http://127.0.0.1:9", key: "old", handle: "old" }));
    chmodSync(fileOf(s), 0o644);
    expect((await login(s, "022")).code).toBe(0);
    expect(mode(dirOf(s))).toBe("0700");
    expect(mode(fileOf(s))).toBe("0600");
    expect(JSON.parse(readFileSync(fileOf(s), "utf8")).key).toBe(DUMMY_KEY);
    expect(readdirSync(dirOf(s))).toEqual(["config.json"]);
  });

  it("plugin-first ordering: a pre-existing 0700 ~/.cf-memory keeps its contents and the new config.json is 0600", async () => {
    const s = scratch("mode-plugin-first");
    mkdirSync(join(dirOf(s), "v3"), { recursive: true, mode: 0o700 });
    chmodSync(dirOf(s), 0o700);
    expect((await login(s, "022")).code).toBe(0);
    expect(mode(dirOf(s))).toBe("0700");
    expect(mode(fileOf(s))).toBe("0600");
    expect(readdirSync(dirOf(s)).sort()).toEqual(["config.json", "v3"]);
  });

  // Review finding 10: installs that logged in with the old CLI never run `login` again.
  it("a non-login command tightens a pre-existing 0755 dir / 0644 config.json and still uses it", async () => {
    const s = scratch("mode-existing-loose-whoami"), srv = await stub();
    try {
      mkdirSync(dirOf(s));
      chmodSync(dirOf(s), 0o755);
      const saved = JSON.stringify({ url: srv.url, key: DUMMY_KEY, handle: "alice" });
      writeFileSync(fileOf(s), saved);
      chmodSync(fileOf(s), 0o644);
      const who = await runCli(["whoami"], { env: cliEnv(s), cwd: s.work });
      expect(who.code).toBe(0);
      expect(who.stdout).toContain("@alice");
      expect(mode(dirOf(s))).toBe("0700");
      expect(mode(fileOf(s))).toBe("0600");
      expect(readFileSync(fileOf(s), "utf8")).toBe(saved);
      expect(readdirSync(dirOf(s))).toEqual(["config.json"]);
    } finally { await srv.close(); }
  });

  it("a command that never reaches the network (usage) tightens them too, and an unreachable server does not undo it", async () => {
    const s = scratch("mode-existing-loose-offline");
    mkdirSync(dirOf(s));
    chmodSync(dirOf(s), 0o777);
    writeFileSync(fileOf(s), JSON.stringify({ url: "http://127.0.0.1:9", key: DUMMY_KEY, handle: "alice" }));
    chmodSync(fileOf(s), 0o666);
    expect((await runCli([], { env: cliEnv(s), cwd: s.work })).code).toBe(0);
    expect([mode(dirOf(s)), mode(fileOf(s))]).toEqual(["0700", "0600"]);
    chmodSync(fileOf(s), 0o640);
    expect((await runCli(["whoami"], { env: cliEnv(s), cwd: s.work })).code).not.toBe(0);
    expect([mode(dirOf(s)), mode(fileOf(s))]).toEqual(["0700", "0600"]);
  });

  it("without a config file nothing is created or chmodded by a non-login command", async () => {
    const s = scratch("mode-no-config"), srv = await stub();
    try {
      mkdirSync(dirOf(s));
      chmodSync(dirOf(s), 0o755); // e.g. some other tool's directory: left alone while it holds no key
      expect((await runCli(["whoami"], { env: serverEnv(s, srv), cwd: s.work })).code).toBe(0);
      expect(mode(dirOf(s))).toBe("0755");
      expect(readdirSync(dirOf(s))).toEqual([]);
      const bare = scratch("mode-no-dir");
      expect((await runCli(["whoami"], { env: serverEnv(bare, srv), cwd: bare.work })).code).toBe(0);
      expect(existsSync(dirOf(bare))).toBe(false);
    } finally { await srv.close(); }
  });

  // Review finding 26: a symlinked config.json (dotfiles manager) is written through, not replaced.
  it("login writes through a symlinked config.json: the link stays, its target gets the new key at 0600, the target's directory is untouched", async () => {
    const s = scratch("mode-symlink");
    const dot = join(s.dir, "dotfiles");
    mkdirSync(dot);
    chmodSync(dot, 0o755);
    writeFileSync(join(dot, "cf-memory.json"), JSON.stringify({ url: "http://127.0.0.1:9", key: "old", handle: "old" }));
    chmodSync(join(dot, "cf-memory.json"), 0o644);
    mkdirSync(dirOf(s));
    symlinkSync(join(dot, "cf-memory.json"), fileOf(s));
    expect((await login(s, "022")).code).toBe(0);
    expect(lstatSync(fileOf(s)).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(dot, "cf-memory.json")).isFile()).toBe(true);
    expect(JSON.parse(readFileSync(join(dot, "cf-memory.json"), "utf8"))).toEqual({ url: "http://127.0.0.1:9", key: DUMMY_KEY, handle: "dummy" });
    expect(mode(join(dot, "cf-memory.json"))).toBe("0600");
    expect(mode(dot)).toBe("0755");
    expect(mode(dirOf(s))).toBe("0700");
    expect(readdirSync(dot)).toEqual(["cf-memory.json"]); // no temp file left beside the target
    expect(readdirSync(dirOf(s))).toEqual(["config.json"]);
  });

  it("login through a relative or dangling config.json symlink creates the target 0600 and keeps the link", async () => {
    const s = scratch("mode-symlink-dangling");
    mkdirSync(join(s.home, "dot"));
    mkdirSync(dirOf(s));
    symlinkSync(join("..", "dot", "cf-memory.json"), fileOf(s)); // relative to ~/.cf-memory, target not there yet
    expect((await login(s, "022")).code).toBe(0);
    expect(lstatSync(fileOf(s)).isSymbolicLink()).toBe(true);
    expect(mode(join(s.home, "dot", "cf-memory.json"))).toBe("0600");
    expect(JSON.parse(readFileSync(join(s.home, "dot", "cf-memory.json"), "utf8")).key).toBe(DUMMY_KEY);
    expect(readdirSync(join(s.home, "dot"))).toEqual(["cf-memory.json"]);
    expect(readdirSync(dirOf(s))).toEqual(["config.json"]);
  });

  it("the saved config is still read back: a later command sends the saved key to the saved URL", async () => {
    const s = scratch("mode-readback"), srv = await stub();
    try {
      const saved = await runCli(["login", "--url", srv.url, "--key-stdin", "--handle", "alice"], { env: cliEnv(s), cwd: s.work, stdin: `${DUMMY_KEY}\r\n` });
      expect(saved.code).toBe(0);
      expect(saved.stdout + saved.stderr).not.toContain(DUMMY_KEY);
      const who = await runCli(["whoami"], { env: cliEnv(s), cwd: s.work });
      expect(who.code).toBe(0);
      expect(who.stdout).toContain("@alice");
      expect(srv.requests.every((r) => r.auth === `Bearer ${DUMMY_KEY}`)).toBe(true);
      expect(srv.requests).toHaveLength(2);
    } finally { await srv.close(); }
  });

  it("rejects a token in argv without echoing it or writing a config", async () => {
    const s = scratch("mode-reject-argv");
    for (const args of [["--key", DUMMY_KEY], [`--key=${DUMMY_KEY}`], ["--key-stdin", DUMMY_KEY], [`--key-stdin=${DUMMY_KEY}`]]) {
      const result = await runCli(["login", ...args], { env: cliEnv(s), cwd: s.work });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("--key-stdin");
      expect(result.stdout + result.stderr).not.toContain(DUMMY_KEY);
      expect(existsSync(fileOf(s))).toBe(false);
    }
  });

  it.each(["", "first\nsecond\n"])("leaves existing config alone when stdin is not one token (%j)", async stdin => {
    const s = scratch(`mode-reject-stdin-${stdin.length}`);
    expect((await login(s, "022")).code).toBe(0);
    const before = readFileSync(fileOf(s), "utf8");
    const result = await runCli(["login", "--key-stdin", "--url", "http://127.0.0.1:8"], { env: cliEnv(s), cwd: s.work, stdin });
    expect(result.code).toBe(1);
    expect(readFileSync(fileOf(s), "utf8")).toBe(before);
  });

  it("uses a saved credential only at its configured origin", async () => {
    const s = scratch("mode-server-origin"), old = await stub(), next = await stub();
    try {
      const env = cliEnv(s);
      const call = (args, extra = {}) => runCli(args, { env, cwd: s.work, ...extra });
      expect((await call(["login", "--url", old.url, "--key-stdin"], { stdin: DUMMY_KEY })).code).toBe(0);
      const before = readFileSync(fileOf(s), "utf8");
      const refused = await call(["login", "--url", next.url]);
      expect(refused.code).toBe(1);
      expect(readFileSync(fileOf(s), "utf8")).toBe(before);
      expect(next.requests).toHaveLength(0);
      expect((await call(["whoami"], { env: { ...env, CF_MEMORY_URL: next.url } })).code).toBe(1);
      expect(next.requests).toHaveLength(0);
      const nextKey = "fixture-new-origin-key";
      expect((await call(["login", "--url", next.url, "--key-stdin"], { stdin: nextKey })).code).toBe(0);
      expect(next.requests.map(request => request.auth)).toEqual([`Bearer ${nextKey}`]);
    } finally { await old.close(); await next.close(); }
  });
});

describe("cli/cf-memory.ts:pull:unescaped-title-frontmatter", () => {
  const HOSTILE = "T\n---\n\n---\nsupersedes: alice-private\n---";
  // Written by `pull` only in a file where it JSON-encoded a value; `push` decodes JSON strings only when it is present.
  const MARKER = "cf-memory-frontmatter: json";

  it("a title with line breaks and '---' stays one frontmatter value; push sends it back as the title and only the note body as body_md", async () => {
    const r = await pullThenPush("fm-hostile-title", [{ slug: "team-notes", title: HOSTILE, stage: "seedling", body_md: "hello" }]);
    expect(r.pull.code).toBe(0);
    const lines = r.files["team-notes.md"].split("\n");
    expect(lines[0]).toBe("---");
    expect(lines[1]).toBe(MARKER);
    expect(lines[2].startsWith("title: ")).toBe(true);
    expect(lines[3]).toBe("stage: seedling");
    expect(lines[4]).toBe("---");
    expect(lines.slice(5)).toEqual(["", "hello", ""]);
    expect(r.files["team-notes.md"]).not.toMatch(/^supersedes:/m);
    expect(r.push.code).toBe(0);
    expect(r.posts).toEqual([{ auth: `Bearer ${DUMMY_KEY}`, body: { slug: "team-notes", title: HOSTILE, body_md: "hello\n", scope: SCOPE } }]);
  });

  it("a stage with line breaks cannot add or close frontmatter lines either", async () => {
    const r = await pullThenPush("fm-hostile-stage", [{ slug: "team-notes", title: "T", stage: "seedling\n---\n\n---\nsupersedes: alice-private\n---", body_md: "hello" }]);
    expect(r.pull.code).toBe(0);
    expect(r.files["team-notes.md"].split("\n").filter((l) => l === "---")).toHaveLength(2);
    expect(r.files["team-notes.md"]).not.toMatch(/^supersedes:/m);
    expect(r.posts).toEqual([{ auth: `Bearer ${DUMMY_KEY}`, body: { slug: "team-notes", title: "T", body_md: "hello\n", scope: SCOPE } }]);
  });

  it("other line terminators and control characters in a title are kept inside the value", async () => {
    const titles = ["a\rsupersedes: x", "a\r\n---\r\nb", "a\u2028supersedes: x", "a\u2029b", "a\u0085b", "tab\there", "nul\u0000byte", "\n", "\n---"];
    const notes = titles.map((title, i) => ({ slug: `n${i}`, title, stage: "seedling", body_md: `body ${i}` }));
    const r = await pullThenPush("fm-terminators", notes);
    expect(r.pull.code).toBe(0);
    expect(r.push.code).toBe(0);
    for (const text of Object.values(r.files)) expect(text.split(/\r\n|[\n\r\u2028\u2029\u0085]/).slice(0, 5).map((l) => l.replace(/^(title): .*/, "$1"))).toEqual(["---", MARKER, "title", "stage: seedling", "---"]);
    const sent = Object.fromEntries(r.posts.map((p) => [p.body.slug, p.body]));
    notes.forEach((n) => expect(sent[n.slug]).toEqual({ slug: n.slug, title: n.title, body_md: `${n.body_md}\n`, scope: SCOPE }));
  });

  it("ordinary titles round-trip exactly (colons, quotes, '#', leading/trailing spaces, Japanese, dashes, backslashes)", async () => {
    const titles = [
      "Design: API v2", "a: b: c", "\"quoted\" title", "'single' title", "\"fully quoted\"", "'fully single'", "ends with \"", "it's", "\"", "'", "\"\"",
      "# heading-like", "note #42", "  padded both sides  ", " leading", "trailing ", "\u3000全角スペース\u3000",
      "日本語のタイトル: メモ「設計」", "絵文字 🎉 と — ダッシュ", "a --- b", "---", "--- ", "C:\\path\\name", "back\\\\slash \\n literal", "{json: like}", "[x]", "true", "123", "~", "- item", "key: \"v\"",
      "The \"plan\"", "Bob's 'draft'", "\"C:\\new\\temp\"", "\"a\\\\b\"", "\"\\u0041\"", "\"say \\\"hi\\\"\"", "'mixed\"", "\"mixed'", MARKER, `x\n${MARKER}`, "cf-memory-frontmatter: none",
    ];
    const notes = titles.map((title, i) => ({ slug: `n${i}`, title, stage: "evergreen", body_md: `body ${i}` }));
    const r = await pullThenPush("fm-ordinary", notes);
    expect(r.pull.code).toBe(0);
    expect(r.push.code).toBe(0);
    const sent = Object.fromEntries(r.posts.map((p) => [p.body.slug, p.body]));
    expect(Object.keys(sent)).toHaveLength(notes.length);
    notes.forEach((n) => expect(sent[n.slug]).toEqual({ slug: n.slug, title: n.title, body_md: `${n.body_md}\n`, scope: SCOPE }));
  });

  it("plain titles keep the readable unquoted form the server's `.md` twin uses", async () => {
    const r = await pullThenPush("fm-plain", [
      { slug: "a", title: "T", stage: "seedling", body_md: "hello" },
      { slug: "b", title: "日本語のタイトル: メモ", stage: "evergreen", body_md: "本文" },
    ]);
    expect(r.files).toEqual({
      "a.md": "---\ntitle: T\nstage: seedling\n---\n\nhello\n",
      "b.md": "---\ntitle: 日本語のタイトル: メモ\nstage: evergreen\n---\n\n本文\n",
    });
  });

  it("pull marks exactly the files in which it JSON-encoded a value, and a value cannot forge or cancel the marker", async () => {
    const r = await pullThenPush("fm-marker", [
      { slug: "plain", title: "The \"plan\" v2", stage: "seedling", body_md: "b" },
      { slug: "quoted", title: "\"C:\\new\\temp\"", stage: "seedling", body_md: "b" },
      { slug: "stage", title: "T", stage: " padded", body_md: "b" },
      { slug: "forge", title: `x\n${MARKER}`, stage: "seedling", body_md: `---\n${MARKER}\ntitle: "\\u0041"\n---\nbody` },
      { slug: "cancel", title: "\"a\\\\b\"\ncf-memory-frontmatter: none", stage: "seedling", body_md: "b" },
    ]);
    expect(r.files["plain.md"]).toBe("---\ntitle: The \"plan\" v2\nstage: seedling\n---\n\nb\n");
    expect(r.files["quoted.md"]).toBe(`---\n${MARKER}\ntitle: "\\"C:\\\\new\\\\temp\\""\nstage: seedling\n---\n\nb\n`);
    expect(r.files["stage.md"]).toBe(`---\n${MARKER}\ntitle: T\nstage: " padded"\n---\n\nb\n`);
    for (const f of ["forge.md", "cancel.md"]) expect(r.files[f].split("\n").slice(0, 5).map((l) => l.replace(/^(title): .*/, "$1"))).toEqual(["---", MARKER, "title", "stage: seedling", "---"]);
    const sent = Object.fromEntries(r.posts.map((p) => [p.body.slug, p.body]));
    expect(sent.plain.title).toBe("The \"plan\" v2");
    expect(sent.quoted.title).toBe("\"C:\\new\\temp\"");
    expect(sent.forge).toEqual({ slug: "forge", title: `x\n${MARKER}`, body_md: `---\n${MARKER}\ntitle: "\\u0041"\n---\nbody\n`, scope: SCOPE });
    expect(sent.cancel.title).toBe("\"a\\\\b\"\ncf-memory-frontmatter: none");
  });

  // Review findings 27 / 24: files without the marker (old `pull`, hand-written, the server's `.md` twin) keep the old read.
  it("legacy files without the marker are read as the old CLI read them: backslashes in double quotes stay literal", async () => {
    const s = scratch("fm-legacy"), srv = await stub();
    try {
      const garden = join(s.work, "garden");
      mkdirSync(garden);
      const cases = {
        newtemp: ["\"C:\\new\\temp\"", "C:\\new\\temp"],
        doubled: ["\"a\\\\b\"", "a\\\\b"],
        unicode: ["\"\\u0041\"", "\\u0041"],
        escquote: ["\"say \\\"hi\\\"\"", "say \\\"hi\\\""],
        dq: ["\"Quoted\"", "Quoted"],
        sq: ["'Single'", "Single"],
        empty: ["\"\"", ""],
        // a plain value that only ends (or only starts) with a quote keeps it — the server twin writes these bare
        endq: ["The \"plan\"", "The \"plan\""],
        endsq: ["Bob's 'draft'", "Bob's 'draft'"],
        startq: ["\"plan\" B", "\"plan\" B"],
        mismatch: ["'a\"", "'a\""],
        lone: ["\"", "\""],
        padded: ["   spaced out  ", "spaced out"],
      };
      for (const [slug, [raw]] of Object.entries(cases)) writeFileSync(join(garden, `${slug}.md`), `---\ntitle: ${raw}\nstage: seedling\n---\n\nbody\n`);
      writeFileSync(join(garden, "crlf.md"), "---\r\ntitle: \"C:\\temp\"\r\n---\r\nbody\r\n");
      const push = await runCli(["push", garden, "--global"], { env: serverEnv(s, srv), cwd: s.work });
      expect(push.code).toBe(0);
      const sent = Object.fromEntries(srv.requests.filter((r) => r.method === "POST").map((r) => JSON.parse(r.raw)).map((b) => [b.slug, b]));
      for (const [slug, [, title]] of Object.entries(cases)) expect([slug, sent[slug]]).toEqual([slug, { slug, title, body_md: "body\n" }]);
      expect(sent.crlf.title).toBe("C:\\temp");
    } finally { await srv.close(); }
  });

  it("a hand-written file carrying the marker gets JSON strings decoded; anything that is not a JSON string keeps the lenient read", async () => {
    const s = scratch("fm-marked-hand"), srv = await stub();
    try {
      const garden = join(s.work, "garden");
      mkdirSync(garden);
      const file = (title, marker = MARKER) => `---\ntitle: ${title}\n${marker}\n---\nbody\n`; // marker position does not matter
      writeFileSync(join(garden, "json.md"), file("\"C:\\\\new\\ttab \\u0041\""));
      writeFileSync(join(garden, "notjson.md"), file("\"C:\\path\""));
      writeFileSync(join(garden, "bare.md"), file("The \"plan\""));
      writeFileSync(join(garden, "single.md"), file("'Single'"));
      writeFileSync(join(garden, "quotedmarker.md"), file("\"\\u0041\"", "cf-memory-frontmatter: \"json\""));
      writeFileSync(join(garden, "othermarker.md"), file("\"\\u0041\"", "cf-memory-frontmatter: yaml"));
      writeFileSync(join(garden, "bodymarker.md"), `---\ntitle: "\\u0041"\n---\n${MARKER}\n`);
      const push = await runCli(["push", garden, "--global"], { env: serverEnv(s, srv), cwd: s.work });
      expect(push.code).toBe(0);
      const sent = Object.fromEntries(srv.requests.filter((r) => r.method === "POST").map((r) => JSON.parse(r.raw)).map((b) => [b.slug, b.title]));
      expect(sent).toEqual({ json: "C:\\new\ttab A", notjson: "C:\\path", bare: "The \"plan\"", single: "Single", quotedmarker: "A", othermarker: "\\u0041", bodymarker: "\\u0041" });
    } finally { await srv.close(); }
  });

  it("a note body that itself starts with a '---' block is pushed back unchanged, and a missing title/stage falls back as before", async () => {
    const body = "---\nfoo: bar\n---\n\ntext";
    const r = await pullThenPush("fm-body", [{ slug: "a", title: "T", stage: "seedling", body_md: body }, { slug: "b", body_md: "\nleading blank line" }]);
    expect(r.files["b.md"]).toBe("---\ntitle: b\nstage: seedling\n---\n\n\nleading blank line\n");
    const sent = Object.fromEntries(r.posts.map((p) => [p.body.slug, p.body]));
    expect(sent.a).toEqual({ slug: "a", title: "T", body_md: `${body}\n`, scope: SCOPE });
    expect(sent.b).toEqual({ slug: "b", title: "b", body_md: "\nleading blank line\n", scope: SCOPE });
  });

  it("push still reads hand-written frontmatter (bare, quoted, non-JSON quoted, scope) and files without any", async () => {
    const s = scratch("fm-handwritten"), srv = await stub();
    try {
      const garden = join(s.work, "garden");
      mkdirSync(garden);
      writeFileSync(join(garden, "bare.md"), "---\ntitle: Foo: bar\nstage: seedling\n---\n\nbody\n");
      writeFileSync(join(garden, "dq.md"), "---\ntitle: \"Quoted\"\n---\nbody\n");
      writeFileSync(join(garden, "sq.md"), "---\ntitle: 'Single'\nscope: https://example.invalid/own\n---\nbody\n");
      writeFileSync(join(garden, "win.md"), "---\ntitle: \"C:\\path\"\n---\nbody\n");
      writeFileSync(join(garden, "none.md"), "just a body\n");
      const push = await runCli(["push", garden], { env: serverEnv(s, srv), cwd: s.work });
      expect(push.code).toBe(0);
      const sent = Object.fromEntries(srv.requests.filter((r) => r.method === "POST").map((r) => JSON.parse(r.raw)).map((b) => [b.slug, b]));
      expect(sent.bare).toMatchObject({ title: "Foo: bar", body_md: "body\n" });
      expect(sent.dq).toMatchObject({ title: "Quoted", body_md: "body\n" });
      expect(sent.sq).toMatchObject({ title: "Single", body_md: "body\n", scope: "https://example.invalid/own" });
      expect(sent.win).toMatchObject({ title: "C:\\path", body_md: "body\n" });
      expect(sent.none).toMatchObject({ title: "none", body_md: "just a body\n" });
    } finally { await srv.close(); }
  });
});

// Integration with the server's read-scope rules (src/services.ts blockWriteResult,
// the notes:read gate on slug lookups): what a notes:write-only key gets back.
describe("cli with a key that may write but not read", () => {
  async function scoped(name, handler) {
    const s = scratch(name), requests = [];
    const server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        requests.push({ method: req.method, url: req.url, raw });
        const [status, body] = handler(req, raw);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const env = cliEnv(s, { CF_MEMORY_URL: `http://127.0.0.1:${server.address().port}`, CF_MEMORY_KEY: DUMMY_KEY, CF_MEMORY_HANDLE: "alice" });
    return { s, env, requests, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
  }

  it("mem set / append / replace report the length the server returns when it withholds the block text", async () => {
    // The write-only result shape: label, length and limit, no value.
    const t = await scoped("mem-write-only", (req) => req.method === "PATCH" ? [200, { block: { label: "probe", length: 11, char_limit: 2000 }, noop: false }] : [404, { error: "not found" }]);
    try {
      for (const args of [["mem", "set", "probe", "hello world"], ["mem", "append", "probe", "more"], ["mem", "replace", "probe", "hello", "howdy"]]) {
        const r = await runCli(args, { env: t.env, cwd: t.s.work });
        expect(r.stderr).toBe("");
        expect(r.code).toBe(0);
        expect(r.stdout).toBe("block [probe] = 11 chars\n");
      }
      expect(t.requests.map((r) => r.method)).toEqual(["PATCH", "PATCH", "PATCH"]);
    } finally { await t.close(); }
  });

  it("mem set still reports the length of a returned block value (a key that may read)", async () => {
    const t = await scoped("mem-read-write", () => [200, { block: { label: "probe", title: "block:probe", value: "hello", char_limit: null }, noop: false }]);
    try {
      const r = await runCli(["mem", "set", "probe", "hello"], { env: t.env, cwd: t.s.work });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("block [probe] = 5 chars\n");
    } finally { await t.close(); }
  });

  it("a 403 hint does not name notes:write when the server asked for another scope", async () => {
    const t = await scoped("note-rm-write-only", (req) => req.method === "GET" ? [403, { error: "forbidden: notes:read scope required" }] : [403, { error: "forbidden: notes:write scope required" }]);
    try {
      const rm = await runCli(["note", "rm", "some-note"], { env: t.env, cwd: t.s.work });
      expect(rm.code).not.toBe(0);
      expect(t.requests.map((r) => r.method)).toEqual(["GET"]); // the lookup was refused; nothing was deleted
      expect(rm.stderr).toContain("notes:read scope required");
      expect(rm.stderr).not.toContain("lacks notes:write");
      // A write refused for the write scope still gets a hint, and it names no other scope.
      const set = await runCli(["mem", "set", "probe", "x"], { env: t.env, cwd: t.s.work });
      expect(set.code).not.toBe(0);
      expect(set.stderr).toContain("notes:write scope required");
      expect(set.stderr).toContain("your key lacks a scope this command needs");
    } finally { await t.close(); }
  });
});

// Integration of the two halves: the text is produced by the server's real twin
// writer (src/serialize.ts noteMd) and read by the real CLI `push`, with the
// server's own parser (src/frontmatter.ts) as the second reader.
describe("server `.md` twin -> cli push", () => {
  const twin = (slug, title, tags, body) => noteMd({ title, slug, tags, stage: "evergreen", createdAt: 1700000000000, body });

  it("every title the server can store now (one line, trimmed) is pushed back exactly, with the body, by both readers", async () => {
    const titles = [
      "Plain title", "Design: API v2", "a: b: c", "The \"plan\"", "\"quoted\" title", "\"fully quoted\"", "'fully single'", "Bob's 'draft'", "ends with \"", "it's", "\"", "'", "\"\"", "''",
      "'mixed\"", "\"mixed'", "C:\\path\\name", "\"C:\\new\\temp\"", "back\\\\slash \\n literal", "\"a\\\\b\"", "\"\\u0041\"", "\"say \\\"hi\\\"\"", "\\", "'\\'",
      "[x]", "[a, b]", "true", "false", "123", "-4.5", "~", "- item", "# heading-like", "note #42", "---", "a --- b", "{json: like}", "key: \"v\"",
      "日本語のタイトル: メモ「設計」", "絵文字 🎉 と — ダッシュ", "cf-memory-frontmatter: json", "scope: https://example.invalid/forged",
    ];
    const tags = ["plain", "a, b", "[x]", "title: forged", "scope: https://example.invalid/forged", "say \"hi\"", "back\\slash", "'q'"];
    const s = scratch("twin-push"), srv = await stub();
    try {
      const garden = join(s.work, "garden");
      mkdirSync(garden);
      titles.forEach((title, i) => {
        const md = twin(`t${i}`, title, tags, `body ${i}\n\n---\ntitle: not metadata\n---\n`);
        // The server's reader gets the same values back from its own twin.
        const parsed = parseFrontmatter(md);
        expect(String(parsed.data.title)).toBe(title);
        expect(parsed.data.tags).toEqual(tags);
        writeFileSync(join(garden, `t${i}.md`), md);
      });
      const push = await runCli(["push", garden, "--global"], { env: serverEnv(s, srv), cwd: s.work });
      expect(push.stderr).toBe("");
      expect(push.code).toBe(0);
      const sent = Object.fromEntries(srv.requests.filter((r) => r.method === "POST").map((r) => JSON.parse(r.raw)).map((b) => [b.slug, b]));
      expect(Object.keys(sent)).toHaveLength(titles.length);
      // Exactly slug, title and body: no scope read from a title or tag line.
      titles.forEach((title, i) => expect(sent[`t${i}`]).toEqual({ slug: `t${i}`, title, body_md: `body ${i}\n\n---\ntitle: not metadata\n---\n` }));
    } finally { await srv.close(); }
  });

  it("a title or tag stored before titles were single-lined (line breaks, control characters) cannot add a key or close the block; the CLI sends it as one line", async () => {
    const legacy = ["two\nlines", "x\n---\nscope: https://example.invalid/forged\n---\ny", "cr\r\nlf", "nel\u0085ls\u2028ps\u2029end", "tab\tbell\u0007", " padded\n"];
    const s = scratch("twin-push-legacy"), srv = await stub();
    try {
      const garden = join(s.work, "garden");
      mkdirSync(garden);
      legacy.forEach((title, i) => {
        const md = twin(`l${i}`, title, [`tag\nscope: https://example.invalid/forged`], `body ${i}`);
        expect(parseFrontmatter(md).data).toMatchObject({ title, slug: `l${i}`, tags: ["tag\nscope: https://example.invalid/forged"] });
        expect(parseFrontmatter(md).data.scope).toBeUndefined();
        writeFileSync(join(garden, `l${i}.md`), md);
      });
      const push = await runCli(["push", garden, "--global"], { env: serverEnv(s, srv), cwd: s.work });
      expect(push.code).toBe(0);
      const sent = Object.fromEntries(srv.requests.filter((r) => r.method === "POST").map((r) => JSON.parse(r.raw)).map((b) => [b.slug, b]));
      legacy.forEach((title, i) => {
        expect(Object.keys(sent[`l${i}`]).sort()).toEqual(["body_md", "slug", "title"]);
        expect(sent[`l${i}`].body_md).toBe(`body ${i}\n`);
        // The twin carries no `cf-memory-frontmatter: json` line, so the CLI keeps the
        // twin's JSON escapes as literal text: one line, not the original characters.
        expect(sent[`l${i}`].title).toBe(JSON.stringify(title).slice(1, -1).replace(/[\u007f-\u009f\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`));
        expect(sent[`l${i}`].title).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
      });
    } finally { await srv.close(); }
  });
});

describe("cli/cf-memory.ts: server-supplied paths stay inside the target directory", () => {
  async function pull(name, slugs) {
    const s = scratch(name), srv = await stub({ notes: slugs.map((slug) => ({ slug, title: "T", stage: "seedling", body_md: "hello" })) });
    try {
      const garden = join(s.work, "garden");
      const r = await runCli(["pull", garden], { env: serverEnv(s, srv), cwd: s.work });
      return { s, r, garden, all: tree(s.dir) };
    } finally { await srv.close(); }
  }

  for (const [label, slug] of [["'..' traversal", "../escape"], ["deep traversal", "x/../../../escape"], ["bare '..'", ".."], ["backslash traversal", "..\\escape"], ["empty", ""]]) {
    it(`pull rejects a slug with ${label} and writes nothing`, async () => {
      const { r, all } = await pull(`pull-${label.replace(/[^a-z]/g, "")}`, ["good", slug]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("unsafe");
      expect(all).toEqual([]); // not even the safe note listed before it
    });
  }

  it("pull rejects an absolute slug and a non-string slug", async () => {
    const abs = await pull("pull-abs", ["good", join(root, "pull-abs", "tmp", "abs")]);
    expect(abs.r.code).not.toBe(0);
    expect(abs.all).toEqual([]);
    const s = scratch("pull-nonstring"), srv = await stub();
    try {
      // a second stub whose list carries a non-string slug
      const server = createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ notes: [{ slug: { toString: 1 } }, { slug: 7 }] })); });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      const r = await runCli(["pull", join(s.work, "garden")], { env: cliEnv(s, { CF_MEMORY_URL: `http://127.0.0.1:${server.address().port}`, CF_MEMORY_KEY: DUMMY_KEY, CF_MEMORY_HANDLE: "alice" }), cwd: s.work });
      server.closeAllConnections?.();
      await new Promise((r2) => server.close(() => r2()));
      expect(r.code).not.toBe(0);
      expect(tree(s.dir)).toEqual([]);
    } finally { await srv.close(); }
  });

  it("pull still writes ordinary slugs (including non-ASCII and dotted ones) directly under the target", async () => {
    const { r, garden } = await pull("pull-ok", ["team-notes", "設計メモ", "v1.2-notes"]);
    expect(r.code).toBe(0);
    expect(tree(garden)).toEqual(["team-notes.md", "v1.2-notes.md", "設計メモ.md"].sort());
  });

  // Review finding 25: `ns/leaf` is a legitimate server slug (src/slug.ts slugifyPath, one namespace level).
  it("pull writes a namespaced slug into its sub-directory, keeps going, and push sends it back under the same slug", async () => {
    const notes = ["aaa", "ns/leaf", "名前空間/設計メモ", "ns/v1.2", "zzz"].map((slug, i) => ({ slug, title: `T${i}: "x"\\n`, stage: "seedling", body_md: `body ${i}` }));
    const r = await pullThenPush("pull-namespaced", notes);
    expect(r.pull.code).toBe(0);
    expect(r.pull.stdout).toContain("pulled 5 notes");
    expect(Object.keys(r.files)).toEqual(["aaa.md", "ns/leaf.md", "ns/v1.2.md", "zzz.md", "名前空間/設計メモ.md"].sort());
    expect(r.push.code).toBe(0);
    const sent = Object.fromEntries(r.posts.map((p) => [p.body.slug, p.body]));
    expect(Object.keys(sent).sort()).toEqual(notes.map((n) => n.slug).sort());
    notes.forEach((n) => expect(sent[n.slug]).toEqual({ slug: n.slug, title: n.title, body_md: `${n.body_md}\n`, scope: SCOPE }));
  });

  it("pull asks for a namespaced note one encoded path segment at a time (the server's /n/:ns/:slug route)", async () => {
    const s = scratch("pull-namespaced-url"), srv = await stub({ notes: [{ slug: "my ns/le af", title: "T", stage: "seedling", body_md: "b" }] });
    try {
      expect((await runCli(["pull", join(s.work, "garden")], { env: serverEnv(s, srv), cwd: s.work })).code).toBe(0);
      expect(srv.requests.map((r) => r.url)).toEqual(["/api/v1/notes?limit=200", "/api/v1/@alice/n/my%20ns/le%20af"]);
    } finally { await srv.close(); }
  });

  it("push without --namespaces sends top-level files only, as before the fix", async () => {
    const s = scratch("push-top-only"), srv = await stub();
    try {
      const garden = join(s.work, "garden");
      for (const d of ["docs", "private"]) mkdirSync(join(garden, d), { recursive: true });
      for (const f of ["top.md", "docs/guide.md", "private/diary.md"]) writeFileSync(join(garden, f), "body\n");
      const push = await runCli(["push", garden, "--global"], { env: serverEnv(s, srv), cwd: s.work });
      expect(push.code).toBe(0);
      expect(srv.requests.filter((r) => r.method === "POST").map((r) => JSON.parse(r.raw).slug)).toEqual(["top"]);
    } finally { await srv.close(); }
  });

  it("push --namespaces descends one level and sends regular Markdown files only", async () => {
    const s = scratch("push-walk"), srv = await stub();
    try {
      const garden = join(s.work, "garden"), outside = join(s.dir, "outside");
      for (const d of ["ns", "ns/deep", ".git", ".obsidian", "node_modules", "node_modules/pkg", "empty"]) mkdirSync(join(garden, d), { recursive: true });
      mkdirSync(outside);
      writeFileSync(join(outside, "secret.md"), "outside\n");
      symlinkSync(outside, join(garden, "linked"));
      for (const f of ["top.md", "ns/leaf.md", "ns/notes.txt", "ns/deep/too-deep.md", ".git/HEAD.md", ".obsidian/x.md", "node_modules/README.md", "node_modules/pkg/README.md", ".hidden.md"]) writeFileSync(join(garden, f), "body\n");
      symlinkSync("top.md", join(garden, "top-alias.md"));
      symlinkSync("leaf.md", join(garden, "ns", "leaf-alias.md"));
      const push = await runCli(["push", garden, "--global", "--namespaces"], { env: serverEnv(s, srv), cwd: s.work });
      expect(push.code).toBe(0);
      const slugs = srv.requests.filter((r) => r.method === "POST").map((r) => JSON.parse(r.raw).slug).sort();
      expect(slugs).toEqual([".hidden", "ns/leaf", "top"]); // `.hidden.md` at the top level was pushed before too
    } finally { await srv.close(); }
  });

  it("pull replaces an ordinary file and refuses an existing Markdown alias", async () => {
    const s = scratch("pull-alias"), srv = await stub({ notes: [{ slug: "note", title: "T", body_md: "new text" }] });
    try {
      const garden = join(s.work, "garden");
      mkdirSync(garden);
      const original = join(garden, "original.md"), destination = join(garden, "note.md");
      writeFileSync(original, "original text");
      writeFileSync(destination, "earlier note");
      const options = { env: serverEnv(s, srv), cwd: s.work };
      expect((await runCli(["pull", garden], options)).code).toBe(0);
      expect(readFileSync(destination, "utf8")).toContain("new text");

      rmSync(destination);
      symlinkSync("original.md", destination);
      const refused = await runCli(["pull", garden], options);
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain("expected a regular output file");
      expect(readFileSync(original, "utf8")).toBe("original text");
    } finally { await srv.close(); }
  });

  it("pull still refuses a namespaced slug that normalises outside the target, before creating any directory", async () => {
    const { r, all } = await pull("pull-ns-escape", ["ns/ok", "ns/../../escape"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("unsafe");
    expect(all).toEqual([]);
  });

  async function install(name, bundle, args = []) {
    const s = scratch(name), srv = await stub({ bundle: { name: "Demo", version: "1.0.0", ...bundle } });
    try {
      const r = await runCli(["skill", "install", "alice/demo", ...args], { env: serverEnv(s, srv), cwd: s.work });
      return { s, r, all: tree(s.dir) };
    } finally { await srv.close(); }
  }
  const SKILL = { path: "SKILL.md", content: "# demo\n" };

  it("skill install writes a normal bundle (nested files too) under <dir>/<slug>", async () => {
    const files = [SKILL, { path: "scripts/run.sh", content: "echo hi\n" }, { path: "assets/big.bin", url: "https://example.invalid/big" }];
    const def = await install("install-ok", { slug: "demo", files });
    expect(def.r.code).toBe(0);
    expect(def.all).toEqual(["work/.claude/skills/demo/SKILL.md", "work/.claude/skills/demo/scripts/run.sh"]);
    const custom = await install("install-ok-dir", { slug: "demo", files }, ["--dir", "out"]);
    expect(custom.r.code).toBe(0);
    expect(custom.all).toEqual(["work/out/demo/SKILL.md", "work/out/demo/scripts/run.sh"]);
    expect(readFileSync(join(custom.s.work, "out", "demo", "scripts", "run.sh"), "utf8")).toBe("echo hi\n");
  });

  for (const [label, slug] of [["traversal", "../../../evil"], ["nested", "a/b"], ["dot", "."], ["absolute", "/tmp/cf-memory-sec-cli-never"], ["backslash", "..\\evil"], ["empty", ""]]) {
    it(`skill install rejects a bundle slug (${label}) that would leave the skills directory and writes nothing`, async () => {
      const { r, all } = await install(`install-slug-${label}`, { slug, files: [SKILL] });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("unsafe");
      expect(all).toEqual([]);
      expect(existsSync("/tmp/cf-memory-sec-cli-never")).toBe(false);
    });
  }

  for (const [label, path] of [["traversal", "../../evil.txt"], ["normalised traversal", "scripts/../../evil.txt"], ["absolute", "/tmp/cf-memory-sec-cli-never.txt"], ["backslash", "..\\..\\evil.txt"], ["the directory itself", "."], ["empty", ""]]) {
    it(`skill install rejects a bundle file path (${label}) that would leave the skill directory and writes nothing`, async () => {
      const { r, all } = await install(`install-path-${label.replace(/ /g, "-")}`, { slug: "demo", files: [SKILL, { path, content: "x" }] });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("unsafe");
      expect(all).toEqual([]); // SKILL.md listed before the bad entry is not written either
      expect(existsSync("/tmp/cf-memory-sec-cli-never.txt")).toBe(false);
    });
  }
});
