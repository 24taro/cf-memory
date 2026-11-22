// SkillsRepo: SKILL.md skills as portable procedural memory, in the same
// substrate as notes. A skill is its frontmatter (name + description) for
// discovery, plus instructions for activation. Bundle files (R2) are phase-2b.

import {
  BundleQuotaError,
  BundlesUnconfiguredError,
  encodeBundlePath,
  INLINE_CONTENT_MAX_BYTES,
  isInlineTextType,
  MAX_BUNDLE_FILE_COUNT,
  MAX_BUNDLE_TOTAL_BYTES,
  sanitizeUploadContentType,
  validateBundlePath,
} from "./bundle";
import { normalizeScope } from "./context";
import { clampLimit, now, sha256hex, sha256hexBytes, ulid } from "./db";
import { composeSkillMd, parseFrontmatter } from "./frontmatter";
import { StaleUpsertError } from "./notes";
import { slugify } from "./slug";
import type { Principal } from "./types";

// Fixed commit epoch so a skill's git commit SHA depends ONLY on content
// (skill_md + name + bundle bytes), keeping info/refs and the served pack
// consistent across metadata-only touches. Matches the historical route literal.
const GIT_EPOCH = 1700000000;
import { isReadable, readableSql } from "./visibility";

/** Every skills column except the legacy embedding pair (never read since
 * 2026-10-31; phase 5 drops the columns). */
export const SKILL_COLUMNS = ['id', 'user_id', 'slug', 'name', 'description', 'instructions_md', 'skill_md', 'frontmatter_json',
  'version', 'parent_skill_id', 'content_hash', 'usage_count', 'created_at', 'updated_at', 'deleted_at', 'last_used_at',
  'scope', 'success_rate', 'invocation_count', 'shared'].join(', ');

export interface SkillRow {
  id: string;
  user_id: string;
  slug: string;
  name: string;
  description: string;
  instructions_md: string;
  skill_md: string;
  frontmatter_json: string;
  version: string;
  scope: string; // #117 per-project relevance axis (NOT NULL DEFAULT 'global')
  parent_skill_id: string | null;
  content_hash: string;
  usage_count: number;
  last_used_at: number | null;
  // T5 skill-outcome memory (0024). success_rate = AVG outcome value over
  // skill_invocations (success=1, partial=.5, failure=0); NULL until first log.
  // invocation_count = total logged outcomes (distinct from usage_count = installs).
  success_rate: number | null;
  invocation_count: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface SkillSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  version: string;
  usage_count: number;
  last_used_at: number | null;
  success_rate: number | null;
  invocation_count: number;
  updated_at: number;
}

/** Result of resolving a skill's fork parent under a viewer's visibility (issue
 * #65). Three cases the detail page must distinguish:
 *  - "none":   parent_skill_id was null — this skill was not forked.
 *  - "hidden": there IS a parent id, but the parent row is missing, soft-deleted,
 *              or private-to-someone-else — surface a muted 非公開 note, NEVER the
 *              parent's slug/name/handle.
 *  - "ok":     the parent is readable by this viewer — safe to render a link. */
export type ParentLineage = { status: "none" } | { status: "hidden" } | { status: "ok"; skill: SkillRow };

export interface SkillInput {
  /** Refuse updates/resurrection, including after concurrent insert retry. */
  createOnly?: boolean;
  frontmatter?: Record<string, unknown>;
  slug?: string;
  name?: string;
  description?: string;
  instructions?: string;
  skill_md?: string;
  version?: string;
  /** #117 project scope. Omitted on a NEW skill → 'global'; omitted on an EDIT →
   * the existing row's scope is preserved. */
  scope?: string;
}

export interface SkillBundle {
  name: string;
  description: string;
  version: string;
  slug: string;
  // SKILL.md is always inline `content`; bundle files are inline `content` (small
  // text) OR a same-origin proxied `url` (large/binary). Never a presigned R2 URL.
  files: Array<{ path: string; content?: string; url?: string; content_type?: string; size?: number; sha256?: string }>;
}

