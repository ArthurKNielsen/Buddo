import { useEffect, useMemo, useRef } from 'react';
import { motion } from 'framer-motion';
import { FilePen, FilePlus2, TerminalSquare, Code2 } from 'lucide-react';
import { highlight, langFromPath } from '../lib/markdown.js';

const MAX_LINES = 400; // highlight only the tail of very long files so typing stays smooth

function Lines({ text, path, kind, caret }) {
  const lang = langFromPath(path);
  const { html, offset } = useMemo(() => {
    const lines = text.split('\n');
    const offset = Math.max(0, lines.length - MAX_LINES);
    return { html: highlight(lines.slice(offset).join('\n'), lang).split('\n'), offset };
  }, [text, lang]);
  return (
    <div className={`codeview live-${kind || 'code'}`}>
      {html.map((l, i) => (
        <div key={i} className="cv-line">
          <span className="cv-no">{offset + i + 1}</span>
          {kind && <span className="diff-sign">{kind === 'add' ? '+' : '-'}</span>}
          <code className="hljs">
            <span dangerouslySetInnerHTML={{ __html: l || (i === html.length - 1 ? '' : ' ') }} />
            {caret && i === html.length - 1 && <span className="live-caret" />}
          </code>
        </div>
      ))}
    </div>
  );
}

/** Shows a tool call while the model is still writing it — code appears as it is typed. */
export default function LiveCode({ live }) {
  const body = useRef(null);
  const a = live.args || {};
  const code = live.name === 'write_file' ? a.content || '' : live.name === 'edit_file' ? `${a.old || ''}${a.new || ''}` : a.command || a.content || '';
  const lines = code ? code.split('\n').length : 0;
  const secs = Math.max(0.5, (Date.now() - live.startedAt) / 1000);
  const speed = Math.round(code.length / secs);

  // Follow the cursor.
  useEffect(() => {
    if (body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [code]);

  const Icon = live.name === 'write_file' ? FilePlus2 : live.name === 'edit_file' ? FilePen : live.name === 'run_command' ? TerminalSquare : Code2;
  const title = live.name === 'write_file' ? 'Writing' : live.name === 'edit_file' ? 'Editing' : live.name === 'run_command' ? 'Typing command' : 'Preparing';

  return (
    <motion.div className="tool live-code" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      <div className="tool-head">
        <span className="tool-icon">
          <Icon size={14} />
        </span>
        <span className="tool-label">{title}</span>
        <span className="tool-desc truncate mono">{a.path || ''}</span>
        <span className="spacer" />
        <span className="tool-sum">
          {lines} line{lines === 1 ? '' : 's'} · {speed} chars/s
        </span>
        <span className="live-dot">LIVE</span>
      </div>
      {(live.name === 'write_file' || live.name === 'edit_file' || a.command) && (
        <div className="tool-body-inner live-body" ref={body}>
          {live.name === 'write_file' && <Lines text={a.content || ''} path={a.path} caret={live.writing === 'content' || !a.content} />}
          {live.name === 'edit_file' && (
            <>
              {a.old !== undefined && <Lines text={a.old} path={a.path} kind="del" caret={live.writing === 'old'} />}
              {a.new !== undefined && <Lines text={a.new} path={a.path} kind="add" caret={live.writing === 'new'} />}
            </>
          )}
          {live.name === 'run_command' && (
            <pre className="term">
              <span className="term-prompt">$</span> {a.command}
              <span className="live-caret" />
            </pre>
          )}
        </div>
      )}
    </motion.div>
  );
}
