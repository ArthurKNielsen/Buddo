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
export function renderMarkdown(src) {
  if (cache.has(src)) return cache.get(src);
  // Close an unterminated fence while streaming so the code block renders nicely.
  // A bare pasted HTML page becomes one code block (the same thing Buddo saves as a file).
  let s = fenceRawHtml(src);
  if ((s.match(/^```/gm) || []).length % 2 === 1) s += '\n```';
  const html = DOMPurify.sanitize(marked.parse(s), { ADD_ATTR: ['target', 'data-copy'] });
  if (cache.size > 300) cache.clear();
  cache.set(src, html);
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
