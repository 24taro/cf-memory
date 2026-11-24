import type { FC } from "hono/jsx";
import { Layout } from "./layout";
import type { NoteSummary, SearchHit } from "../types";
import type { OutgoingLink } from "../notes";
import type { BlockView } from "../services";
import type { SkillSummary } from "../skills";
import type { RecallSection } from "./recall-sections";
import type { SearchFilters } from "../search";

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
function fmtDateTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

const STAGE_TEXT: Record<string, string> = { seedling: "書きかけ", budding: "成長中", evergreen: "定着" };
// Redesign: growth stage as a small colored dot (seedling=gray, budding=olive,
// evergreen=teal) + a short text label.
const STAGE_DOT: Record<string, string> = { seedling: "d-seed", budding: "d-bud", evergreen: "d-ever" };
function stageDot(stage?: string): string {
  return STAGE_DOT[stage ?? ""] ?? "d-seed";
}
function stageText(stage?: string): string {
  return STAGE_TEXT[stage ?? ""] ?? stage ?? "";
}
// Shows the note's project scope only when it is a real per-project scope
// (a plain 'global' note carries no meaningful scope pill).
function hasScopePill(scope?: string): boolean {
  return !!scope && scope !== "global";
}

// Inline magnifier for the search fields (self-contained SVG, no external asset).
const SearchIcon: FC = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </svg>
);

// Search target scope (issue #71): the /search route already accepts ?scope=.
const SCOPE_LABEL: Record<string, string> = { all: "すべて", notes: "ノートのみ", skills: "スキルのみ" };

// Change-log op/verb badge (note.created/note.updated/note.deleted and the
// upsert-derived create/replace/delete op field both funnel through here).
const OP_LABEL: Record<string, string> = { create: "作成", created: "作成", update: "更新", updated: "更新", replace: "更新", delete: "削除", deleted: "削除" };
function opLabel(op: string): string {
  return OP_LABEL[op] ?? op;
}

// Activity op-log (issue #93). Friendly actor attribution across the 4 actor
// kinds / 3 actor_ref shapes. PURE + exported so it's unit-testable in
// isolation from the render path (see test/activity-page.test.ts). actorRef is
// written as `principal.viaKeyPrefix ?? principal.handle`, so for a human it is
// the @handle (inline), for an agent it is an api_key PREFIX (resolved to the
// key NAME via a caller-scoped LEFT JOIN → passed here as keyName; falls back to
// the prefix if the key was deleted), and for a curator it is null.
export function actorAttribution(actor: string, actorRef: string | null, keyName: string | null): { icon: string; label: string } {
  switch (actor) {
    case "human":
      return { icon: "👤", label: `@${actorRef ?? "?"}` };
    case "agent":
      return { icon: "🤖", label: keyName ?? actorRef ?? "エージェント" };
    case "curator":
      return { icon: "🔧", label: "自動（キュレーター）" };
    case "import":
      return { icon: "📥", label: "取り込み" };
    default:
      return { icon: "•", label: actor };
  }
}

// Activity verb badge. note.* verbs reuse opLabel (作成/更新/削除); the rest map
// through a small table of the common op-log verbs, falling back to the raw verb
// so an unmapped/future verb still renders (just untranslated).
const VERB_LABEL: Record<string, string> = {
  "link.added": "リンク追加",
  "link.removed": "リンク削除",
  "skill.created": "スキル作成",
  "skill.updated": "スキル更新",
  "skill.deleted": "スキル削除",
  "skill.forked": "スキルをフォーク",
  "block.set": "基本記憶を更新",
  "block.append": "基本記憶を更新",
  "block.replace": "基本記憶を更新",
  "session.created": "会話ログ",
  "session.resolved": "会話ログ",
};
function verbLabel(verb: string): string {
  if (verb.startsWith("note.")) return opLabel(verb.replace("note.", ""));
  return VERB_LABEL[verb] ?? verb;
}

// One activity row as returned by GET /activity's LEFT JOIN query (key_name is
// the resolved api_key name for agent rows, null otherwise / when the key was
// deleted). Nullable columns mirror the events schema (migrations/0001_init.sql).
export type ActivityRow = {
  actor: string;
  actor_ref: string | null;
  verb: string;
  target_kind: string;
  target_id: string;
  summary: string | null;
  created_at: number;
  key_name: string | null;
};

// Search-hit result-kind badge (SearchHit.type).
const HIT_TYPE_LABEL: Record<string, string> = { note: "ノート", skill: "スキル" };
function hitTypeLabel(t: string): string {
  return HIT_TYPE_LABEL[t] ?? t;
}

