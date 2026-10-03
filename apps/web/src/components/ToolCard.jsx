import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  FileText, FilePen, FilePlus2, FolderTree, Search, TerminalSquare, Globe, ListTodo, Files, ChevronRight, Check, X, Ban, ShieldQuestion, CircleDashed, CheckCircle2, Circle, Clapperboard, Ear, Image as ImageIcon, Camera, Video, Brain, ExternalLink,
} from 'lucide-react';
import MediaView from './MediaView.jsx';
import { describeCall, diffLines, diffStats, parseTodos } from '@buddo/core';
import { useStore } from '../lib/store.js';
import { respondPermission } from '../lib/runner.js';
import DiffView, { CodeView } from './DiffView.jsx';

const META = {
  list_dir: { icon: FolderTree, label: 'List' },
  read_file: { icon: FileText, label: 'Read' },
  search: { icon: Search, label: 'Search' },
  glob: { icon: Files, label: 'Find files' },
  write_file: { icon: FilePlus2, label: 'Write' },
  edit_file: { icon: FilePen, label: 'Edit' },
  run_command: { icon: TerminalSquare, label: 'Run' },
  fetch_url: { icon: Globe, label: 'Fetch' },
  todo: { icon: ListTodo, label: 'Plan' },
  watch_video: { icon: Clapperboard, label: 'Watch' },
  listen_audio: { icon: Ear, label: 'Listen' },
  view_image: { icon: ImageIcon, label: 'Look' },
  web_search: { icon: Search, label: 'Web search' },
  screenshot: { icon: Camera, label: 'Screenshot' },
  record_video: { icon: Video, label: 'Record' },
  remember: { icon: Brain, label: 'Remember' },
};

function Stats({ before, after }) {
  const s = diffStats(diffLines(before || '', after || ''));
  return (
    <span className="diff-stats">
      <span className="add">+{s.added}</span>
      <span className="del">−{s.removed}</span>
    </span>
  );
}

export function TodoList({ todos }) {
  return (
    <div className="todos">
      {todos.map((t, i) => (
        <motion.div
          key={i + t.text}
          className={`todo ${t.status}`}
          initial={{ opacity: 0, x: -6 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: i * 0.03 }}
        >
          {t.status === 'done' ? (
            <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 500, damping: 20 }}>
              <CheckCircle2 size={15} />
            </motion.span>
          ) : t.status === 'active' ? (
            <CircleDashed size={15} className="spin-slow" />
          ) : (
            <Circle size={15} />
          )}
          <span>{t.text}</span>
        </motion.div>
      ))}
    </div>
  );
}