/** A row in the skill_files manifest (bundle-file metadata; the bytes live in R2). */
export interface SkillFileRow {
  id: string;
  skill_id: string;
  path: string;
  r2_key: string;
  content_type: string | null;
  size: number | null;
  sha256: string | null;
  created_at: number;
  updated_at: number;
}

const OTHER_BUNDLE_FILES = "SELECT COUNT(*) AS count, COALESCE(SUM(size),0) AS bytes FROM skill_files WHERE skill_id=? AND path<>?";
const BUNDLE_PUBLISH_WINDOW_MS = 15 * 60_000;
const BUNDLE_SWEEP_GRACE_MS = 24 * 60 * 60_000;
const BUNDLE_SWEEP_PAGE_SIZE = 100;
const BUNDLE_SWEEP_PAGES = 5;
const BUNDLE_SWEEP_CURSOR = "skill_bundle_sweep_cursor";

function managedBundleKey(key: string): boolean {
  const match = /^skills\/[0-9A-HJKMNP-TV-Z]{26}\/(?:(?:imports\/[a-f0-9]{64}|objects\/[0-9A-HJKMNP-TV-Z]{26})\/)?(.+)$/.exec(key);
  return match !== null && validateBundlePath(match[1]) === match[1];
}

function bumpPatch(v: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : v;
}

export class SkillsRepo {
  constructor(
    private db: D1Database,
    // R2 bucket for bundle-file bytes. null in phase-1 dev / R2-unconfigured envs;
    // every file method degrades (throws BundlesUnconfiguredError) rather than 500.
    private bundles: R2Bucket | null = null,
  ) {}

  getBySlug(userId: string, slug: string): Promise<SkillRow | null> {
    return this.db.prepare(`SELECT ${SKILL_COLUMNS} FROM skills WHERE user_id=? AND slug=?`).bind(userId, slug).first<SkillRow>();
  }

  getById(id: string): Promise<SkillRow | null> {
    return this.db.prepare(`SELECT ${SKILL_COLUMNS} FROM skills WHERE id=?`).bind(id).first<SkillRow>();
  }

  /** Record a deliberate USE of a skill (issue #95). The "use" signal is INSTALL
   * — materializing the bundle into an agent via MCP `skills_install` or the REST
   * `/skills/:slug/install` door — NOT a plain get/view/SKILL.md fetch. Bumps
   * usage_count and stamps last_used_at; deliberately does NOT touch updated_at (a
   * use is not an edit, so it must not reorder the updated_at-sorted list nor bump
   * the version mtime). Keyed by id with no ownership check because the caller has
   * already resolved a readable skill row (isReadable gate upstream). */
  async recordUse(skillId: string): Promise<void> {
    await this.db.prepare("UPDATE skills SET usage_count = usage_count + 1, last_used_at = ? WHERE id = ?").bind(now(), skillId).run();
  }

