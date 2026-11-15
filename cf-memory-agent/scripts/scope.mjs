const GLOBAL = "global";

/** Canonicalize a raw scope value (git remote URL, workdir path, or free label)
 * into a stable scope string. Empty / whitespace / "global" (any case) → "global". */
export function normalizeScope(raw) {
  const s = (raw ?? "").trim();
  if (!s || s.toLowerCase() === GLOBAL) return GLOBAL;

  // A git remote in URL form: <scheme>://[user[:pw]@]host[:port]/<path>
  const url = s.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]+@)?([^/:]+)(?::\d+)?\/(.+)$/i);
  if (url) return `${url[1].toLowerCase()}/${stripRepoPath(url[2])}`;

  // scp-like remote: [user@]host:path (NOT a URL — no "://"). Take this branch
  // when EITHER a `user@` prefix is present (scp remotes are virtually always
  // `git@host:path`, so this collapses dot-less INTERNAL hosts too, matching
  // their https/ssh:// form) OR the host looks like a hostname (contains a dot).
  // A Windows drive path "C:\..." or a bare "label:x" free label has neither a
  // user@ prefix nor a dotted host, so it is left alone.
  const scp = s.match(/^(?:([^/@]+)@)?([^/:]+):(.+)$/);
  if (scp && !s.includes("://") && (scp[1] !== undefined || scp[2].includes("."))) {
    return `${scp[2].toLowerCase()}/${stripRepoPath(scp[3])}`;
  }

  // 2026-08-20: それ以外は 'global'。
  //
  // 以前はここで作業ディレクトリのパスや自由ラベルをそのまま scope にしていた。
  // その結果、同じ1つのプロジェクトが本番で3通りに割れていた:
  //   `search` / `github.com/acme/search` / `/Users/.../acme/search`
  // どれも互いに見えず、絞り込みが静かに外れていた。
  //
  // scope が取りうる値を「git remote か global」に限れば、この割れ方は起こり得ない。
  // git 配下でない作業に固有の scope は無い、というのがその帰結 —— 無いものを
  // 名前で作るより 'global' に落とす方が正しい。
  //
  // 既に正規形(host/path)で渡されたものは冪等に通す。ホスト名にドットを要求しない
  // のは、社内ホストが `git@host:path` の形で来て `host/path` になるため。
  // 弾きたいのは「スラッシュを含まない裸のラベル」と「絶対パス」の2つ。
  if (s.includes("/") && !s.startsWith("/")) return stripTrailingGit(s.replace(/\/+$/, "")) || GLOBAL;
  return GLOBAL;
}

function stripRepoPath(path) {
  return stripTrailingGit(path.replace(/^\/+|\/+$/g, ""));
}

function stripTrailingGit(s) {
  return s.replace(/\.git$/, "");
}

