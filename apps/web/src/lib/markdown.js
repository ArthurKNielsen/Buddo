import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import { fenceRawHtml } from '@buddo/core';

const marked = new Marked({ gfm: true, breaks: false });

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function highlight(code, lang) {
  try {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    if (code.length < 20000) return hljs.highlightAuto(code).value;
  } catch {}
  return esc(code);
}

export function langFromPath(path = '') {
  const ext = path.split('.').pop().toLowerCase();
  const map = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript',
    py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', h: 'c',
    cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
    vue: 'xml', css: 'css', scss: 'scss', less: 'less', json: 'json', md: 'markdown', yml: 'yaml', yaml: 'yaml',
    toml: 'ini', ini: 'ini', sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql', lua: 'lua', r: 'r', dart: 'dart',
    dockerfile: 'dockerfile', makefile: 'makefile',
  };
  return map[ext] || (/dockerfile$/i.test(path) ? 'dockerfile' : '');
}

marked.use({
  renderer: {
    code({ text, lang }) {
      const l = (lang || '').split(/\s/)[0];
      return `<div class="codeblock"><div class="codeblock-head"><span>${esc(l || 'code')}</span><button class="copy-btn" data-copy>Copy</button></div><pre><code class="hljs">${highlight(text, l)}</code></pre></div>`;
    },
    // Models sometimes write HTML tags in prose; show them as text instead of rendering live elements.
    html({ text }) {
      return esc(text);
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      return `<a href="${esc(href || '')}" target="_blank" rel="noopener noreferrer"${title ? ` title="${esc(title)}"` : ''}>${text}</a>`;
    },
  },
});

const cache = new Map();
/**
 * fold: Buddo already saved this reply's code (often only a line or two of it), so long code blocks are folded
 * into one line instead of filling the chat with the whole script the model wrote.
 */
export function renderMarkdown(src, { fold = false } = {}) {
  const key = `${fold ? 'f' : ''}:${src}`;
  if (cache.has(key)) return cache.get(key);
  // Close an unterminated fence while streaming so the code block renders nicely.
  // A bare pasted HTML page becomes one code block (the same thing Buddo saves as a file).
  let s = fenceRawHtml(src);
  if ((s.match(/^```/gm) || []).length % 2 === 1) s += '\n```';
  let html = DOMPurify.sanitize(marked.parse(s), { ADD_ATTR: ['target', 'data-copy'] });
  if (fold) {
    html = html.replace(/<div class="codeblock">[\s\S]*?<\/code><\/pre><\/div>/g, (block) => {
      const lines = (block.match(/\n/g) || []).length + 1;
      if (lines < 5) return block;
      return `<details class="code-fold"><summary>Code the model wrote (${lines} lines) · Buddo saved only what changed, shown below</summary>${block}</details>`;
    });
  }
  if (cache.size > 300) cache.clear();
  cache.set(key, html);
  return html;
}

/** Delegate clicks on copy buttons inside rendered markdown. */
export function handleCopyClick(e) {
  const btn = e.target.closest?.('[data-copy]');
  if (!btn) return;
  const code = btn.closest('.codeblock')?.querySelector('code')?.innerText || '';
  navigator.clipboard?.writeText(code);
  btn.textContent = 'Copied ✓';
  btn.classList.add('done');
  setTimeout(() => {
    btn.textContent = 'Copy';
    btn.classList.remove('done');
  }, 1400);
}
