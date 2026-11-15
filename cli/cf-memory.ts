#!/usr/bin/env node
// cf-memory CLI — the third door over the same store. Thin wrapper over the REST
// API. Run: `node --experimental-strip-types cli/cf-memory.ts <cmd> …`
import type { Dirent } from "node:fs";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, chmodSync, renameSync, rmSync, statSync, lstatSync, realpathSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

interface Config {
  url: string;
  key: string;
  handle: string;
}

const CONFIG_DIR = join(homedir(), ".cf-memory");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

// An older CLI wrote config.json under the umask (0644 in a 0755 directory) and
// such an install may never run `login` again, so every command that loads the
// config tightens what is already there. Best effort: errors are ignored, and
// nothing is touched while there is no config file.
function tightenConfigModes(): void {
  if (process.platform === "win32") return;
  try {
    const file = statSync(CONFIG_PATH);
    if (!file.isFile()) return;
    if (file.mode & 0o077) chmodSync(CONFIG_PATH, 0o600);
    if (statSync(CONFIG_DIR).mode & 0o077) chmodSync(CONFIG_DIR, 0o700);
  } catch {
    /* no config yet, or not ours to chmod */
  }
}

function loadConfig(): Config {
  tightenConfigModes();
  let file: Partial<Config> = {};
  try {
    file = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>;
  } catch {
    file = {};
  }
  // Env vars override the config file so CF_MEMORY_* always wins (and isn't silently ignored).
  return {
    url: process.env.CF_MEMORY_URL ?? file.url ?? "http://localhost:8787",
    key: process.env.CF_MEMORY_KEY ?? file.key ?? "",
    handle: process.env.CF_MEMORY_HANDLE ?? file.handle ?? "owner",
  };
}

function saveConfig(cfg: Config): void {
  // The file holds the Bearer key: owner-only regardless of umask, like the
  // cf-memory-agent plugin's state under the same directory (0700 dir, 0600 file).
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try {
    chmodSync(CONFIG_DIR, 0o700); // tighten a directory an older CLI created 0755
  } catch {
    /* not ours to chmod — the 0600 file below is what protects the key */
  }
  // Write a fresh 0600 file and rename it over the old one, so an existing
  // over-permissive config.json is replaced rather than rewritten in place.
  // A symlinked config.json (dotfiles manager) is written through: the fresh
  // file replaces the link's target, beside it, and the link itself stays. The
  // target's directory is not ours to chmod.
  let destination = CONFIG_PATH;
  try {
    if (lstatSync(CONFIG_PATH).isSymbolicLink()) {
      try {
        destination = realpathSync(CONFIG_PATH);
      } catch {
        destination = resolve(CONFIG_DIR, readlinkSync(CONFIG_PATH)); // dangling link: create its target
      }
    }
  } catch {
    /* no config.json yet */
  }
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(cfg, null, 2), { mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, destination);
  } catch (e) {
    rmSync(temporary, { force: true });
    // A link target in a directory where no file can be created (read-only
    // dotfiles checkout): write through the link in place, as the CLI always did.
    if (destination === CONFIG_PATH) throw e;
    writeFileSync(destination, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    try {
      chmodSync(destination, 0o600);
    } catch {
      /* not ours to chmod */
    }
  }
}

function parseFlags(args: string[]): { _: string[]; flags: Record<string, string> } {
  const _: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else flags[key] = "true";
    } else _.push(args[i]);
  }
  return { _, flags };
}

