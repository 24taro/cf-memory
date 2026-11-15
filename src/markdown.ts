// Markdown -> HTML with first-class [[wikilink]] rendering. The caller supplies
// a resolver (DB-backed) that says whether a target exists and where it lives;
// unresolved links render as `.stub` so the garden visibly shows what to write next.

import { Marked, type TokenizerAndRendererExtension } from "marked";
import sanitizeHtml from "sanitize-html";

// Stored-XSS defense (Workers-compatible, no DOM/jsdom): marked does not
// sanitize its output (documented upstream), and its result is injected
// verbatim via dangerouslySetInnerHTML (web/pages.tsx: ProfilePage bio,
// SkillPage instructions, NotePage body) — a public/unlisted note or skill
// written by any notes:write-scoped principal could otherwise carry raw
// <script>/on*= HTML straight into any visitor's (including the owner's own
// authenticated cookie-session) browser. Allow-list only the tags/attributes
// marked's GFM renderer + our wikilink extension actually emit; everything
// else (script/style/iframe/object/embed/on*, javascript:/data: URLs) is
// stripped. See test/markdown.test.ts for the XSS regression coverage.
const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "p", "br", "hr", "strong", "em", "del", "code", "pre", "blockquote",
    "ul", "ol", "li", "a", "img", "input",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "table", "thead", "tbody", "tr", "th", "td",
  ],
  allowedAttributes: {
    a: ["href", "class", "title"],
    img: ["src", "alt", "title", { name: "referrerpolicy", values: ["no-referrer"] }, { name: "loading", values: ["lazy"] }],
    code: ["class"],
    input: ["type", "disabled", "checked"],
    th: ["align"],
    td: ["align"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  // img specifically also allows `data:` (matches the CSP's `img-src ... data:`
  // directive) so a pasted base64 screenshot embedded as a data-URI image isn't
  // silently stripped. Scoped to img only via allowedSchemesByTag -- NOT added
  // to the top-level allowedSchemes -- so <a href="data:text/html,...">-style
  // payloads (and non-image data: mimes on <img>) remain blocked; only the
  // img tag's own scheme list gains "data".
  allowedSchemesByTag: { img: ["data", "http", "https"] },
  allowProtocolRelative: false,
  // Remote https images are kept (a note may embed a diagram or a screenshot
  // hosted elsewhere), so the reader's browser does contact the author-chosen
  // host. What it must not send is the page URL, which names the member and the
  // note: every <img> gets referrerpolicy="no-referrer", overwriting whatever the
  // author wrote, and loads lazily. The host still sees the reader's IP address;
  // narrowing img-src in the CSP (index.tsx) is the control for that.
  transformTags: {
    img: (tagName, attribs) => ({ tagName, attribs: { ...attribs, referrerpolicy: "no-referrer", loading: "lazy" } }),
  },
  disallowedTagsMode: "discard",
};

export function sanitizeRenderedHtml(html: string): string {
  return sanitizeHtml(html, SANITIZE_OPTIONS);
}

export interface WikiResolution {
  href: string;
  exists: boolean;
  title?: string;
}

export type WikiResolver = (slugText: string, handle: string | null) => WikiResolution;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface WikiToken {
  type: "wikilink";
  raw: string;
  embed: boolean;
  inner: string;
}

export function renderMarkdown(body: string, resolve: WikiResolver): string {
  const wikilink: TokenizerAndRendererExtension = {
    name: "wikilink",
    level: "inline",
    start(src: string) {
      const i = src.indexOf("[[");
      return i < 0 ? undefined : i;
    },
    tokenizer(src: string): any {
      const m = /^(!?)\[\[([^\]\n]+?)\]\]/.exec(src);
      if (!m) return undefined;
      const token: WikiToken = { type: "wikilink", raw: m[0], embed: m[1] === "!", inner: m[2].trim() };
      return token;
    },
    renderer(token: any) {
      const t = token as WikiToken;
      const pipe = t.inner.indexOf("|");
      const targetPart = (pipe === -1 ? t.inner : t.inner.slice(0, pipe)).trim();
      const anchor = pipe === -1 ? "" : t.inner.slice(pipe + 1).trim();
      let handle: string | null = null;
      let slugText = targetPart;
      if (targetPart.startsWith("@")) {
        const slash = targetPart.indexOf("/");
        if (slash !== -1) {
          handle = targetPart.slice(1, slash);
          slugText = targetPart.slice(slash + 1);
        }
      }
      const r = resolve(slugText, handle);
      const label = escapeHtml(anchor || r.title || slugText);
      const cls = r.exists ? "wikilink" : "wikilink stub";
      const titleAttr = r.exists ? "" : ' title="Not yet written"';
      return `<a class="${cls}" href="${escapeHtml(r.href)}"${titleAttr}>${label}</a>`;
    },
  };

  const marked = new Marked({ gfm: true, breaks: false });
  marked.use({ extensions: [wikilink] });
  const raw = marked.parse(body, { async: false }) as string;
  return sanitizeRenderedHtml(raw);
}