  /** T5 skill-outcome memory (decision-10-adjacent). Record whether an invocation
   * of a skill actually WORKED, so discovery can surface "what worked last time".
   * Agent-declared (the server never infers success — mirrors the anti-curator
   * stance). Inserts one skill_invocations row, then recomputes the denormalized
   * success_rate + invocation_count on the skill (outcome value: success=1,
   * partial=0.5, failure=0). Owner-scoped: only the skill's owner may log. Returns
   * the fresh {success_rate, invocation_count} (null skill → null). Does NOT bump
   * updated_at or usage_count (a logged outcome is neither an edit nor an install). */
  async logUse(principal: Principal, skillId: string, outcome: "success" | "partial" | "failure", note?: string): Promise<{ success_rate: number | null; invocation_count: number } | null> {
    const skill = await this.getById(skillId);
    if (!skill || skill.user_id !== principal.userId || skill.deleted_at) return null;
    const ts = now();
    await this.db
      .prepare("INSERT INTO skill_invocations (id, skill_id, user_id, outcome, note, created_at) VALUES (?,?,?,?,?,?)")
      .bind(ulid(ts), skill.id, principal.userId, outcome, note?.trim() ? note.trim() : null, ts)
      .run();
    // Recompute from the source of truth (self-heals if a row is ever removed).
    await this.db
      .prepare(
        `UPDATE skills SET
           invocation_count = (SELECT COUNT(*) FROM skill_invocations WHERE skill_id = ?1),
           success_rate     = (SELECT AVG(CASE outcome WHEN 'success' THEN 1.0 WHEN 'partial' THEN 0.5 ELSE 0.0 END)
                               FROM skill_invocations WHERE skill_id = ?1)
         WHERE id = ?1`,
      )
      .bind(skill.id)
      .run();
    const fresh = await this.db.prepare("SELECT success_rate, invocation_count FROM skills WHERE id = ?").bind(skill.id).first<{ success_rate: number | null; invocation_count: number }>();
    return { success_rate: fresh?.success_rate ?? null, invocation_count: fresh?.invocation_count ?? 0 };
  }

