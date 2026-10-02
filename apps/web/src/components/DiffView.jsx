import { useMemo } from 'react';
import { diffLines, diffHunks } from '@buddo/core';
import { highlight, langFromPath } from '../lib/markdown.js';

export default function DiffView({ before, after, path, context = 3, maxLines = 400 }) {
  const rows = useMemo(() => {
    const d = diffHunks(diffLines(before || '', after || ''), context);
    return d.slice(0, maxLines);
  }, [before, after, context, maxLines]);
  const lang = langFromPath(path);
  return (
    <div className="diff">
      {rows.map((l, i) =>
        l.type === 'skip' ? (
          <div key={i} className="diff-skip">⋯ {l.count} unchanged line{l.count > 1 ? 's' : ''}</div>
        ) : (
          <div key={i} className={`diff-line ${l.type === '+' ? 'add' : l.type === '-' ? 'del' : ''}`}>
            <span className="diff-no">{l.type === '+' ? '' : l.a}</span>
            <span className="diff-no">{l.type === '-' ? '' : l.b}</span>
            <span className="diff-sign">{l.type === ' ' ? '' : l.type}</span>
            <code className="diff-code hljs" dangerouslySetInnerHTML={{ __html: highlight(l.text, lang) || ' ' }} />
          </div>
        ),
      )}
    </div>
  );
}

export function CodeView({ content, path, start = 1, maxLines = 2000 }) {
  const lang = langFromPath(path);
  const html = useMemo(() => {
    const lines = content.split('\n').slice(0, maxLines);
    // Highlight the whole block once, then split by line (keeps multi-line tokens mostly intact).
    const h = highlight(lines.join('\n'), lang).split('\n');
    return h;
  }, [content, lang, maxLines]);
  return (
    <div className="codeview">
      {html.map((l, i) => (
        <div key={i} className="cv-line">
          <span className="cv-no">{start + i}</span>
          <code className="hljs" dangerouslySetInnerHTML={{ __html: l || ' ' }} />
        </div>
      ))}
    </div>
  );
}
