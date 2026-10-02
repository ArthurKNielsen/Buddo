// Free web search — no API keys. Tries engines in order until one answers:
//   SearxNG (if you run/choose one) → DuckDuckGo HTML → DuckDuckGo Lite → Mojeek → Wikipedia
// Special sources: "npm" (package registry) and "wikipedia".

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 Buddo/1.0';

const decode = (s = '') =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();

function unwrapDdg(href) {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const target = u.searchParams.get('uddg');
    return target ? decodeURIComponent(target) : u.href;
  } catch {
    return href;
  }
}

export function parseDdgHtml(html) {
  const out = [];
  const blocks = html.split(/class="result results_links|class="result results_links_deep|<div class="result /).slice(1);
  for (const b of blocks) {
    const a = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(b) || /href="([^"]+)"[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/.exec(b);
    if (!a) continue;
    const sn = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/.exec(b);
    const url = unwrapDdg(a[1].replace(/&amp;/g, '&'));
    if (/duckduckgo\.com\/y\.js|ad_provider/.test(url)) continue; // ads
    out.push({ title: decode(a[2]), url, snippet: decode(sn?.[1]) });
  }
  return out;
}

export function parseDdgLite(html) {
  const out = [];
  const re = /<a[^>]+href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>|<a[^>]+class=['"]result-link['"][^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets = [...html.matchAll(/class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g)].map((m) => decode(m[1]));
  let m;
  let i = 0;
  while ((m = re.exec(html))) {
    const href = m[1] || m[3];
    out.push({ title: decode(m[2] || m[4]), url: unwrapDdg(href.replace(/&amp;/g, '&')), snippet: snippets[i++] || '' });
  }
  return out;
}

export function parseMojeek(html) {
  const out = [];
  for (const b of html.split(/<li[^>]*class="[^"]*r\d*[^"]*"/).slice(1)) {
    const a = /<a[^>]+class="title"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(b) || /<a[^>]+href="([^"]+)"[^>]+class="title"[^>]*>([\s\S]*?)<\/a>/.exec(b);
    if (!a) continue;
    const s = /<p class="s">([\s\S]*?)<\/p>/.exec(b);
    out.push({ title: decode(a[2]), url: a[1], snippet: decode(s?.[1]) });
  }
  return out;
}

async function get(f, url, init = {}) {
  const r = await f(url, { ...init, headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.8', ...(init.headers || {}) }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r;
}

const ENGINES = {
  async searxng(q, { searxng, fetch: f }) {
    if (!searxng) return [];
    const r = await get(f, `${searxng.replace(/\/$/, '')}/search?q=${encodeURIComponent(q)}&format=json`);
    const j = await r.json();
    return (j.results || []).map((x) => ({ title: x.title, url: x.url, snippet: decode(x.content) }));
  },
  async duckduckgo(q, { fetch: f }) {
    const r = await get(f, 'https://html.duckduckgo.com/html/', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `q=${encodeURIComponent(q)}&kl=wt-wt` });
    return parseDdgHtml(await r.text());
  },
  async ddglite(q, { fetch: f }) {
    const r = await get(f, `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`);
    return parseDdgLite(await r.text());
  },
  async mojeek(q, { fetch: f }) {
    const r = await get(f, `https://www.mojeek.com/search?q=${encodeURIComponent(q)}`);
    return parseMojeek(await r.text());
  },
  async wikipedia(q, { fetch: f }) {
    const r = await get(f, `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&format=json&origin=*&srlimit=8`);
    const j = await r.json();
    return (j.query?.search || []).map((x) => ({ title: x.title, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(x.title.replace(/ /g, '_'))}`, snippet: decode(x.snippet) }));
  },
  async npm(q, { fetch: f }) {
    const r = await get(f, `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(q)}&size=8`);
    const j = await r.json();
    return (j.objects || []).map(({ package: p, downloads }) => ({
      title: `${p.name}@${p.version}`,
      url: p.links?.npm || `https://www.npmjs.com/package/${p.name}`,
      snippet: `${p.description || ''}${downloads?.weekly ? ` · ${downloads.weekly.toLocaleString()} weekly downloads` : ''}${p.date ? ` · updated ${String(p.date).slice(0, 10)}` : ''}`,
    }));
  },
};

/**
 * Search the web. Returns { engine, results: [{title, url, snippet}], tried: [{engine, error}] }.
 * source: 'web' (default) | 'npm' | 'wikipedia'
 */
export async function webSearch(query, { source = 'web', limit = 8, searxng, fetch: f = globalThis.fetch.bind(globalThis), engines } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('Empty search query.');
  const order = source === 'npm' ? ['npm'] : source === 'wikipedia' ? ['wikipedia'] : engines || ['searxng', 'duckduckgo', 'ddglite', 'mojeek', 'wikipedia'];
  const tried = [];
  for (const name of order) {
    if (name === 'searxng' && !searxng) continue;
    try {
      const seen = new Set();
      const results = (await ENGINES[name](q, { searxng, fetch: f }))
        .filter((r) => r.url && /^https?:/.test(r.url) && !seen.has(r.url) && seen.add(r.url))
        .slice(0, limit);
      if (results.length) return { engine: name, results, tried };
      tried.push({ engine: name, error: 'no results' });
    } catch (e) {
      tried.push({ engine: name, error: e.message || String(e) });
    }
  }
  return { engine: null, results: [], tried };
}

export function formatSearch(query, r) {
  if (!r.results.length) {
    return `No results for "${query}". Tried: ${r.tried.map((t) => `${t.engine} (${t.error})`).join(', ') || 'nothing'}. Try different words, or fetch_url a site you know.`;
  }
  return [
    `Results for "${query}" (via ${r.engine}):`,
    ...r.results.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}${x.snippet ? `\n   ${x.snippet.slice(0, 220)}` : ''}`),
    '',
    'Use fetch_url on the most relevant result to read it, and cite the URLs you use.',
  ].join('\n');
}
