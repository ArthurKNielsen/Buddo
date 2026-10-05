// Turns the project's files into one page for the preview frame: local CSS and
// JS are inlined, and clicks on links to other local pages switch the preview.

const escapeAttr = (s) => s.replace(/"/g, "&quot;");

function resolve(from, rel) {
  if (/^([a-z]+:|\/\/|#|data:)/i.test(rel)) return null;
  const base = from.includes("/") ? from.slice(0, from.lastIndexOf("/") + 1) : "";
  const parts = (base + rel.split(/[?#]/)[0]).split("/");
  const out = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p && p !== ".") out.push(p);
  }
  return out.join("/");
}

export function pagesOf(files) {
  return Object.keys(files).filter((p) => /\.html?$/i.test(p)).sort((a, b) => (a === "index.html" ? -1 : b === "index.html" ? 1 : a.localeCompare(b)));
}

export function buildPreview(files, page) {
  if (!page || !(page in files)) {
    return `<!doctype html><meta charset="utf-8"><body style="font:15px system-ui;color:#888;display:grid;place-items:center;height:90vh;margin:0">Nothing to preview yet. Ask Buddo to build a website.</body>`;
  }
  let html = files[page];
  html = html.replace(/<link\b[^>]*?href=["']([^"']+)["'][^>]*>/gi, (tag, href) => {
    if (!/stylesheet/i.test(tag)) return tag;
    const p = resolve(page, href);
    return p && p in files ? `<style data-file="${escapeAttr(p)}">\n${files[p]}\n</style>` : tag;
  });
  html = html.replace(/<script\b([^>]*?)\bsrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (tag, a, src, b) => {
    const p = resolve(page, src);
    if (!p || !(p in files)) return tag;
    const attrs = `${a} ${b}`.replace(/\s+/g, " ").trim();
    return `<script ${attrs} data-file="${escapeAttr(p)}">\n${files[p].replace(/<\/script/gi, "<\\/script")}\n</script>`;
  });
  html = html.replace(/(<img\b[^>]*?\bsrc=["'])([^"']+)(["'])/gi, (m, pre, src, post) => {
    const p = resolve(page, src);
    if (p && p in files && p.endsWith(".svg")) return `${pre}data:image/svg+xml;charset=utf-8,${encodeURIComponent(files[p])}${post}`;
    return m;
  });
  const nav = `<script>document.addEventListener("click",e=>{const a=e.target.closest("a[href]");if(!a)return;const h=a.getAttribute("href");if(/^(https?:|mailto:|tel:|#)/.test(h))return;e.preventDefault();parent.postMessage({buddoNavigate:h,from:${JSON.stringify(page)}},"*")});</script>`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${nav}</body>`) : html + nav;
}

export { resolve as resolvePath };