export const HomePage: FC<{ handle: string; sessionHandle?: string; changes: Array<{ verb: string; created_at: number; title: string; slug: string | null }> }> = (p) => (
  <Layout title="home" handle={p.handle} sessionHandle={p.sessionHandle}>
    <h1>
      cf-<span style="color:var(--accent)">memory</span>
    </h1>
    <p class="sub">あなたと、あなたの AI エージェントが共有する記憶。読み・探し・整えるための場所です。</p>
    <form class="searchwrap" action="/search" method="get">
      <SearchIcon />
      <input name="q" placeholder="記憶を検索 …" aria-label="記憶を検索" autocomplete="off" />
    </form>
    <p class="modehint">
      <b>キーワード</b>で探します（日本語対応）。短い言葉をスペースで区切ると見つかりやすくなります。
    </p>
    <h2>最近の更新</h2>
    <ul class="list rlist">
      {p.changes.length === 0 ? <li class="muted">まだノートがありません。</li> : null}
      {p.changes.map((c) => (
        <li>
          <span class="dot d-seed" />
          <div class="li-main">
            {c.slug ? <a href={`/@${p.handle}/n/${c.slug}`}>{c.title}</a> : <span>{c.title}</span>}
            <div class="li-meta">{opLabel(c.verb.replace("note.", ""))}</div>
          </div>
          <div class="li-when">{fmtDate(c.created_at)}</div>
        </li>
      ))}
    </ul>
  </Layout>
);

// The owner's real HOME (decision 9: an authenticated owner hitting `/` is
// redirected here). Composes the approved home: a search field, 最近の更新 (recent
// notes with stage dots + scope), a コアブロック glance (owner-gated core memory),
// and browse chips into the rest of the garden. When `tag` is set (the
// /@handle/tags/:tag route) it degrades to a simple tag-filtered note listing.
export const ProfilePage: FC<{
  handle: string;
  sessionHandle?: string;
  bioHtml: string;
  notes: NoteSummary[];
  blocks?: BlockView[];
  tag?: string;
}> = (p) => {
  if (p.tag) {
    return (
      <Layout title={`#${p.tag}`} handle={p.handle} sessionHandle={p.sessionHandle}>
        <h1>＃{p.tag}</h1>
        <p class="sub">このタグのついたノートです。</p>
        <ul class="list rlist">
          {p.notes.length === 0 ? <li class="muted">このタグのノートはまだありません。</li> : null}
          {p.notes.map((n) => (
            <li>
              <span class={`dot ${stageDot(n.stage)}`} title={stageText(n.stage)} />
              <div class="li-main">
                <a href={`/@${p.handle}/n/${n.slug}`}>{n.title}</a>
                {hasScopePill(n.scope) ? <span class="tag scope">{n.scope}</span> : null}
              </div>
              <div class="li-when">{fmtDate(n.updated_at)}</div>
            </li>
          ))}
        </ul>
      </Layout>
    );
  }
  return (
    <Layout title={`@${p.handle}`} handle={p.handle} sessionHandle={p.sessionHandle}>
      <h1>@{p.handle}</h1>
      {p.bioHtml ? (
        <div class="prose" dangerouslySetInnerHTML={{ __html: p.bioHtml }} />
      ) : (
        <p class="sub">あなたと、あなたの AI エージェントが共有する記憶。読み・探し・整えるための場所です。</p>
      )}
      <form class="searchwrap" action="/search" method="get">
        <SearchIcon />
        <input name="q" placeholder="記憶を検索 …" aria-label="記憶を検索" autocomplete="off" />
      </form>
      <p class="modehint">
        キーワードで探します（日本語対応）。スコープを付けた記憶は検索で絞り込めます。
      </p>

      <h2>最近の更新</h2>
      <ul class="list rlist">
        {p.notes.length === 0 ? <li class="muted">まだノートがありません。</li> : null}
        {p.notes.slice(0, 12).map((n) => (
          <li>
            <span class={`dot ${stageDot(n.stage)}`} title={stageText(n.stage)} />
            <div class="li-main">
              <a href={`/@${p.handle}/n/${n.slug}`}>{n.title}</a>
              {hasScopePill(n.scope) ? <span class="tag scope">{n.scope}</span> : null}
            </div>
            <div class="li-when">{fmtDate(n.updated_at)}</div>
          </li>
        ))}
      </ul>
      <div class="legend">
        <span><span class="dot d-ever" /> 定着</span>
        <span><span class="dot d-bud" /> 成長中</span>
        <span><span class="dot d-seed" /> 書きかけ</span>
      </div>

      {p.blocks && p.blocks.length > 0 ? (
        <>
          <h2>常に読まれる記憶（コアブロック）</h2>
          <div class="cards">
            {p.blocks.slice(0, 4).map((b) => (
              <div class="card">
                <span class="k">{b.label}</span>
                <div class="v">{b.value.length > 160 ? `${b.value.slice(0, 160)}…` : b.value}</div>
              </div>
            ))}
          </div>
        </>
      ) : null}

      <h2>ブラウズ</h2>
      <div class="chips">
        <a class="chip" href={`/@${p.handle}/skills`}>スキル</a>
        <a class="chip" href={`/@${p.handle}/ranking`}>よく使われている</a>
        <a class="chip" href={`/@${p.handle}/changes`}>更新履歴</a>
        <a class="chip" href={`/@${p.handle}/network`}>つながり</a>
      </div>
    </Layout>
  );
};

