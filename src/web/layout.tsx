import type { Child, FC } from "hono/jsx";

// Redesigned house style (approved mockup): neutral gray + teal accent, light+dark
// via prefers-color-scheme (manual [data-theme] overrides supported but no toggle
// is wired — see index.tsx CSP notes). Class names are kept stable so every minor
// inherits the new tokens without markup changes.
const CSS = `
:root{
 --bg:#f7f8f8;--surface:#fff;--surface-2:#f1f2f3;--border:#e6e8e9;--border-strong:#d6d9db;
 --text:#191c1e;--text-2:#5b6166;--text-3:#6b7176;
 --accent:#1f6a5c;--accent-on:#fff;--accent-weak:#e6f2ef;--accent-ink:#1f6a5c;--stub:#8b4a32;--stub-on:#fff;
 --seed:#9aa0a5;--bud:#7a9a3e;--ever:#2f8f7d;
 --radius:10px;--radius-sm:7px;--shadow:0 1px 2px rgba(20,24,28,.05),0 10px 26px -18px rgba(20,24,28,.22);
 --sans:"Hanken Grotesk",ui-sans-serif,system-ui,sans-serif;--jp:"Noto Sans JP",var(--sans);--mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
}
:root[data-theme=dark]{
 --bg:#0f1113;--surface:#16181b;--surface-2:#1b1e22;--border:#26292e;--border-strong:#31353b;
 --text:#e7eaec;--text-2:#a7adb3;--text-3:#989fa6;--accent:#4fc3ab;--accent-on:#11211e;--accent-weak:#123029;--accent-ink:#7fe0cc;--stub:#d9966f;--stub-on:#221409;
 --seed:#71777d;--bud:#9bb85a;--ever:#4fc3ab;
}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){
 --bg:#0f1113;--surface:#16181b;--surface-2:#1b1e22;--border:#26292e;--border-strong:#31353b;
 --text:#e7eaec;--text-2:#a7adb3;--text-3:#989fa6;--accent:#4fc3ab;--accent-on:#11211e;--accent-weak:#123029;--accent-ink:#7fe0cc;--stub:#d9966f;--stub-on:#221409;
 --seed:#71777d;--bud:#9bb85a;--ever:#4fc3ab;
}}
*{box-sizing:border-box}
body{margin:0;font-family:var(--jp);color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased;line-height:1.65;font-size:15.5px}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
:where(a,button,summary,input,textarea,select):focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.mono{font-family:var(--mono)}
.muted{color:var(--text-2)}
code{font-family:var(--mono);font-size:.86em;background:var(--surface-2);padding:.05em .35em;border-radius:4px}
/* top bar */
.topbar{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:1rem;padding:.65rem 1.1rem;background:var(--surface);border-bottom:1px solid var(--border);flex-wrap:wrap}
.brand{font-family:var(--sans);font-weight:700;letter-spacing:-.01em;font-size:1.1rem;color:var(--text)}
.brand span{color:var(--accent)}
.brand:hover{text-decoration:none}
.topbar nav{display:flex;gap:.15rem;align-items:center;flex-wrap:wrap}
.topbar nav a{color:var(--text-2);font-family:var(--sans);font-size:.86rem;padding:.35rem .6rem;border-radius:7px}
.topbar nav a:hover{background:var(--surface-2);text-decoration:none;color:var(--text)}
details.nav-more{position:relative;margin:0}
details.nav-more>summary{cursor:pointer;list-style:none;color:var(--text-2);font-family:var(--sans);font-size:.86rem;padding:.35rem .6rem;border-radius:7px}
details.nav-more>summary::-webkit-details-marker{display:none}
details.nav-more>summary:hover{background:var(--surface-2);color:var(--text)}
details.nav-more .nav-more-menu{position:absolute;top:100%;left:0;margin-top:.4rem;display:flex;flex-direction:column;gap:.15rem;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);padding:.4rem;white-space:nowrap;z-index:20;box-shadow:var(--shadow)}
.topbar .search{margin-left:auto}
.topbar input{padding:.4rem .7rem;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);font:inherit;font-size:.86rem}
.topbar input:focus{border-color:var(--accent)}
@media (max-width:640px){
 .topbar{gap:.35rem .65rem;padding:.6rem 1rem}
 .topbar nav a,details.nav-more>summary{display:inline-flex;align-items:center;min-height:44px;min-width:44px;padding:.35rem .5rem}
 details.nav-more{position:static}
 details.nav-more .nav-more-menu{inset-inline:1rem;white-space:normal}
}
/* layout + headings */
main{max-width:820px;margin:0 auto;padding:2.2rem 1.2rem 4.5rem}
h1{font-family:var(--sans);font-weight:700;letter-spacing:-.02em;font-size:1.7rem;margin:.1rem 0 .3rem;color:var(--text)}
h1,.prose,.res{overflow-wrap:anywhere}
h2{font-family:var(--sans);font-weight:600;font-size:.82rem;letter-spacing:.02em;color:var(--text-3);margin:2.2rem 0 .7rem;display:flex;align-items:center;gap:.5rem}
h2::after{content:"";flex:1;height:1px;background:var(--border)}
.meta{color:var(--text-2);font-size:.9rem;margin:.2rem 0 1.4rem}
.meta a{color:var(--accent)}
.sub{color:var(--text-2);font-size:.92rem;margin:.2rem 0 1.6rem}
/* badges */
.pill{display:inline-flex;align-items:center;gap:.3rem;font-size:.72rem;font-family:var(--sans);color:var(--text-2);background:var(--surface-2);border:1px solid var(--border);border-radius:999px;padding:.08rem .55rem;margin-right:.3rem;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pill .dot{transform:none}
.tag{display:inline-block;font-size:.72rem;color:var(--text-2);background:var(--surface-2);border:1px solid var(--border);border-radius:999px;padding:.05rem .5rem;margin-left:.35rem;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom}
.tag:hover{border-color:var(--accent);color:var(--text);text-decoration:none}
.scope{color:var(--accent-ink);background:var(--accent-weak);border-color:transparent}
/* lists */
.list{list-style:none;margin:0;padding:0}
.list li{padding:.65rem .1rem;border-bottom:1px solid var(--border)}
.list li:last-child{border-bottom:0}
.list .t{color:var(--text-3);font-size:.78rem;font-family:var(--mono)}
.rlist li{display:flex;gap:.7rem;align-items:baseline}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex:0 0 auto;transform:translateY(1px)}
.d-seed{background:var(--seed)}.d-bud{background:var(--bud)}.d-ever{background:var(--ever)}
.li-main{flex:1;min-width:0}
.li-main a{color:var(--text);font-weight:500;overflow-wrap:anywhere}
.li-main a:hover{color:var(--accent)}
.li-meta{color:var(--text-3);font-size:.78rem;font-family:var(--mono);margin-top:.12rem}
.li-when{color:var(--text-3);font-size:.78rem;font-family:var(--mono);white-space:nowrap}
.legend{display:flex;flex-wrap:wrap;gap:1rem;font-size:.78rem;color:var(--text-3);margin:.7rem .1rem 0}
.legend span{display:inline-flex;align-items:center;gap:.35rem}
/* home search field */
.searchwrap{position:relative;margin:.4rem 0 .2rem}
.searchwrap input{width:100%;font:inherit;font-size:1.02rem;padding:.85rem 1rem .85rem 2.6rem;border:1px solid var(--border-strong);border-radius:12px;background:var(--surface);color:var(--text);box-shadow:var(--shadow)}
.searchwrap input:focus{border-color:var(--accent)}
.searchwrap svg{position:absolute;left:.9rem;top:50%;transform:translateY(-50%);color:var(--text-3)}
.modehint{margin:.55rem .2rem 0;font-size:.8rem;color:var(--text-3)}
.modehint b{color:var(--accent);font-weight:600}
/* core-memory glance */
.cards{display:grid;grid-template-columns:1fr 1fr;gap:.7rem}
.card{border:1px solid var(--border);border-radius:var(--radius);background:var(--surface);padding:.8rem .9rem}
.card .k{font-family:var(--mono);font-size:.74rem;color:var(--accent-ink);background:var(--accent-weak);display:inline-block;padding:.08rem .4rem;border-radius:5px;margin-bottom:.4rem}
.card .v{font-size:.86rem;color:var(--text-2);line-height:1.5;white-space:pre-wrap;overflow-wrap:break-word}
@media (max-width:640px){.cards{grid-template-columns:1fr}}
/* browse chips */
.chips{display:flex;flex-wrap:wrap;gap:.4rem}
.chip{font-size:.82rem;color:var(--text-2);border:1px solid var(--border);background:var(--surface);border-radius:999px;padding:.32rem .7rem;cursor:pointer;display:inline-flex;align-items:center;gap:.3rem}
.chip:hover{border-color:var(--accent);color:var(--text);text-decoration:none}
.chip .n{color:var(--text-3);font-family:var(--mono);font-size:.74rem}
/* note read */
.nhead{margin-bottom:1.2rem}
.meta-row{margin-top:.5rem;display:flex;flex-wrap:wrap;align-items:center;gap:.3rem}
.prose{font-size:1rem;line-height:1.85}
.prose h1{font-family:var(--sans);font-size:1.4rem;letter-spacing:normal;margin:1.5rem 0 .5rem}
.prose h2{font-family:var(--sans);display:block;border:0;padding:0;color:var(--text);font-size:1.15rem;margin:1.5rem 0 .5rem}
.prose h2::after{content:none;display:none}
.prose h3{font-family:var(--sans);font-size:1.02rem;margin:1.3rem 0 .4rem}
.prose p{margin:.7rem 0}
.prose ul,.prose ol{padding-left:1.3rem}
.prose blockquote{margin:.7rem 0;padding-left:.9rem;border-left:3px solid var(--border);color:var(--text-2)}
.prose pre{background:var(--surface-2);border:1px solid var(--border);padding:.8rem;border-radius:8px;overflow:auto;font-size:.85rem}
.prose code{font-family:var(--mono);font-size:.86em}
.prose pre code{background:none;padding:0}
a.wikilink{color:var(--accent);border-bottom:1px dotted var(--accent)}
a.wikilink.stub{color:var(--stub);border-bottom:1px dashed var(--stub)}
.wikilink.stub{color:var(--stub)}
/* backlinks card + note mesh */
.backlinks{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:.8rem 1rem;margin-top:1.5rem}
.backlinks h3{margin:.1rem 0 .5rem;font-size:.95rem;font-family:var(--sans)}
.mesh{margin-top:2.2rem;border-top:1px solid var(--border);padding-top:1.1rem;display:grid;grid-template-columns:1fr 1fr;gap:1.4rem}
.mesh h3{font-family:var(--sans);font-size:.78rem;color:var(--text-3);font-weight:600;margin:0 0 .5rem}
.mesh ul{list-style:none;margin:0;padding:0}
.mesh li{padding:.28rem 0;font-size:.88rem}
@media (max-width:640px){.mesh{grid-template-columns:1fr;gap:1rem}}
/* action buttons */
.nact{margin-top:1.6rem;display:flex;gap:.5rem;flex-wrap:wrap}
.btn{font:inherit;font-size:.82rem;padding:.42rem .8rem;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text-2);cursor:pointer;text-decoration:none;display:inline-block}
.btn:hover{border-color:var(--border-strong);color:var(--text);text-decoration:none}
.btn.p{background:var(--accent);border-color:var(--accent);color:var(--accent-on)}
/* search results */
.seg{display:inline-flex;border:1px solid var(--border);border-radius:9px;overflow:hidden;background:var(--surface);max-width:100%;min-width:0}
.seg select{border:0;border-radius:0;background:transparent;width:auto;max-width:100%;text-overflow:ellipsis}
.res{border:1px solid var(--border);border-radius:var(--radius);background:var(--surface);padding:.85rem 1rem;margin-top:.7rem}
.res>a{color:var(--text);font-weight:600}
.res .sn{color:var(--text-2);font-size:.88rem;margin-top:.3rem}
.res .via{font-family:var(--mono);font-size:.72rem;color:var(--text-3);margin-top:.4rem}
/* forms */
details.disclosure{margin-top:.6rem}
details.disclosure>summary{cursor:pointer;color:var(--text-2);font-size:.85rem}
.cols{display:grid;grid-template-columns:1fr;gap:.7rem;margin:1rem 0}
.cols label{display:grid;gap:.25rem;font-size:.9rem;min-width:0}
textarea,input.full,select{width:100%;font:inherit;padding:.6rem .7rem;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text)}
textarea{min-height:22rem;font-family:var(--mono);font-size:.9rem;line-height:1.6}
select{width:auto}
input.full:focus,textarea:focus,select:focus{border-color:var(--accent)}
button{font:inherit;padding:.45rem 1rem;border:1px solid var(--accent);background:var(--accent);color:var(--accent-on);border-radius:8px;cursor:pointer}
button:hover{filter:brightness(1.06)}
progress{width:220px;height:9px;vertical-align:middle;accent-color:var(--accent)}
/* misc */
footer{max-width:820px;margin:2.4rem auto 0;padding:1.2rem 1.2rem 3rem;color:var(--text-3);font-size:.82rem;font-family:var(--sans);border-top:1px dashed var(--border);text-align:center}
footer a{color:var(--text-2)}
#graph{width:100%;height:70vh;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface)}
`;