  async upsert(principal: Principal, input: SkillInput, creationProvenance?: (id: string, shared: boolean) => Promise<D1PreparedStatement[]>): Promise<{ skill: SkillRow; created: boolean }> {
    if (creationProvenance && !input.createOnly) throw new Error("creation provenance requires create_only");
    const userId = principal.userId;

    // Identity is NOT independent of the live row. skills_put is legitimately
    // called with a PARTIAL payload (it declares no required fields — e.g. a
    // scope-only re-scope, `{slug, scope}`), and defaulting each omitted field to
    // "" silently blanked name/description/instructions on an edit. There is no
    // skill_revisions table, so that loss is unrecoverable — prod already lost the
    // body of the `cf-memory-operations` skill this way. Omitted fields therefore
    // PRESERVE the existing row, exactly as `scope` already does below.
    // Only the SLUG is resolvable from the input alone (it is the identity key used
    // to read that row); the rest is resolved inside the loop against `existing`.
    let mdName: string | undefined;
    let mdDescription: string | undefined;
    let mdBody: string | undefined;
    if (input.skill_md) {
      const { data, body } = parseFrontmatter(input.skill_md);
      if (data.name !== undefined) mdName = String(data.name).trim();
      if (data.description !== undefined) mdDescription = String(data.description).trim();
      mdBody = body;
    }
    const slug = slugify(input.slug ?? mdName ?? input.name ?? "");

    // Mirror notes.upsert: under concurrent same-slug writes the loser collides on
    // either INSERT skills (UNIQUE user_id,slug) or the UPDATE CAS, both before the
    // FTS/event writes, so a bounded jittered retry converges. A concurrent CREATE
    // of the same NEW slug becomes idempotent (loser re-reads the winner's row and
    // UPDATEs); concurrent UPDATEs each re-read the fresh version and bump it.
    const MAX_ATTEMPTS = 12;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const ts = now();
        const existing = await this.getBySlug(userId, slug);
        if (input.createOnly && existing) throw new Error('skill already exists; create-only conflict');
        const id = existing?.id ?? ulid(ts);
        const created = !existing;
        const version = input.version ?? (existing ? bumpPatch(existing.version) : "0.1.0");
        // #117: explicit scope normalized+stamped; omitted on a NEW skill → 'global',
        // on an EDIT → preserve the existing row's scope (a scope-less fork/edit
        // never resets it).
        const scope = input.scope !== undefined ? normalizeScope(input.scope) : (existing?.scope ?? "global");
        // Omitted content fields preserve the existing row (see the note above); an
        // explicitly-passed value (including "") is respected as a deliberate edit.
        const name = (mdName ?? input.name?.trim() ?? existing?.name ?? "") || slug;
        const description = mdDescription ?? input.description?.trim() ?? existing?.description ?? "";
        const instructions = input.createOnly && input.instructions !== undefined ? input.instructions : mdBody ?? input.instructions ?? existing?.instructions_md ?? "";
        const skillMd = input.skill_md ?? composeSkillMd(name, description, instructions);
        const frontmatter = JSON.stringify({ ...(existing ? JSON.parse(existing.frontmatter_json) : {}), ...(input.frontmatter ?? {}), name, description });
        const contentHash = await sha256hex(`${name}\n${description}\n${instructions}`);

        if (existing) {
          // Optimistic concurrency: only update if the row still carries the hash we
          // read; a concurrent writer that already moved it -> changes===0 -> retry.
          // deleted_at=NULL unconditionally (issue #36, mirrors notes.upsert):
          // getBySlug() doesn't filter deleted_at, so a soft-deleted skill's slug
          // is still "claimed" -- upserting it again is meant to resurrect it, not
          // leave it soft-deleted-but-updated (which would still be invisible to
          // isReadable()).
          const result = await this.db
            .prepare(
              `UPDATE skills SET name=?, description=?, instructions_md=?, skill_md=?, frontmatter_json=?,
                 version=?, scope=?, content_hash=?, updated_at=?, deleted_at=NULL WHERE id=? AND content_hash=?`,
            )
            .bind(name, description, instructions, skillMd, frontmatter, version, scope, contentHash, ts, id, existing.content_hash)
            .run();
          if (result.meta.changes === 0) throw new StaleUpsertError();
        } else {
          const insert = this.db
            .prepare(
              `INSERT INTO skills (id,user_id,slug,name,description,instructions_md,skill_md,frontmatter_json,
                 version,scope,parent_skill_id,content_hash,usage_count,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`,
            )
            .bind(id, userId, slug, name, description, instructions, skillMd, frontmatter, version, scope, null, contentHash, ts, ts);
          if (creationProvenance) await this.db.batch([insert, ...await creationProvenance(id, false)]);
          else await insert.run();
        }

        const rowidRow = await this.db.prepare("SELECT rowid AS rowid FROM skills WHERE id=?").bind(id).first<{ rowid: number }>();
        if (rowidRow?.rowid != null) {
          await this.db.prepare("DELETE FROM skills_fts WHERE rowid=?").bind(rowidRow.rowid).run();
          await this.db.prepare("INSERT INTO skills_fts (rowid,name,description,instructions) VALUES (?,?,?,?)").bind(rowidRow.rowid, name, description, instructions).run();
        }

        await this.db
          .prepare(
            `INSERT INTO events (id,user_id,actor,actor_ref,verb,target_kind,target_id,reason,summary,payload_json,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .bind(ulid(), userId, principal.actor, principal.viaKeyPrefix ?? principal.handle, created ? "skill.created" : "skill.updated", "skill", id, null, name, "{}", ts)
          .run();

        return { skill: (await this.getById(id)) as SkillRow, created };
      } catch (err) {
        if (attempt < MAX_ATTEMPTS - 1 && (err instanceof StaleUpsertError || /SQLITE_CONSTRAINT|constraint failed/i.test(String(err)))) {
          // Jittered backoff so concurrent same-slug writers don't retry in lockstep.
          await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 20 * (attempt + 1))));
          continue;
        }
        throw err;
      }
    }
    throw new Error("skills.upsert: unreachable");
  }

  /** Soft-delete (issue #36), mirroring notes.softDelete: drops the skill from
   * search/listing but retains the row (retrievable only via a direct getById
   * that a caller already holds, same visibility rules as everything else --
   * isReadable() rejects any deleted_at row). A child skill's parent_skill_id
   * is left UNCHANGED when its parent is deleted -- it's a pure lineage record
   * (fork() copies the parent's content at fork time; nothing about a child's
   * own content/behavior depends on the parent row still existing), so this
   * intentionally does NOT cascade. */
  async softDelete(principal: Principal, id: string): Promise<boolean> {
    const skill = await this.getById(id);
    if (!skill || skill.user_id !== principal.userId || skill.deleted_at) return false;
    const ts = now();
    await this.db.prepare("UPDATE skills SET deleted_at=?, updated_at=? WHERE id=?").bind(ts, ts, id).run();
    const rowidRow = await this.db.prepare("SELECT rowid AS rowid FROM skills WHERE id=?").bind(id).first<{ rowid: number }>();
    if (rowidRow?.rowid != null) await this.db.prepare("DELETE FROM skills_fts WHERE rowid=?").bind(rowidRow.rowid).run();
    await this.db
      .prepare(
        `INSERT INTO events (id,user_id,actor,actor_ref,verb,target_kind,target_id,reason,summary,payload_json,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(ulid(), principal.userId, principal.actor, principal.viaKeyPrefix ?? principal.handle, "skill.deleted", "skill", id, null, skill.name, "{}", ts)
      .run();
    return true;
  }

  async list(principal: Principal, opts: { ownerId: string; limit?: number }): Promise<SkillSummary[]> {
    const limit = clampLimit(opts.limit, 50);
    // 2026-08-22: user_id を二重に束縛していた。スキルには共有の書き込み経路が
    // 無いので今は結果が変わらないが、述語を手書きしている限り、共有を足した
    // ときに静かにずれる。読める範囲の定義は1つに保つ。
    const vis = readableSql("", principal);
    const res = await this.db
      .prepare(
        `SELECT id, slug, name, description, version, usage_count, last_used_at, success_rate, invocation_count, updated_at
         FROM skills WHERE user_id=? AND deleted_at IS NULL AND ${vis.sql}
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .bind(opts.ownerId, ...vis.args, limit)
      .all<SkillSummary>();
    return res.results ?? [];
  }

  /** Fork a skill into the caller's space, recording lineage via parent_skill_id. */
  async fork(principal: Principal, source: SkillRow, newSlug?: string): Promise<{ skill: SkillRow; created: boolean }> {
    const slug = slugify(newSlug ?? `${source.slug}-fork`);
    const res = await this.upsert(principal, { slug, skill_md: source.skill_md });
    await this.db.prepare("UPDATE skills SET parent_skill_id=? WHERE id=?").bind(source.id, res.skill.id).run();
    return { skill: ((await this.getById(res.skill.id)) as SkillRow), created: res.created };
  }

  /** Resolve a skill's fork parent for the given viewer (issue #65). Centralized
   * + unit-testable so the isReadable() gate can never regress into a raw-SQL leak
   * in the route: getById() returns the parent regardless of visibility/deletion,
   * so we MUST pass it through isReadable() before any of its data (slug/name/owner)
   * is allowed to escape this method. Returns a tagged union the route renders:
   * "none" (not a fork), "hidden" (parent missing/deleted/not-readable), or "ok". */
  async parentOf(skill: SkillRow, principal: Principal): Promise<ParentLineage> {
    if (!skill.parent_skill_id) return { status: "none" };
    const parent = await this.getById(skill.parent_skill_id);
    if (!parent || !isReadable(parent, principal)) return { status: "hidden" };
    return { status: "ok", skill: parent };
  }

  /** Reverse fork lookup (issue #65): skills whose parent_skill_id == skillId,
   * filtered to only those readable by this viewer. Soft-deleted children are
   * excluded in SQL; the isReadable() filter additionally drops other users'
   * private children so their slug/name/owner never reach the page. Returns the
   * readable child rows (possibly empty — the route omits the section then). */
  async childrenOf(skillId: string, principal: Principal): Promise<SkillRow[]> {
    // Bound the rendered fork list like the sibling listing methods (list() uses
    // clampLimit(50)); a skill with a very large fork fan-out shouldn't render
    // unboundedly. 50 readable-or-not rows is plenty for the reverse-lookup card.
    const res = await this.db
      .prepare(`SELECT ${SKILL_COLUMNS} FROM skills WHERE parent_skill_id=? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 50`)
      .bind(skillId)
      .all<SkillRow>();
    return (res.results ?? []).filter((r) => isReadable(r, principal));
  }

  // ── Bundle files (phase 2b): bytes in R2, one manifest row per live path ──────
  // Soft-deleting a skill retains its manifest and bytes for restore. Forks
  // start with a new skill ID and no bundle files.

  private async checkBundleQuota(skillId: string, path: string, size: number): Promise<void> {
    const usage = await this.db.prepare(OTHER_BUNDLE_FILES).bind(skillId, path).first<{ count: number; bytes: number }>();
    if ((usage?.count ?? 0) >= MAX_BUNDLE_FILE_COUNT) throw new BundleQuotaError("count");
    if ((usage?.bytes ?? 0) + size > MAX_BUNDLE_TOTAL_BYTES) throw new BundleQuotaError("total");
  }

  private async removeBundleObject(key: string): Promise<void> {
    try {
      await this.bundles!.delete(key);
    } catch {
      // The manifest already stopped referring to this immutable key. The
      // scheduled scan retries deletion if this request cannot finish it.
      console.warn("[bundles] object cleanup deferred");
    }
  }

  /** Publish an owned bundle file at an already-validated path. Each upload
   * has an immutable R2 key, so concurrent writers never overwrite live bytes. */
  async putFile(principal: Principal, skill: SkillRow, path: string, bytes: Uint8Array, clientContentType: string | null, createOnly = false): Promise<SkillFileRow> {
    if (!this.bundles) throw new BundlesUnconfiguredError();
    if (skill.user_id !== principal.userId || skill.deleted_at) throw new Error("putFile requires an owned, non-deleted skill"); // defense; route already 404s
    const existing = await this.db.prepare("SELECT * FROM skill_files WHERE skill_id=? AND path=?").bind(skill.id, path).first<SkillFileRow>();
    const sha = await sha256hexBytes(bytes);
    const contentType = sanitizeUploadContentType(clientContentType);
    const verifiedExisting = async (row: SkillFileRow): Promise<SkillFileRow> => {
      if (row.sha256 !== sha || row.content_type !== contentType) throw new StaleUpsertError();
      const object = await this.bundles!.get(row.r2_key);
      if (!object || object.size !== bytes.byteLength || await sha256hexBytes(new Uint8Array(await object.arrayBuffer())) !== sha) throw new StaleUpsertError();
      return row;
    };
    if (createOnly && existing) {
      const live = await this.getById(skill.id);
      if (!live || live.user_id !== principal.userId || live.deleted_at) throw new StaleUpsertError();
      return verifiedExisting(existing);
    }
    await this.checkBundleQuota(skill.id, path, bytes.byteLength);
    const uploadStartedAt = now();
    const r2Key = `skills/${skill.id}/objects/${ulid(uploadStartedAt)}/${path}`;
    await this.bundles.put(r2Key, bytes, { httpMetadata: { contentType } });
    const ts = now();
    // Read the old pointer and publish in the same D1 transaction. If the
    // transaction's result is unknown, the sweep uses the committed manifest
    // to decide what to delete. Only a recent upload can publish a new key.
    const conflict = createOnly ? "DO NOTHING" : `DO UPDATE SET r2_key=excluded.r2_key,
      content_type=excluded.content_type, size=excluded.size, sha256=excluded.sha256, updated_at=excluded.updated_at`;
    const [previous, published] = await this.db.batch<SkillFileRow>([
      this.db.prepare("SELECT * FROM skill_files WHERE skill_id=? AND path=?").bind(skill.id, path),
      this.db.prepare(`INSERT INTO skill_files (id,skill_id,path,r2_key,content_type,size,sha256,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM skills WHERE id=? AND user_id=? AND deleted_at IS NULL)
        AND unixepoch() * 1000 < ?
        AND EXISTS (SELECT 1 FROM (${OTHER_BUNDLE_FILES}) AS other WHERE count < ? AND bytes + ? <= ?)
        ON CONFLICT(skill_id,path) ${conflict} RETURNING *`)
        .bind(ulid(ts), skill.id, path, r2Key, contentType, bytes.byteLength, sha, ts, ts,
          skill.id, principal.userId, uploadStartedAt + BUNDLE_PUBLISH_WINDOW_MS,
          skill.id, path, MAX_BUNDLE_FILE_COUNT, bytes.byteLength, MAX_BUNDLE_TOTAL_BYTES),
    ]);
    const old = previous.results[0];
    const written = published.results[0];
    if (!written) {
      await this.removeBundleObject(r2Key);
      const live = await this.getById(skill.id);
      if (!live || live.user_id !== principal.userId || live.deleted_at) throw new StaleUpsertError();
      if (createOnly && old) return verifiedExisting(old);
      await this.checkBundleQuota(skill.id, path, bytes.byteLength);
      throw new StaleUpsertError();
    }
    if (old) await this.removeBundleObject(old.r2_key);
    await this.fileEvent(principal, old ? "skill.file.updated" : "skill.file.added", skill.id, path, bytes.byteLength);
    return written;
  }

  /** Read one bundle file's bytes + manifest row. Authz-free like getById — the
   * caller runs isReadable() on the skill first. Null if no manifest row OR the R2
   * object is missing (manifest/object drift → 404). */
  async getFile(skillId: string, path: string): Promise<{ row: SkillFileRow; bytes: Uint8Array } | null> {
    if (!this.bundles) throw new BundlesUnconfiguredError();
    const row = await this.db.prepare("SELECT * FROM skill_files WHERE skill_id=? AND path=?").bind(skillId, path).first<SkillFileRow>();
    if (!row) return null;
    const obj = await this.bundles.get(row.r2_key);
    if (!obj) return null;
    return { row, bytes: new Uint8Array(await obj.arrayBuffer()) };
  }

  /** Manifest row only (pure D1, no R2 read) — lets a caller check size/type
   * before deciding whether to fetch the bytes (avoids a wasted large read). */
  getFileRow(skillId: string, path: string): Promise<SkillFileRow | null> {
    return this.db.prepare("SELECT * FROM skill_files WHERE skill_id=? AND path=?").bind(skillId, path).first<SkillFileRow>();
  }

  /** Whether bundle-file operations are available (the R2 BUNDLES binding is set). */
  bundlesEnabled(): boolean {
    return this.bundles != null;
  }


  /** Manifest read (pure D1, works when R2 is unbound): backs the file listing in
   * skills_get / REST skill GET / bundle(). */
  async listFiles(skillId: string): Promise<SkillFileRow[]> {
    const res = await this.db.prepare("SELECT * FROM skill_files WHERE skill_id=? ORDER BY path").bind(skillId).all<SkillFileRow>();
    return res.results ?? [];
  }

  /** The owning user's handle, for building same-origin file URLs (the file lives
   * at /@<ownerHandle>/skills/<slug>/files/<path>, NOT the caller's handle). */
  async ownerHandle(userId: string): Promise<string> {
    const r = await this.db.prepare("SELECT handle FROM users WHERE id=?").bind(userId).first<{ handle: string }>();
    return r?.handle ?? "";
  }

  /** Delete one bundle file (owner-only; the route pre-checks). Removes BOTH the R2
   * object and the manifest row. False if the path has no row. */
  async deleteFile(principal: Principal, skill: SkillRow, path: string): Promise<boolean> {
    if (!this.bundles) throw new BundlesUnconfiguredError();
    if (skill.user_id !== principal.userId || skill.deleted_at) return false; // defense; the route already 404s a non-owned/deleted skill
    const row = await this.db.prepare(`DELETE FROM skill_files WHERE skill_id=? AND path=?
      AND EXISTS (SELECT 1 FROM skills WHERE id=? AND user_id=? AND deleted_at IS NULL) RETURNING r2_key,size`)
      .bind(skill.id, path, skill.id, principal.userId).first<{ r2_key: string; size: number | null }>();
    if (!row) return false;
    await this.removeBundleObject(row.r2_key);
    await this.fileEvent(principal, "skill.file.deleted", skill.id, path, row.size ?? 0);
    return true;
  }

  /** Recover objects left by older releases, failed writes or interrupted
   * cleanup. A young object may still be waiting for its D1 transaction. */
  async sweepBundleFiles(timestamp = now()): Promise<number> {
    if (!this.bundles) return 0;
    const checkpoint = await this.db.prepare("SELECT value FROM meta WHERE key=?")
      .bind(BUNDLE_SWEEP_CURSOR).first<{ value: string }>();
    let cursor = checkpoint?.value || undefined;
    let removed = 0;
    for (let i = 0; i < BUNDLE_SWEEP_PAGES; i++) {
      const page = await this.bundles.list({ prefix: "skills/", limit: BUNDLE_SWEEP_PAGE_SIZE, cursor });
      const keys = page.objects.filter(({ key, uploaded }) =>
        uploaded.getTime() <= timestamp - BUNDLE_SWEEP_GRACE_MS && managedBundleKey(key)).map(({ key }) => key);
      if (keys.length) {
        const { results } = await this.db.prepare(`SELECT r2_key FROM skill_files WHERE r2_key IN (${keys.map(() => "?").join(",")})`)
          .bind(...keys).all<{ r2_key: string }>();
        const referenced = new Set(results.map(({ r2_key }) => r2_key));
        const orphans = keys.filter(key => !referenced.has(key));
        if (orphans.length) {
          await this.bundles.delete(orphans);
          removed += orphans.length;
        }
      }
      cursor = page.truncated ? page.cursor : undefined;
      if (!cursor) break;
    }
    await this.db.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)")
      .bind(BUNDLE_SWEEP_CURSOR, cursor ?? "").run();
    return removed;
  }

  private async fileEvent(principal: Principal, verb: string, skillId: string, path: string, size: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO events (id,user_id,actor,actor_ref,verb,target_kind,target_id,reason,summary,payload_json,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(ulid(), principal.userId, principal.actor, principal.viaKeyPrefix ?? principal.handle, verb, "skill", skillId, null, path, JSON.stringify({ path, size }), now())
      .run();
  }

  /** A portable, agentskills.io-compatible bundle: SKILL.md inline (D1) + any
   * bundle files (R2). Small text files inline as `content`; larger/binary files
   * become same-origin app-proxied URLs (which re-run the visibility gate — NEVER
   * a presigned/public R2 URL). With R2 unbound, listFiles() is empty, so this
   * returns exactly the phase-2a {files:[SKILL.md]} shape (back-compat). */
  async bundle(skill: SkillRow): Promise<SkillBundle> {
    const files: SkillBundle["files"] = [{ path: "SKILL.md", content: skill.skill_md, content_type: "text/markdown" }];
    const handle = await this.ownerHandle(skill.user_id);
    for (const row of await this.listFiles(skill.id)) {
      const base = { path: row.path, content_type: row.content_type ?? undefined, size: row.size ?? undefined, sha256: row.sha256 ?? undefined };
      const url = `/@${handle}/skills/${skill.slug}/files/${encodeBundlePath(row.path)}`;
      if (this.bundles && (row.size ?? 0) <= INLINE_CONTENT_MAX_BYTES && isInlineTextType(row.content_type)) {
        const obj = await this.bundles.get(row.r2_key); // read R2 directly — row already has r2_key (no redundant D1 re-SELECT via getFile)
        files.push(obj ? { ...base, content: new TextDecoder().decode(await obj.arrayBuffer()) } : { ...base, url });
      } else {
        files.push({ ...base, url });
      }
    }
    return { name: skill.name, description: skill.description, version: skill.version, slug: skill.slug, files };
  }
}