// issue #89: dedicated skills-listing screen (the スキル nav item points here).
export const SkillsListPage: FC<{ handle: string; sessionHandle?: string; skills: SkillSummary[] }> = (p) => {
  return (
    <Layout title="スキル" handle={p.handle} sessionHandle={p.sessionHandle}>
      <h1>スキル</h1>
      <p class="meta">AIエージェントが使える手順書（スキル）の一覧です。</p>
      <ul class="list">
        {p.skills.length === 0 ? <li class="muted">まだスキルがありません。</li> : null}
        {p.skills.map((s) => (
          <li>
            <a href={`/@${p.handle}/skills/${s.slug}`}>{s.name}</a> <span class="pill">v{s.version}</span>
            <br />
            <span class="muted">{s.description}</span>
          </li>
        ))}
      </ul>
    </Layout>
  );
};

// issue #54: edit/fork/delete buttons. `isOwner` mirrors the sessionHandle===handle
// convention already used for owner-only gating elsewhere (e.g. Issue #53's
// curator page) -- it's a browser-session-only notion of ownership,
// not a scope check, so a Bearer-authenticated agent never sees these buttons
// even when it IS the owner (consistent with how the codebase already treats
// this distinction).
// issue #65: fork lineage props. `parent` is a readable parent's link target;
// `parentPrivate` distinguishes "parent exists but not readable" (muted note,
// never leaking the parent's slug/name/handle) from "no parent" (both falsy).
// `forks` are the readable derived (child) skills (each already owner-handle-
// resolved + isReadable-filtered upstream in the route/service — the component
// only renders). NOT named `children`: hono/jsx reserves that prop for nested
// JSX content and would swallow an explicit `children={...}` attribute.
export const SkillPage: FC<{
  handle: string;
  sessionHandle?: string;
  slug: string;
  name: string;
  description: string;
  version: string;
  bodyHtml: string;
  isOwner: boolean;
  parent?: { handle: string; slug: string; name: string } | null;
  parentPrivate?: boolean;
  forks?: Array<{ handle: string; slug: string; name: string }>;
  usageCount: number;
  provenanceUrl?: string;
  lastUsedAt?: number | null;
}> = (p) => (
  <Layout title={p.name} handle={p.handle} sessionHandle={p.sessionHandle}>
    <h1>{p.name} <span class="pill">skill</span></h1>
    <div class="meta">
      <span class="pill">v{p.version}</span> · <a href={`/@${p.handle}/skills/${p.slug}/SKILL.md`}>raw SKILL.md</a>
      {p.isOwner ? <span> · <a href={`/@${p.handle}/skills/${p.slug}/edit`}>✎ 編集する</a></span> : null}
    </div>
    <div class="meta muted">
      利用回数 {p.usageCount}回{p.lastUsedAt != null ? <> · 最終利用 {fmtDate(p.lastUsedAt)}</> : null}
    </div>
    {p.parent ? (
      <p class="meta">🔀 <a href={`/@${p.parent.handle}/skills/${p.parent.slug}`}>{p.parent.name}</a>からフォーク</p>
    ) : p.parentPrivate ? (
      <p class="meta muted">🔀 フォーク元は非公開です</p>
    ) : null}
    <p class="meta">{p.description}</p>
    {p.provenanceUrl ? <p><a href={p.provenanceUrl}>保存根拠 / provenance</a></p> : null}
    <div class="prose" dangerouslySetInnerHTML={{ __html: p.bodyHtml }} />
    <p>
      <form method="post" action={`/@${p.handle}/skills/${p.slug}/fork`} style="display:inline">
        <button type="submit">🔀 フォークする</button>
      </form>
    </p>
    <p class="muted">他の人のスキルを、自分用に編集できる形でコピーします</p>
    {p.isOwner ? (
      <details class="disclosure">
        <summary>🗑 削除する</summary>
        <p class="muted">本当に削除しますか？この操作は取り消せません。</p>
        <form method="post" action={`/@${p.handle}/skills/${p.slug}/delete`}>
          <button type="submit" style="background:var(--stub);border-color:var(--stub)">本当に削除しますか？</button>
        </form>
      </details>
    ) : null}
    <div class="backlinks">
      <h3>使い方</h3>
      <p class="muted">以下のコマンドをコピーして、AIエージェントに貼り付けてください。このスキルが使えるようになります。</p>
      <pre>cf-memory skill install {p.handle}/{p.slug} --dir .claude/skills</pre>
      <details class="disclosure">
        <summary>開発者向け：ターミナルでも使えます</summary>
        <p class="muted">上記と同じコマンドは、お使いのターミナルで直接実行することもできます。</p>
      </details>
    </div>
    {p.forks && p.forks.length > 0 ? (
      <div class="backlinks">
        <h3>このスキルをフォークした派生スキル</h3>
        <ul class="list">
          {p.forks.map((child) => (
            <li>
              <a href={`/@${child.handle}/skills/${child.slug}`}>{child.name}</a> <span class="muted">@{child.handle}</span>
            </li>
          ))}
        </ul>
      </div>
    ) : null}
  </Layout>
);