// #117 project-scope derivation. The current project = the git origin URL
// (stable across clones/branches/checkouts); falls back to the working directory
// when there's no repo. Sent RAW — the server normalizes it. Never throws (git
// absent / not a repo → cwd).
function resolveScope(): string {
  try {
    const origin = execSync("git remote get-url origin", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    if (origin) return origin;
  } catch {
    /* not a git repo, or git absent — fall through to cwd */
  }
  return process.cwd();
}

// WRITE side: the project scope to STAMP on a note/skill row. `--global` omits it
// (a new row then defaults to 'global' server-side; an edit keeps its scope);
// `--scope <v>` overrides the git-derived default.
function writeScope(flags: Record<string, string>): string | undefined {
  if (flags.global) return undefined;
  if (flags.scope) return flags.scope;
  return resolveScope();
}

// READ side: the current-project CONTEXT that filters results to scope ∈
// {context,'global'}. `--global` omits it (cross-scope query); `--context <v>`
// overrides the git-derived default. (Note: on `search`, `--scope` stays the
// CORPUS notes|skills|all — a distinct axis — so reads use `--context` here.)
function readContext(flags: Record<string, string>): string | undefined {
  if (flags.global) return undefined;
  if (flags.context) return flags.context;
  return resolveScope();
}

async function api(cfg: Config, method: string, path: string, body?: unknown): Promise<any> {
  let res: Response;
  try {
    res = await fetch(cfg.url + path, {
      method,
      headers: { "content-type": "application/json", ...(cfg.key ? { authorization: `Bearer ${cfg.key}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`could not reach ${cfg.url} (${path}): ${e instanceof Error ? e.message : e} — set CF_MEMORY_URL=<url> or run 'login --url <url>' to change the target.`);
  }
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const hint =
      res.status === 401
        ? " — no valid write key; run `login --key <key>`, mint a key, or self-host to write (the hosted instance is read-only for non-owners)."
        : res.status === 403
          ? " — your key lacks a scope this command needs (the error above names it: notes:write to write; commands that look a note up first, such as `note rm`, also need notes:read); use a key with that scope or self-host."
          : "";
    throw new Error(`${res.status} ${path}: ${JSON.stringify(json)}${hint}`);
  }
  return json;
}

// The frontmatter `pull` writes, in one of two forms:
//   - every value bare (`title: Design: API v2`) — the form the old `pull` wrote
//     and the server's `.md` twin uses for plain values;
//   - marked with FM_JSON_MARKER as its first line, when at least one value had
//     to be written as a JSON string to stay on its line and survive the read.
// Only a marked block has its double-quoted values JSON-decoded on `push`. The
// old `pull` wrote titles raw and never wrote the marker, so an unmarked
// `title: "C:\new\temp"` (old pull, or hand-written) keeps its backslashes.
const FM_JSON_KEY = "cf-memory-frontmatter";
const FM_JSON_MARKER = `${FM_JSON_KEY}: json`;

// One frontmatter value on ONE line. Titles and stages come from the server (a
// shared note's title is another member's text), so a value that could add or
// close frontmatter lines — line breaks, control characters — or that the
// lenient read below would alter (edge whitespace, an edge quote, empty) is
// written as a JSON string; everything else stays bare.
function frontmatterValue(value: unknown): { text: string; json: boolean } {
  const v = typeof value === "string" ? value : String(value);
  const bare = v !== "" && v === v.trim() && !/^["']|["']$/.test(v) && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(v);
  if (bare) return { text: v, json: false };
  // JSON.stringify leaves C1 controls and U+2028/U+2029 raw; escape them too so the value stays on its line.
  return { text: JSON.stringify(v).replace(/[\u007f-\u009f\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`), json: true };
}

function frontmatterBlock(fields: Record<string, unknown>): string {
  const values = Object.entries(fields).map(([k, v]) => [k, frontmatterValue(v)] as const);
  const lines = values.map(([k, v]) => `${k}: ${v.text}`);
  if (values.some(([, v]) => v.json)) lines.unshift(FM_JSON_MARKER);
  return `---\n${lines.join("\n")}\n---\n\n`;
}

// The lenient read (hand-written files, the old `pull`, the server's twin):
// surrounding quotes are dropped only when both ends carry the same quote
// character, as the server's own reader does; nothing is unescaped.
function lenientFrontmatterValue(raw: string): string {
  const quoted = raw.length >= 2 && (raw[0] === '"' || raw[0] === "'") && raw[raw.length - 1] === raw[0];
  return quoted ? raw.slice(1, -1) : raw;
}

// Inverse of frontmatterValue inside a marked block: a JSON string is decoded,
// anything else (a bare value, a quoted value that is not JSON) is read leniently.
function parseFrontmatterValue(raw: string, json: boolean): string {
  if (json && raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      const v: unknown = JSON.parse(raw);
      if (typeof v === "string") return v;
    } catch {
      /* not a JSON string (e.g. "C:\path") — fall through to the lenient read */
    }
  }
  return lenientFrontmatterValue(raw);
}

// A server-supplied relative path (note slug, skill slug, bundle file path)
// resolved under `base`, or an error: absolute paths, backslashes, drive
// prefixes and anything that normalises to `base` itself or outside it are
// refused, so a response can only ever write below the directory the user named.
// `flat` additionally requires a direct child (a single path segment).
function confinedPath(base: string, rel: unknown, what: string, flat = false): string {
  const root = resolve(base);
  const unsafe = () => new Error(`unsafe ${what} from server: ${JSON.stringify(rel)} — refusing to write outside ${root}`);
  if (typeof rel !== "string" || !rel || /[\u0000\\]/.test(rel) || isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) throw unsafe();
  const target = resolve(root, rel);
  const within = relative(root, target);
  if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) throw unsafe();
  if (flat && dirname(target) !== root) throw unsafe();
  return target;
}

// Minimal leading `---` frontmatter split, matching the `.md` twin the server
// renders (title/stage). Lets `pull` → `push` round-trip losslessly.
// The JSON marker may sit on any line of the block; it never comes from a value,
// because a value `pull` writes cannot contain a line break.
function splitFrontmatter(md: string): { data: Record<string, string>; body: string } {
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(md);
  if (!m) return { data: {}, body: md };
  const raw: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_.-]+):[ \t]*(.*)$/.exec(line);
    if (kv) raw[kv[1]] = kv[2].trim();
  }
  const json = raw[FM_JSON_KEY] !== undefined && lenientFrontmatterValue(raw[FM_JSON_KEY]) === "json";
  const data: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) data[k] = parseFrontmatterValue(v, json);
  return { data, body: md.slice(m[0].length).replace(/^\r?\n/, "") };
}