function Body({ part }) {
  const d = part.display;
  const call = part.call;
  if (part.status === 'awaiting' && part.preview) {
    if (part.preview.notFound) return <div className="tool-note warn">The snippet to replace wasn't found — Buddo will get an error and retry.</div>;
    return <DiffView before={part.preview.before} after={part.preview.after} path={call.args.path} />;
  }
  if (part.status === 'awaiting' && call.name === 'run_command') {
    return (
      <pre className="term">
        <span className="term-prompt">$</span> {call.args.command}
      </pre>
    );
  }
  if (!d) {
    if (call.name === 'todo') return <TodoList todos={parseTodos(call.args.items)} />;
    return part.output ? <pre className="tool-output">{part.output}</pre> : null;
  }
  switch (d.type) {
    case 'diff':
      return <DiffView before={d.before} after={d.after} path={d.path} />;
    case 'terminal':
      return (
        <pre className="term">
          <span className="term-prompt">$</span> {d.command}
          {'\n'}
          {d.output || <span className="faint">(no output)</span>}
          {'\n'}
          <span className={d.code === 0 ? 'term-ok' : 'term-bad'}>exit {d.code}</span>
        </pre>
      );
    case 'file':
      return <CodeView content={d.content.split('\n').slice(d.start - 1, d.end).join('\n')} path={d.path} start={d.start} maxLines={300} />;
    case 'search':
      return (
        <div className="hits">
          {d.hits.slice(0, 80).map((h, i) => (
            <div key={i} className="hit">
              <span className="hit-file">
                {h.file}:{h.line}
              </span>
              <code>{h.text.trim().slice(0, 160)}</code>
            </div>
          ))}
          {!d.hits.length && <div className="faint">No matches</div>}
        </div>
      );
    case 'files':
      return <pre className="tool-output">{d.files.slice(0, 200).join('\n') || 'No files'}</pre>;
    case 'todos':
      return <TodoList todos={d.todos} />;
    case 'web':
      return <pre className="tool-output">{d.text.slice(0, 4000)}</pre>;
    case 'media':
      return <MediaView d={d} />;
    case 'websearch':
      return (
        <div className="web-results">
          {d.results.map((r, i) => (
            <a key={i} className="web-result" href={r.url} target="_blank" rel="noreferrer">
              <span className="wr-title">
                {r.title} <ExternalLink size={11} />
              </span>
              <span className="wr-url">{r.url.replace(/^https?:\/\//, '').slice(0, 80)}</span>
              {r.snippet && <span className="wr-snippet">{r.snippet}</span>}
            </a>
          ))}
          {!d.results.length && <div className="faint" style={{ padding: 12 }}>No results ({d.tried.map((t) => t.engine).join(', ')})</div>}
        </div>
      );
    case 'memory':
      return (
        <div className="memory-note">
          <Brain size={14} /> {d.fact}
        </div>
      );
    default:
      return <pre className="tool-output">{part.output}</pre>;
  }
}

function summary(part) {
  const d = part.display;
  if (part.status === 'denied') return 'Denied';
  if (part.status === 'error') return part.output?.split('\n')[0].replace(/^Error:\s*/, '').slice(0, 90);
  if (!d) return null;
  switch (d.type) {
    case 'file': return `${d.end - d.start + 1} lines`;
    case 'search': return `${d.hits.length} match${d.hits.length === 1 ? '' : 'es'}`;
    case 'files': return `${d.files.length} file${d.files.length === 1 ? '' : 's'}`;
    case 'tree': return `${d.entries.length} entries`;
    case 'terminal': return d.code === 0 ? 'exit 0' : `exit ${d.code}`;
    case 'todos': return `${d.todos.filter((t) => t.status === 'done').length}/${d.todos.length} done`;
    case 'web': return `${Math.round(d.text.length / 1000)}k chars`;
    case 'websearch': return `${d.results.length} results${d.engine ? ` · ${d.engine}` : ''}`;
    case 'memory': return 'saved to memory';
    case 'media': return d.kind === 'screenshot' ? `${d.size?.join('×')} · ${(d.ms / 1000).toFixed(1)}s` : d.kind === 'recording' ? `${d.frames?.length || 0} frames · ${(d.ms / 1000).toFixed(1)}s` : `${d.kind === 'video' ? `${d.frames.length} frames${d.hearing ? ' + audio' : ''}` : d.kind === 'audio' ? `${d.hearing?.speech?.segments.length || 0} lines heard` : `${d.objects.length} objects`} · ${(d.ms / 1000).toFixed(1)}s`;
    default: return null;
  }
}

export default function ToolCard({ part }) {
  const call = part.call;
  const m = META[call.name] || { icon: CircleDashed, label: call.name };
  const awaiting = part.status === 'awaiting';
  const permission = useStore((s) => s.permission);
  const myTurn = awaiting && permission?.callId === call.id;
  const cardRef = useRef(null);
  const autoOpen = awaiting || (part.display?.type === 'diff') || part.display?.type === 'media' || part.display?.type === 'memory' || call.name === 'todo' || (part.display?.type === 'terminal' && part.display.code !== 0);
  const [open, setOpen] = useState(autoOpen);
  useEffect(() => {
    if (autoOpen) setOpen(true);
  }, [autoOpen]);

  // Make sure the Allow/Deny buttons are visible (they slide in below the diff).
  useEffect(() => {
    if (!myTurn) return;
    const t = setTimeout(() => cardRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }), 320);
    return () => clearTimeout(t);
  }, [myTurn]);

  useEffect(() => {
    if (!myTurn) return;
    const onKey = (e) => {
      if (e.target.tagName === 'TEXTAREA' && e.target.value) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        respondPermission('allow');
      } else if (e.key === 'Escape') {
        e.preventDefault();
        respondPermission('deny');
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [myTurn]);

  const d = part.display;
  const label = call.name === 'write_file' && d?.created === false ? 'Overwrite' : m.label;
  const sum = summary(part);
  const hasBody = part.output || part.preview || d || call.name === 'todo' || call.name === 'run_command';

  return (
    <motion.div
      ref={cardRef}
      layout="position"
      className={`tool ${part.status}`}
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: 'spring', stiffness: 420, damping: 32 }}
    >
      <button className="tool-head" onClick={() => hasBody && setOpen(!open)}>
        <span className="tool-icon">
          <m.icon size={14} />
        </span>
        <span className="tool-label">{label}</span>
        <span className="tool-desc truncate mono">{describeCall(call)}</span>
        {call.auto && <span className="tool-tag" title="The model wrote a code block; Buddo saved it as a file">from code block</span>}
        <span className="spacer" />
        {d?.type === 'diff' && <Stats before={d.before} after={d.after} />}
        {sum && d?.type !== 'diff' && <span className={`tool-sum ${part.status === 'error' ? 'err' : ''}`}>{sum}</span>}
        <span className="tool-status">
          {part.status === 'running' && <span className="spinner" />}
          {part.status === 'done' && (
            <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} className="ok">
              <Check size={14} />
            </motion.span>
          )}
          {part.status === 'error' && <X size={14} className="err" />}
          {part.status === 'denied' && <Ban size={14} className="faint" />}
          {awaiting && <ShieldQuestion size={15} className="warn" />}
        </span>
        {hasBody && (
          <motion.span animate={{ rotate: open ? 90 : 0 }} className="tool-chev">
            <ChevronRight size={14} />
          </motion.span>
        )}
      </button>
      <AnimatePresence initial={false}>
        {open && hasBody && (
          <motion.div
            className="tool-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="tool-body-inner">
              <Body part={part} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {myTurn && (
          <motion.div className="perm" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
            <div className="perm-inner">
              <span className="perm-q">
                {call.name === 'run_command' ? 'Run this command?' : call.name === 'write_file' ? `Write ${call.args.path}?` : `Apply this edit to ${call.args.path}?`}
              </span>
              <span className="spacer" />
              <button className="btn btn-sm btn-ghost" onClick={() => respondPermission('deny')}>
                Deny <kbd>esc</kbd>
              </button>
              <button className="btn btn-sm btn-outline" onClick={() => respondPermission('always')}>
                Always allow
              </button>
              <button className="btn btn-sm btn-primary" onClick={() => respondPermission('allow')}>
                Allow <kbd className="kbd-on-primary">↵</kbd>
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