// issue #54: owner-only skill edit form, mirroring EditPage's (notes) layout
// conventions exactly (class="cols"/"full", <select> + visLabel()). Deliberately
// does NOT expose version or raw skill_md frontmatter -- out of scope per the issue.
export const SkillEditPage: FC<{ handle: string; sessionHandle?: string; slug: string; name: string; description: string; instructions: string; version: string }> = (p) => (
  <Layout title={`edit ${p.slug}`} handle={p.handle} sessionHandle={p.sessionHandle}>
    <h1>『{p.name}』を編集中</h1>
    <form method="post" action={`/@${p.handle}/skills/${p.slug}/edit`} class="cols">
      <input class="full" name="name" placeholder="名前" value={p.name} />
      <input class="full" name="description" placeholder="説明" value={p.description} />
      {/* Optional: blank submit keeps the auto-patch-bump (existing behavior);
          a filled value sets that exact version. */}
      <input class="full" name="version" placeholder={`バージョン（現在 v${p.version}・空欄で自動採番）`} value="" />
      {/* A browser drops one line break right after the textarea tag; emit one so
          that it is ours and not the first line break of the stored text. */}
      <textarea name="instructions" placeholder="スキルの手順をここに書いてください。">{"\n"}{p.instructions}</textarea>
      <div><button type="submit">保存</button> <a class="muted" href={`/@${p.handle}/skills/${p.slug}`}>キャンセル</a></div>
    </form>
  </Layout>
);

export const RankingPage: FC<{ handle: string; sessionHandle?: string; rows: Array<{ slug: string; title: string; inlinks: number; views: number; score: number }> }> = (p) => (
  <Layout title="ranking" handle={p.handle} sessionHandle={p.sessionHandle}>
    <h1>よく使われている</h1>
    <p class="meta">見られた回数とリンクされた数をもとに並べたランキングです。</p>
    <ul class="list">
      {p.rows.length === 0 ? <li class="muted">まだ何も表示するものがありません。</li> : null}
      {p.rows.map((r, i) => (
        <li>
          <span class="t">#{i + 1} · スコア {r.score}</span>
          <br />
          <a href={`/@${p.handle}/n/${r.slug}`}>{r.title}</a> <span class="muted">（被リンク{r.inlinks}件・閲覧{r.views}回）</span>
        </li>
      ))}
    </ul>
  </Layout>
);

export const ChangesPage: FC<{ handle: string; sessionHandle?: string; changes: Array<{ created_at: number; title: string; slug: string | null; op: string; hash: string }> }> = (p) => (
  <Layout title="changes" handle={p.handle} sessionHandle={p.sessionHandle}>
    <h1>更新履歴</h1>
    <p class="meta">
      変更内容を記録した履歴です。 <a href={`/@${p.handle}/changes.md`}>.md</a> · <a href={`/@${p.handle}/feed.xml`}>feed</a>
    </p>
    <ul class="list">
      {p.changes.length === 0 ? <li class="muted">まだ変更はありません。</li> : null}
      {p.changes.map((c) => (
        <li>
          <span class="t">
            {fmtDateTime(c.created_at)} · <span class="pill">{opLabel(c.op)}</span> {c.hash ? <code>{c.hash}</code> : null}
          </span>
          <br />
          {c.slug ? <a href={`/@${p.handle}/n/${c.slug}`}>{c.title}</a> : <span>{c.title}</span>}
        </li>
      ))}
    </ul>
  </Layout>
);