// A memory write answers with the block, or — for a key without notes:read —
// with its label, length and limit only (the text is withheld).
function blockLength(block: { value?: string; length?: number }): number | string {
  return block.length ?? block.value?.length ?? "?";
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    if (process.stdin.isTTY) return resolve("");
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
  });
}

async function main() {
  // Two-word verbs take a sub-command; everything else is a one-word verb whose
  // first positional must NOT be swallowed into the dispatch key.
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? "";
  const TWO_WORD = new Set(["note", "mem", "skill", "keys"]);
  const isTwo = TWO_WORD.has(cmd);
  const key = isTwo ? `${cmd} ${argv[1] ?? ""}`.trim() : cmd;
  const { _, flags } = parseFlags(isTwo ? argv.slice(2) : argv.slice(1));
  const cfg = loadConfig();

  switch (key) {
    case "login": {
      if (flags.url) cfg.url = flags.url;
      if (flags.key) cfg.key = flags.key;
      if (flags.handle) cfg.handle = flags.handle;
      saveConfig(cfg);
      console.log(`Saved ${CONFIG_PATH} → ${cfg.url} (@${cfg.handle})`);
      if (cfg.key) {
        // Best-effort: verify the saved key against the target so a dead key at a
        // live URL surfaces now rather than at first write. Non-fatal so offline
        // login still works.
        try {
          const r = await api(cfg, "GET", "/api/v1/whoami");
          if (r.token_status !== "active") console.error(`warning: key not active against ${cfg.url} (token_status=${r.token_status}); reads degrade to anonymous and writes will 401`);
        } catch {
          /* offline: keep login usable without network */
        }
      }
      break;
    }
    case "whoami": {
      const r = await api(cfg, "GET", "/api/v1/whoami");
      console.log(`@${r.handle} (${r.actor}) scopes=[${r.scopes.join(",")}] token=${r.token_status}`);
      if (r.token_status !== "active") console.error(`warning: token not active against ${cfg.url} (token_status=${r.token_status}); reads degrade to anonymous and writes will 401`);
      break;
    }
    case "note new":
    case "note edit": {
      const slug = _[0];
      if (!slug) throw new Error("usage: cf-memory note new <slug> [--title t] [--tags a,b]");
      const body_md = (await readStdin()) || flags.body || "";
      const out = await api(cfg, "POST", "/api/v1/notes", {
        slug,
        title: flags.title ?? slug,
        body_md,
        tags: flags.tags ? flags.tags.split(",").map((t) => t.trim()) : undefined,
        scope: writeScope(flags),
      });
      console.log(`${out.created ? "created" : "updated"} @${cfg.handle}/n/${out.slug}`);
      break;
    }
    case "note rm": {
      const slug = _[0];
      if (!slug) throw new Error("usage: cf-memory note rm <slug>");
      // Resolve slug → id (DELETE is by id), then soft-delete.
      const note = await api(cfg, "GET", `/api/v1/@${cfg.handle}/n/${encodeURIComponent(slug)}`);
      const r = await api(cfg, "DELETE", `/api/v1/notes/${note.id}`);
      console.log(r.deleted ? `deleted ${slug}` : `no change (already deleted or not found): ${slug}`);
      break;
    }
    case "note get":
    case "note cat": {
      const slug = _[0];
      const note = await api(cfg, "GET", `/api/v1/@${cfg.handle}/n/${encodeURIComponent(slug)}`);
      console.log(note.body_md ?? JSON.stringify(note));
      break;
    }
    case "note ls": {
      const r = await api(cfg, "GET", `/api/v1/notes?limit=${flags.limit ?? "50"}${flags.tag ? `&tag=${flags.tag}` : ""}`);
      for (const n of r.notes) console.log(`${n.slug}\t${n.title}`);
      if (!r.notes.length) console.error("(no visible notes)");
      break;
    }
    case "search": {
      const q = _.join(" ");
      const mode = flags.semantic ? "semantic" : flags.keyword ? "keyword" : "hybrid";
      const scope = flags.scope ?? "all"; // corpus: notes|skills|all (distinct from project context)
      const context = readContext(flags); // #117 project scope filter (auto git origin; --global/--context override)
      const ctxParam = context ? `&context=${encodeURIComponent(context)}` : "";
      const r = await api(cfg, "GET", `/api/v1/search?q=${encodeURIComponent(q)}&mode=${mode}&scope=${scope}${ctxParam}`);
      for (const h of r.hits) console.log(`${h.score.toFixed(3)}\t[${h.type}|${h.via.join(",")}]\t${h.slug}\t${h.title}`);
      if (!r.hits.length) console.error("(no matches)");
      break;
    }
    case "recall": {
      const q = _.join(" ");
      const r = await api(cfg, "POST", "/api/v1/recall", { query: q, budget: flags.budget ? Number(flags.budget) : undefined, context: readContext(flags) });
      console.log(r.text);
      console.error(`\n[${r.used}/${r.budget} tokens, ${r.included.length} items, ${r.truncated} truncated]`);
      break;
    }
    case "links": {
      const slug = _[0];
      const note = await api(cfg, "GET", `/api/v1/@${cfg.handle}/n/${encodeURIComponent(slug)}`);
      const links = await api(cfg, "GET", `/api/v1/notes/${note.id}/links`);
      const back = await api(cfg, "GET", `/api/v1/notes/${note.id}/backlinks`);
      console.log("→ outgoing:");
      for (const l of links.links) console.log(`   ${l.resolved ? "•" : "○"} ${l.target_slug}`);
      console.log("← backlinks:");
      for (const b of back.backlinks) console.log(`   • ${b.slug}  ${b.title}`);
      break;
    }
    case "mem ls": {
      const r = await api(cfg, "GET", "/api/v1/memory/blocks");
      for (const b of r.blocks) console.log(`[${b.label}] (${b.value.length}${b.char_limit ? "/" + b.char_limit : ""})\n${b.value}\n`);
      if (!r.blocks.length) console.error("(no memory blocks — owner key required to read core memory)");
      break;
    }
    case "mem set":
    case "mem append": {
      const label = _[0];
      const value = _.slice(1).join(" ") || (await readStdin());
      const op = key === "mem append" ? "append" : "set";
      const r = await api(cfg, "PATCH", `/api/v1/memory/blocks/${encodeURIComponent(label)}`, { op, value, char_limit: flags.limit ? Number(flags.limit) : undefined });
      console.log(`block [${label}] = ${blockLength(r.block)} chars`);
      break;
    }
    case "mem replace": {
      const label = _[0];
      const find = _[1];
      const replace = _[2];
      if (!label || find === undefined || replace === undefined) throw new Error("usage: cf-memory mem replace <label> <find> <replace>");
      // memory_replace parity: value=replacement, replace=find target (no match = no-op).
      const r = await api(cfg, "PATCH", `/api/v1/memory/blocks/${encodeURIComponent(label)}`, { op: "replace", value: replace, replace: find });
      console.log(`block [${label}] = ${blockLength(r.block)} chars`);
      break;
    }
    case "skill new":
    case "skill edit": {
      const slug = _[0];
      if (!slug) throw new Error("usage: cf-memory skill new <slug> --desc <d> [--name n]  (instructions from stdin)");
      const instructions = (await readStdin()) || flags.instructions || "";
      const out = await api(cfg, "POST", "/api/v1/skills", { slug, name: flags.name ?? slug, description: flags.desc ?? "", instructions, scope: writeScope(flags) });
      console.log(`${out.created ? "created" : "updated"} skill @${cfg.handle}/skills/${out.slug} v${out.version}`);
      break;
    }
    case "skill ls": {
      const r = await api(cfg, "GET", "/api/v1/skills");
      for (const s of r.skills) console.log(`${s.slug}\tv${s.version}\t${s.name} — ${s.description}`);
      break;
    }
    case "skill rm": {
      const slug = _[0];
      if (!slug) throw new Error("usage: cf-memory skill rm <slug>");
      const r = await api(cfg, "DELETE", `/api/v1/skills/${encodeURIComponent(slug)}`);
      console.log(r.deleted ? `deleted ${slug}` : `no change (already deleted or not found): ${slug}`);
      break;
    }
    case "skill get":
    case "skill cat": {
      const s = await api(cfg, "GET", `/api/v1/@${cfg.handle}/skills/${encodeURIComponent(_[0])}`);
      console.log(s.skill_md ?? JSON.stringify(s));
      break;
    }
    case "skill install": {
      const ref = _[0] ?? "";
      let h = cfg.handle;
      let slug = ref;
      if (ref.includes("/")) {
        const i = ref.indexOf("/");
        h = ref.slice(0, i).replace(/^@/, "");
        slug = ref.slice(i + 1);
      }
      const r = await api(cfg, "GET", `/api/v1/@${h}/skills/${encodeURIComponent(slug)}/install`);
      // The bundle's slug and file paths are the server's (and the skill author's)
      // text: resolve every one inside the skills dir BEFORE writing anything.
      const dir = confinedPath(flags.dir ?? join(".claude", "skills"), r.bundle.slug, "skill slug", true);
      const targets: string[] = r.bundle.files.map((f: { path: unknown }) => confinedPath(dir, f.path, "bundle file path"));
      mkdirSync(dir, { recursive: true });
      let skipped = 0;
      r.bundle.files.forEach((f: { content?: unknown }, i: number) => {
        if (typeof f.content !== "string") return void skipped++; // url-only entry (large/binary bundle file): CLI fetch-materialization is a deferred follow-up
        mkdirSync(dirname(targets[i]), { recursive: true }); // f.path may include scripts/ references/ assets/ subdirs
        writeFileSync(targets[i], f.content);
      });
      console.log(`installed ${r.bundle.name} v${r.bundle.version} → ${dir}/${skipped ? ` (${skipped} large/binary file(s) not materialized — fetch each via its url)` : ""}`);
      break;
    }
    case "skill push": {
      const file = _[0];
      if (!file) throw new Error("usage: cf-memory skill push <path-to-SKILL.md> [--slug s]");
      const skill_md = readFileSync(file, "utf8");
      const out = await api(cfg, "POST", "/api/v1/skills", { slug: flags.slug, skill_md, scope: writeScope(flags) });
      console.log(`pushed skill ${out.slug} v${out.version}`);
      break;
    }
    case "audit": {
      const r = await api(cfg, "GET", `/api/v1/audit?limit=${flags.limit ?? "100"}`);
      for (const e of r.events) console.log(`${new Date(e.created_at).toISOString()}\t${e.actor}${e.actor_ref ? `:${e.actor_ref}` : ""}\t${e.verb}\t${e.target_kind}/${e.target_id}\t${e.summary ?? ""}`);
      if (!r.events.length) console.error("(no events — admin key required)");
      break;
    }
    case "push": {
      const dir = _[0] ?? ".";
      // Top-level `<dir>/<leaf>.md` only, as before. `--namespaces` also sends one
      // namespace level, `<dir>/<ns>/<leaf>.md` (what `pull` writes for an ns/leaf
      // slug): opt-in, because a directory's sub-folders are often not notes at all.
      // Dot-directories, node_modules, symlinked directories and anything deeper are
      // never descended into; a sub-folder that cannot be listed is skipped.
      const files: string[] = [];
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory()) {
          if (e.name.endsWith(".md")) files.push(e.name);
        } else if (flags.namespaces && !e.name.startsWith(".") && e.name !== "node_modules") {
          let leaves: Dirent[];
          try {
            leaves = readdirSync(join(dir, e.name), { withFileTypes: true });
          } catch {
            console.error(`skipped ${e.name}/ (cannot be listed)`);
            continue;
          }
          for (const leaf of leaves) {
            if (!leaf.isDirectory() && leaf.name.endsWith(".md")) files.push(`${e.name}/${leaf.name}`);
          }
        }
      }
      for (const f of files) {
        const slug = f.replace(/\.md$/, "");
        const { data, body } = splitFrontmatter(readFileSync(join(dir, f), "utf8"));
        // #117: `--global` omits scope; else `--scope`, then any frontmatter `scope:`, then git-derived.
        const scope = flags.global ? undefined : flags.scope ?? data.scope ?? resolveScope();
        await api(cfg, "POST", "/api/v1/notes", { slug, title: data.title ?? slug, body_md: body, scope });
        console.log(`pushed ${slug}`);
      }
      break;
    }
    case "pull": {
      const dir = _[0] ?? "garden";
      mkdirSync(dir, { recursive: true });
      const r = await api(cfg, "GET", "/api/v1/notes?limit=200");
      // Slugs are the server's text: refuse the whole listing before writing if any would land outside `dir`.
      const targets: string[] = r.notes.map((n: { slug: unknown }) => `${confinedPath(dir, n.slug, "note slug")}.md`);
      for (const [i, n] of r.notes.entries()) {
        // A namespaced slug (`ns/leaf`) is requested segment by segment, the shape of the server's /n/:ns/:slug route.
        const note = await api(cfg, "GET", `/api/v1/@${cfg.handle}/n/${String(n.slug).split("/").map(encodeURIComponent).join("/")}`);
        // Mirror the server's `.md` twin frontmatter so a later `push` round-trips
        // title instead of resetting it to slug.
        const fm = frontmatterBlock({ title: note.title ?? n.slug, stage: note.stage ?? "seedling" });
        mkdirSync(dirname(targets[i]), { recursive: true }); // `ns/leaf` → <dir>/ns/ (the target is already confined to <dir>)
        writeFileSync(targets[i], `${fm}${note.body_md ?? ""}\n`);
      }
      console.log(`pulled ${r.notes.length} notes → ${dir}/`);
      break;
    }
    default:
      console.log(`cf-memory — one substrate, two doors  (run: node --experimental-strip-types cli/cf-memory.ts <cmd>)
usage:
  cf-memory login --url <u> --key <k> --handle <h>
  cf-memory whoami                         show identity + scopes + token status
  cf-memory note new <slug> [--title t] [--tags a,b] [--scope s|--global]   (body from stdin)
  cf-memory note get <slug>
  cf-memory note rm <slug>
  cf-memory note ls [--tag t] [--limit n]
  cf-memory search <query> [--semantic|--keyword] [--scope notes|skills|all] [--context c|--global]
  cf-memory recall <query> [--budget n] [--context c|--global]
  cf-memory links <slug>
  cf-memory mem ls | mem set <label> <value> | mem append <label> <value> | mem replace <label> <find> <replace>
  cf-memory skill new <slug> --desc <d> [--scope s|--global]    (instructions from stdin)
  cf-memory skill ls | skill get <slug> | skill push <SKILL.md> | skill rm <slug>
  cf-memory skill install <handle>/<slug> [--dir .claude/skills]
  cf-memory audit [--limit n]              owner-only who/when/what log (admin)
  cf-memory push [dir] [--namespaces] | pull [dir]`);
  }
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.message : e));
  process.exit(1);
});
