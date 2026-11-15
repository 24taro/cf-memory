import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/markdown";

const resolver = (slugText: string) => {
  const slug = slugText.toLowerCase().replace(/\s+/g, "-");
  const exists = slug === "exists";
  return { href: `/@owner/n/${slug}`, exists, title: exists ? "Exists" : undefined };
};

describe("renderMarkdown", () => {
  it("renders resolved wikilinks without the stub class", () => {
    const html = renderMarkdown("link to [[exists]]", resolver);
    expect(html).toContain('href="/@owner/n/exists"');
    expect(html).toContain('class="wikilink"');
    expect(html).not.toContain("stub");
  });

  it("marks missing targets as stubs", () => {
    const html = renderMarkdown("link to [[missing]]", resolver);
    expect(html).toContain('class="wikilink stub"');
    expect(html).toContain("Not yet written");
  });

  it("uses the anchor label when present", () => {
    const html = renderMarkdown("[[exists|Click here]]", resolver);
    expect(html).toContain(">Click here<");
  });

  it("still renders ordinary markdown", () => {
    const html = renderMarkdown("# Title\n\n**bold**", resolver);
    expect(html).toContain("<h1");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("escapes html in the anchor text", () => {
    const html = renderMarkdown("[[exists|<script>]]", resolver);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

// Sanitizer data: URI images (review follow-up): the sanitize-html allow-list
// stripped `src` off any `<img>` using a data: URI even though the CSP's
// `img-src ... data:` directive signals data: images were meant to keep
// working -- a pasted base64 screenshot silently vanished from the rendered
// page with no error. Fix scopes `data:` onto <img> only (allowedSchemesByTag),
// leaving the top-level allowedSchemes (used by <a href>) untouched so a
// data:-URI-based XSS vector isn't reopened elsewhere.
describe("renderMarkdown — data: URI images (review follow-up)", () => {
  it("keeps a data: URI image's src intact instead of silently stripping it", () => {
    const html = renderMarkdown("![tiny](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=)", resolver);
    expect(html).toContain("src=\"data:image/png;base64,");
  });

  it("still renders an ordinary https: image with its src intact (control)", () => {
    const html = renderMarkdown("![alt](https://example.com/a.png)", resolver);
    expect(html).toContain('src="https://example.com/a.png"');
  });

  it("does not reopen a data: URI XSS vector on <a href> — a malicious data:text/html anchor is still stripped", () => {
    const html = renderMarkdown('<a href="data:text/html,<script>alert(1)</script>">click</a>', resolver);
    expect(html).not.toContain("data:text/html");
    expect(html).not.toContain("href=");
  });

  it("still strips a javascript: URI on <img src> (data: is the only newly-allowed img scheme)", () => {
    const html = renderMarkdown('<img src="javascript:alert(1)" alt="evil">', resolver);
    expect(html).not.toContain("javascript:");
  });
});