// 活動ログ (issue #93): admin-only render of the caller's own events op-log with
// friendly actor attribution. summary is rendered as a plain JSX text child
// (auto-escaped) — no dangerouslySetInnerHTML.
export const ActivityPage: FC<{ handle?: string; sessionHandle?: string; events: ActivityRow[] }> = (p) => (
  <Layout title="activity" handle={p.handle} sessionHandle={p.sessionHandle}>
    <h1>活動ログ</h1>
    <p class="meta">あなたのアカウントで起きた操作の記録です（人・AIエージェント・自動整理）。</p>
    <ul class="list">
      {p.events.length === 0 ? <li class="muted">まだ活動がありません。</li> : null}
      {p.events.map((e) => {
        const a = actorAttribution(e.actor, e.actor_ref, e.key_name);
        return (
          <li>
            {a.icon} {a.label} <span class="pill">{verbLabel(e.verb)}</span>
            {e.summary ? <span> {e.summary}</span> : null}
            <br />
            <span class="t">{fmtDateTime(e.created_at)}</span>
          </li>
        );
      })}
    </ul>
  </Layout>
);

export const NotePage: FC<{
  provenanceUrl?: string;
  handle: string;
  sessionHandle?: string;
  slug: string;
  title: string;
  stage: string;
  scope?: string;
  updatedAt: number;
  tags: string[];
  bodyHtml: string;
  backlinks: NoteSummary[];
  outgoing: OutgoingLink[];
  canEdit: boolean;
}> = (p) => (
  <Layout title={p.title} handle={p.handle} sessionHandle={p.sessionHandle}>
    <div class="nhead">
      <h1>{p.title}</h1>
      <div class="meta-row">
        <span class="pill" title="育成ステージ">
          <span class={`dot ${stageDot(p.stage)}`} />
          {stageText(p.stage)}
        </span>
        {hasScopePill(p.scope) ? <span class="pill scope">scope: {p.scope}</span> : null}
        {p.tags.map((t) => (
          <a class="tag" href={`/@${p.handle}/tags/${t}`}>#{t}</a>
        ))}
        <span class="li-when mono">
          更新 {fmtDate(p.updatedAt)} · <a href={`/@${p.handle}/n/${p.slug}.md`}>.md</a>
        </span>
      </div>
    </div>
    <div class="prose" dangerouslySetInnerHTML={{ __html: p.bodyHtml }} />
    {p.provenanceUrl ? <p><a href={p.provenanceUrl}>保存根拠 / provenance</a></p> : null}

    {p.backlinks.length > 0 || p.outgoing.length > 0 ? (
      <div class="mesh">
        <div>
          <h3>被リンク（{p.backlinks.length}）</h3>
          <ul>
            {p.backlinks.length === 0 ? <li class="muted">まだありません。</li> : null}
            {p.backlinks.map((b) => (
              <li><a href={`/@${p.handle}/n/${b.slug}`}>{b.title}</a></li>
            ))}
          </ul>
        </div>
        <div>
          <h3>発リンク・未執筆</h3>
          <ul>
            {p.outgoing.length === 0 ? <li class="muted">まだありません。</li> : null}
            {p.outgoing.map((l) =>
              l.resolved ? (
                <li><a href={`/@${p.handle}/n/${l.target_slug}`}>{l.target_title ?? l.target_slug}</a></li>
              ) : (
                <li>
                  <a class="wikilink stub" href={`/@${p.handle}/n/${l.target_slug}`}>{l.target_slug}</a>{" "}
                  <span class="li-meta" style="display:inline">← 未執筆</span>
                </li>
              ),
            )}
          </ul>
        </div>
      </div>
    ) : null}

    <div class="nact">
      {p.canEdit ? <a class="btn p" href={`/@${p.handle}/n/${p.slug}/edit`}>編集する</a> : null}
      <a class="btn" href={`/@${p.handle}/n/${p.slug}.md`}>.md を見る</a>
    </div>
  </Layout>
);

export const MissingNotePage: FC<{ handle: string; sessionHandle?: string; slug: string; backlinks: NoteSummary[]; canEdit: boolean }> = (p) => (
  <Layout title={p.slug} handle={p.handle} sessionHandle={p.sessionHandle}>
    <h1 class="muted">{p.slug}</h1>
    <p class="meta">このノートはまだ書かれていません。</p>
    {p.canEdit ? <p><a href={`/@${p.handle}/n/${p.slug}/edit`}>✍ 書く</a></p> : null}
    {p.backlinks.length > 0 ? (
      <div class="backlinks">
        <h3>← {p.backlinks.length}件のノートからリンクされています</h3>
        <ul class="list">
          {p.backlinks.map((b) => (
            <li><a href={`/@${p.handle}/n/${b.slug}`}>{b.title}</a></li>
          ))}
        </ul>
      </div>
    ) : null}
  </Layout>
);