export const Layout: FC<{ title: string; handle?: string; sessionHandle?: string; children?: Child }> = (props) => {
  const owner = props.sessionHandle !== undefined && props.sessionHandle === props.handle;
  return (
    <html lang="ja">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title} · cf-memory</title>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&family=Noto+Sans+JP:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body>
        <header class="topbar">
          <a class="brand" href="/">
            cf-<span>memory</span>
          </a>
          {props.handle ? (
            <nav aria-label="メインメニュー">
              <a href={`/@${props.handle}`}>ホーム</a>
              <a href="/search">検索</a>
              {/* Core-memory ("基本記憶") is owner-private: only the owner's own
                  browser session sees the link (mirrors the /memory route gate). */}
              {owner ? <a href={`/@${props.handle}/memory`}>基本記憶</a> : null}
              <a href={`/@${props.handle}/skills`}>スキル</a>
              <details class="nav-more">
                <summary>もっと見る▾</summary>
                <div class="nav-more-menu">
                  <a href={`/@${props.handle}/ranking`}>よく使われている</a>
                  <a href={`/@${props.handle}/changes`}>更新履歴</a>
                  <a href={`/@${props.handle}/network`}>つながり</a>
                  {/* Owner-private view. */}
                  {owner ? <a href={`/@${props.handle}/preview`}>記憶プレビュー</a> : null}
                  {props.sessionHandle ? <a href="/agent-health">Agentの状態</a> : null}
                  {props.sessionHandle ? <a href="/capture">Capture原典</a> : null}
                </div>
              </details>
            </nav>
          ) : null}
          <form class="search" action="/search" method="get">
            <input name="q" placeholder="ノートやスキルを検索" aria-label="ノートやスキルを検索" autocomplete="off" />
          </form>
          {props.sessionHandle ? (
            <span class="meta" style="margin:0">
              @{props.sessionHandle} · <a href="/cdn-cgi/access/logout">ログアウト</a>
            </span>
          ) : null}
        </header>
        <main>{props.children}</main>
        <footer>
          cf-memory — あなたの記憶とAIの記憶を、ひとつの場所で · <a href="/api/v1/openapi">api</a>
        </footer>
      </body>
    </html>
  );
};