export const EditPage: FC<{ handle: string; sessionHandle?: string; slug: string; title: string; body: string; tags: string[]; isNew: boolean }> = (p) => (
  <Layout title={`edit ${p.slug}`} handle={p.handle} sessionHandle={p.sessionHandle}>
    <h1>{p.isNew ? "新しいノート" : `『${p.slug}』を編集中`}</h1>
    <form method="post" action={`/@${p.handle}/n/${p.slug}/edit`} class="cols">
      <input class="full" name="title" placeholder="タイトル" value={p.title} />
      <input class="full" name="tags" placeholder="タグ（カンマ区切り）" value={p.tags.join(", ")} />
      {/* A browser drops one line break right after the textarea tag; emit one so
          that it is ours and the stored body comes back exactly as stored. */}
      <textarea name="body_md" placeholder="ここに書いてください。[[ノート名]]と書くと他のノートにつながります。">{"\n"}{p.body}</textarea>
      <div><button type="submit">保存</button> <a class="muted" href={`/@${p.handle}/n/${p.slug}`}>キャンセル</a></div>
    </form>
  </Layout>
);

export const SearchPage: FC<{ handle: string; sessionHandle?: string; q: string; scope: string; scopes: string[]; context: string | null; filters?: SearchFilters; hits: SearchHit[] }> = (p) => {
  const filters = p.filters ?? {};
  return (
  <Layout title={p.q ? `検索: ${p.q}` : "検索"} handle={p.handle} sessionHandle={p.sessionHandle}>
    <h1>検索</h1>
    <form action="/search" method="get">
      <div class="searchwrap" style="margin-top:1rem">
        <SearchIcon />
        <input name="q" value={p.q} placeholder="記憶を検索 …" aria-label="記憶を検索" autocomplete="off" />
      </div>
      <div style="margin-top:.8rem;display:flex;gap:.7rem;align-items:center;flex-wrap:wrap">
        <div class="seg">
          <select name="scope" aria-label="対象">
            {(["all", "notes", "skills"]).map((s) => (
              <option value={s} selected={s === p.scope}>{SCOPE_LABEL[s]}</option>
            ))}
          </select>
        </div>
        {/* #117: project-scope filter. Only shown when the owner actually has
            non-'global' scopes — with global-only content there is nothing to
            narrow to. Selecting a scope returns that project's rows OR 'global'. */}
        {p.scopes.length > 0 ? (
          <div class="seg">
            <select name="context" aria-label="スコープ">
              <option value="" selected={!p.context}>すべてのスコープ</option>
              {p.scopes.map((s) => (
                <option value={s} selected={s === p.context}>{s}</option>
              ))}
            </select>
          </div>
        ) : null}
        <button type="submit">検索</button>
      </div>
      <details open={Object.keys(filters).some(k => filters[k as keyof SearchFilters] !== false)} style="margin-top:1rem">
        <summary>型・期間・ファイルで絞り込む</summary>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:.8rem;margin-top:.8rem">
          <label>記憶の型<select name="memory_type" style="width:100%"><option value="">すべて（skillを含む）</option>{['user','feedback','project','reference'].map(t => <option value={t} selected={t === filters.memory_type}>{t}</option>)}</select></label>
          <label>原典のファイル<input class="full" name="file_ref" value={filters.file_ref ?? ''} placeholder="src/db.ts" style="width:100%;min-width:0" /></label>
          {(['created','updated'] as const).flatMap(field => (['since','until'] as const).map(bound => {
            const value = filters[`${field}_${bound}`];
            return <label>{field === 'created' ? '作成' : '更新'}：{bound === 'since' ? 'この日以降' : 'この日より前'}（UTC）<input class="full" type="date" name={`${field}_${bound}`} value={value == null ? '' : fmtDate(value)} style="width:100%;min-width:0" /></label>;
          }))}
        </div>
        <label style="display:flex;gap:.5rem;align-items:center;margin-top:.8rem"><input type="checkbox" name="current_only" value="true" checked={filters.current_only} />現在有効な記憶のみ</label>
        <p class="meta">型指定はnotesのみ。ファイルは保存された原典のパスと完全一致します。現在有効を選ばない場合は、更新前・期限切れ・archiveの履歴も検索します。</p>
      </details>
    </form>
    <p class="meta">{p.q ? `“${p.q}” の検索結果 ${p.hits.length}件（キーワード一致・${SCOPE_LABEL[p.scope] ?? p.scope}${p.context ? `・スコープ: ${p.context}` : ""}）` : "キーワードで探します。短い言葉で何度か試してください。"}</p>
    {p.hits.length === 0 && p.q ? <p class="muted">該当する結果が見つかりませんでした。</p> : null}
    {p.hits.map((h) => (
      <div class="res">
        <a href={h.type === "skill" ? `/@${p.handle}/skills/${h.slug}` : `/@${p.handle}/n/${h.slug}`}>{h.title}</a> <span class="pill">{hitTypeLabel(h.type)}</span>
        <div class="sn">{h.snippet}</div>
      </div>
    ))}
  </Layout>
  );
};

// issue #56: recall preview screen. IMPORTANT -- recall()/build_prompt() are
// scoped to the CALLING principal, not to the `:handle` in the URL (there is
// no owner-id separation like ranking()/skills.list() have). The route
// handler in src/index.tsx therefore NEVER calls services.recall.recall() for
// a viewer who isn't the URL's own handle -- `isOwner=false` here always means
// "no query form, no results were ever fetched", never "fetched but hidden".
// This is the one thing this component must not get wrong: it renders a
// static "準備中" placeholder for a non-owner viewer, full stop.
export const PreviewPage: FC<{
  handle: string;
  sessionHandle?: string;
  isOwner: boolean;
  q?: string;
  sections?: RecallSection[];
  used?: number;
  budget?: number;
}> = (p) => (
  <Layout title="preview" handle={p.handle} sessionHandle={p.sessionHandle}>
    <h1>記憶プレビュー</h1>
    <p class="meta">AIエージェントが実際に取得する内容を、そのまま確認できます。</p>
    {!p.isOwner ? (
      <p class="muted">準備中です。このプレビューはご本人だけが閲覧できます。</p>
    ) : (
      <>
        <form method="get" action={`/@${p.handle}/preview`} class="cols">
          <input class="full" name="q" value={p.q ?? ""} placeholder="質問や話題を入力してください" autocomplete="off" />
          <div>
            <button type="submit">見る</button>
          </div>
        </form>
        {!p.q ? null : (
          <>
            <p class="meta">
              <progress value={p.used} max={p.budget}></progress> {p.used} / {p.budget} トークン使用
            </p>
            {(p.sections ?? []).length === 0 ? <p class="muted">該当する記憶が見つかりませんでした。</p> : null}
            {(p.sections ?? []).map((s) => (
              <div class="backlinks">
                <h3>{s.label}</h3>
                <ul class="list">
                  {s.items.map((it) => (
                    <li>
                      <strong>{it.title}</strong> <span class="t">[[{it.ref}]]</span>
                      {it.sharedBy ? <span class="muted"> · @{it.sharedBy} さんの共有メモ</span> : null}
                      {it.authorUnverified ? <span class="muted"> · 最終編集者を確認できません</span> : it.editedBy ? <span class="muted"> · @{it.editedBy} さんが最終編集</span> : null}
                      <br />
                      <span class="muted" style="white-space:pre-wrap">{it.text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </>
        )}
      </>
    )}
  </Layout>
);

export const NetworkPage: FC<{
  handle: string;
  sessionHandle?: string;
  topConnected: Array<{ id: string; label: string; degree: number; stub: boolean }>;
  edges: Array<{ source: string; target: string; stub: boolean }>;
  nonce: string;
}> = (p) => (
  <Layout title="network" handle={p.handle} sessionHandle={p.sessionHandle}>
    <h1>つながり</h1>
    <p class="meta">
      ノート同士がどうつながっているかを図で見られます。線でつながっているノートは書かれたノート、点線・薄い丸はまだ書かれていないノートです。 <a href={`/@${p.handle}/network.md`}>.md</a>
    </p>
    <canvas id="graph" data-handle={p.handle}></canvas>
    <h2>よくつながっているノート</h2>
    <ul class="list">
      {p.topConnected.length === 0 ? <li class="muted">まだつながりがありません。</li> : null}
      {p.topConnected.map((n) => (
        <li>
          {n.stub ? <span class="wikilink stub">{n.label}</span> : <a href={`/@${p.handle}/n/${n.id}`}>{n.label}</a>} <span class="t">· {n.degree}件のつながり</span>
        </li>
      ))}
    </ul>
    <h2>つながり一覧</h2>
    <ul class="list">
      {p.edges.length === 0 ? <li class="muted">まだつながりがありません。</li> : null}
      {p.edges.map((e) => (
        <li>
          <span class="t">
            <a href={`/@${p.handle}/n/${e.source}`}>{e.source}</a> → {e.stub ? <span class="wikilink stub">{e.target}</span> : <a href={`/@${p.handle}/n/${e.target}`}>{e.target}</a>}
          </span>
        </li>
      ))}
    </ul>
    <script nonce={p.nonce} dangerouslySetInnerHTML={{ __html: graphScriptSrc() }} />
  </Layout>
);

// 基本記憶 (core-memory blocks): the fixed MemGPT-style set. Map each block
// label to a friendly kind name; unknown labels fall back to the raw label.
const BLOCK_KIND_LABEL: Record<string, string> = {
  persona: "AIの人格設定",
  human: "あなたについてのメモ",
  conventions: "運用ルール",
  context: "いまの文脈",
};
function blockKindLabel(label: string): string {
  return BLOCK_KIND_LABEL[label] ?? label;
}

export const MemoryPage: FC<{ handle: string; sessionHandle?: string; blocks: BlockView[] }> = (p) => (
  <Layout title="基本記憶" handle={p.handle} sessionHandle={p.sessionHandle}>
    <h1>基本記憶</h1>
    <p class="sub">recall のたびに必ず注入される、AIの人格・あなたについてのメモ・運用ルール。少数・短く保つのが原則です。</p>
    {p.blocks.length === 0 ? <p class="muted">まだ基本記憶がありません。</p> : null}
    <div class="cards" style="grid-template-columns:1fr">
      {p.blocks.map((b) => (
        <div class="card">
          <span class="k">{b.label}</span>
          <div class="v">{b.value}</div>
          <p class="li-meta" style="margin-top:.5rem">
            {blockKindLabel(b.label)} · {b.value.length} / {b.char_limit ?? "∞"} 文字
          </p>
        </div>
      ))}
    </div>
    {p.blocks.length > 0 ? (
      <p class="li-meta mono" style="margin-top:1.1rem">{p.blocks.length} ブロック · 常時注入</p>
    ) : null}
  </Layout>
);

// Inlined into the network page as a plain browser string (not TS-checked against DOM libs).
function graphScriptSrc(): string {
  return `(function(){
  var cv = document.getElementById("graph"); var ctx = cv.getContext("2d");
  var handle = encodeURIComponent(cv.dataset.handle);
  var dpr = window.devicePixelRatio || 1;
  function size(){ cv.width = cv.clientWidth*dpr; cv.height = cv.clientHeight*dpr; }
  size(); addEventListener("resize", size);
  fetch("/api/v1/@" + handle + "/graph?depth=2").then(function(r){ return r.json(); }).then(function(g){
    var N = g.nodes.map(function(n){ return { id:n.id, label:n.label, stub:n.stub, x:Math.random()*cv.width, y:Math.random()*cv.height, vx:0, vy:0 }; });
    var idx = Object.create(null); N.forEach(function(n,i){ idx[n.id]=i; });
    var E = g.edges.filter(function(e){ return idx[e.source]!=null && idx[e.target]!=null; });
    function step(){
      for (var i=0;i<N.length;i++){ for (var j=i+1;j<N.length;j++){
        var dx=N[i].x-N[j].x, dy=N[i].y-N[j].y, d2=dx*dx+dy*dy+0.01, f=(4000*dpr)/d2, d=Math.sqrt(d2);
        N[i].vx+=dx/d*f; N[i].vy+=dy/d*f; N[j].vx-=dx/d*f; N[j].vy-=dy/d*f;
      }}
      for (var k=0;k<E.length;k++){ var a=N[idx[E[k].source]], b=N[idx[E[k].target]];
        var ex=b.x-a.x, ey=b.y-a.y, ed=Math.sqrt(ex*ex+ey*ey)+0.01, ef=(ed-90*dpr)*0.01;
        a.vx+=ex/ed*ef; a.vy+=ey/ed*ef; b.vx-=ex/ed*ef; b.vy-=ey/ed*ef;
      }
      var cx=cv.width/2, cy=cv.height/2;
      for (var m=0;m<N.length;m++){ var n=N[m]; n.vx+=(cx-n.x)*0.002; n.vy+=(cy-n.y)*0.002; n.vx*=0.85; n.vy*=0.85; n.x+=n.vx; n.y+=n.vy; }
      ctx.clearRect(0,0,cv.width,cv.height); ctx.strokeStyle="rgba(127,127,127,.35)";
      for (var p=0;p<E.length;p++){ var pa=N[idx[E[p].source]], pb=N[idx[E[p].target]]; ctx.beginPath(); ctx.moveTo(pa.x,pa.y); ctx.lineTo(pb.x,pb.y); ctx.stroke(); }
      ctx.font=(12*dpr)+"px sans-serif";
      for (var q=0;q<N.length;q++){ var nq=N[q];
        ctx.beginPath(); ctx.arc(nq.x,nq.y,5*dpr,0,7);
        ctx.fillStyle=nq.stub?"rgba(180,107,74,.25)":"#2f8f7d"; ctx.fill();
        ctx.strokeStyle=nq.stub?"#b46b4a":"#2f8f7d"; ctx.stroke();
        ctx.fillStyle="rgba(127,127,127,.9)"; ctx.fillText(nq.label, nq.x+8*dpr, nq.y+4*dpr);
      }
      requestAnimationFrame(step);
    }
    cv.addEventListener("click", function(ev){
      var rc=cv.getBoundingClientRect(), mx=(ev.clientX-rc.left)*dpr, my=(ev.clientY-rc.top)*dpr;
      for (var s=0;s<N.length;s++){ var ns=N[s];
        if ((ns.x-mx)*(ns.x-mx)+(ns.y-my)*(ns.y-my) < (10*dpr)*(10*dpr) && !ns.stub){ location.href="/@"+handle+"/n/"+ns.id; }
      }
    });
    step();
  });
})();`;
}
