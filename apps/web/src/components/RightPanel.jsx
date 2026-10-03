import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  FolderTree, GitCompare, TerminalSquare, ListTodo, Eye, X, RefreshCw, ChevronRight, Folder, FolderOpen, FileText, ArrowLeft, AtSign,
  MessageSquarePlus, Undo2, ExternalLink, Play, FilePlus2, Trash2, Copy,
} from 'lucide-react';
import { diffLines, diffStats } from '@buddo/core';
import { useStore } from '../lib/store.js';
import { getWorkspace, refreshFileIndex } from '../lib/engine.js';
import { buildPreview } from '../lib/workspaces.js';
import { revertChange, runUserCommand, submit } from '../lib/runner.js';
import DiffView, { CodeView } from './DiffView.jsx';
import { TodoList } from './ToolCard.jsx';

const TABS = [
  { id: 'files', icon: FolderTree, label: 'Files' },
  { id: 'changes', icon: GitCompare, label: 'Changes' },
  { id: 'terminal', icon: TerminalSquare, label: 'Terminal' },
  { id: 'tasks', icon: ListTodo, label: 'Tasks' },
  { id: 'preview', icon: Eye, label: 'Preview' },
];

function buildTree(entries) {
  const root = { children: new Map() };
  for (const e of entries) {
    const parts = e.path.split('/');
    let node = root;
    parts.forEach((p, i) => {
      if (!node.children.has(p)) node.children.set(p, { name: p, path: parts.slice(0, i + 1).join('/'), type: i === parts.length - 1 ? e.type : 'dir', children: new Map() });
      node = node.children.get(p);
    });
  }
  const sort = (n) =>
    [...n.children.values()].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return { root, sort };
}

function fileColor(name) {
  const ext = name.split('.').pop();
  return (
    { js: '#f7df1e', jsx: '#61dafb', ts: '#3178c6', tsx: '#3178c6', py: '#3776ab', css: '#a78bfa', html: '#e34f26', json: '#facc15', md: '#94a3b8', rs: '#dea584', go: '#00add8', java: '#f89820', rb: '#cc342d', vue: '#42b883', svelte: '#ff3e00' }[ext] ||
    'var(--text-3)'
  );
}

function TreeNode({ node, sort, depth, onOpen, open, toggle, changed }) {
  const isOpen = open.has(node.path);
  if (node.type === 'dir') {
    return (
      <>
        <button className="tree-row" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => toggle(node.path)}>
          <motion.span animate={{ rotate: isOpen ? 90 : 0 }} className="row" transition={{ duration: 0.15 }}>
            <ChevronRight size={13} className="faint" />
          </motion.span>
          {isOpen ? <FolderOpen size={14} className="tree-folder" /> : <Folder size={14} className="tree-folder" />}
          <span className="truncate">{node.name}</span>
        </button>
        {isOpen && sort(node).map((c) => <TreeNode key={c.path} node={c} sort={sort} depth={depth + 1} onOpen={onOpen} open={open} toggle={toggle} changed={changed} />)}
      </>
    );
  }
  return (
    <button className="tree-row" style={{ paddingLeft: 22 + depth * 14 }} onClick={() => onOpen(node.path)}>
      <FileText size={14} style={{ color: fileColor(node.name) }} />
      <span className="truncate">{node.name}</span>
      {changed.has(node.path) && <span className="tree-mod">M</span>}
    </button>
  );
}

/** Folder + file entries for a list of file paths. */
function entriesFor(paths) {
  const dirs = new Set();
  const out = [];
  for (const p of [...paths].sort()) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/');
      if (!dirs.has(d)) dirs.add(d), out.push({ path: d, type: 'dir' });
    }
    out.push({ path: p, type: 'file' });
  }
  return out;
}

function FilesTab() {
  const allEntries = useStore((s) => s.fileIndex);
  const ws = useStore((s) => s.ws);
  // A real folder is shared by every chat: show this chat's files unless asked for the whole folder.
  // (In the browser sandbox each chat already has its own folder.)
  const scope = useStore((s) => s.ui.treeScope || 'chat');
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeId));
  const viewing = useStore((s) => s.ui.viewing);
  const { setUI } = useStore.getState();
  const [open, setOpen] = useState(new Set());
  const [file, setFile] = useState(null);
  const [filter, setFilter] = useState('');
  const changed = useMemo(() => new Set((session?.changes || []).filter((c) => !c.reverted).map((c) => c.path)), [session?.changes]);
  const shared = ws?.type !== 'sandbox';
  const chatOnly = shared && scope === 'chat';
  const entries = useMemo(() => (chatOnly ? entriesFor(changed) : allEntries), [chatOnly, changed, allEntries]);

  const openFile = async (path) => {
    const kind = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(path) ? 'image' : /\.(mp4|mov|webm|m4v|mkv)$/i.test(path) ? 'video' : /\.(mp3|wav|m4a|aac|ogg|flac|opus)$/i.test(path) ? 'audio' : null;
    const ws = getWorkspace();
    if (kind) return setFile({ path, kind, url: ws.rawUrl?.(path), canSense: !!ws.media });
    try {
      setFile({ path, content: await getWorkspace().read(path) });
    } catch (e) {
      setFile({ path, content: `Cannot open: ${e.message}` });
    }
  };
  useEffect(() => {
    if (viewing) {
      openFile(viewing);
      setUI({ viewing: null });
    }
  }, [viewing]);

  const { root, sort } = useMemo(() => buildTree(entries), [entries]);
  const toggle = (p) => setOpen((s) => {
    const n = new Set(s);
    n.has(p) ? n.delete(p) : n.add(p);
    return n;
  });
  const filtered = filter ? entries.filter((e) => e.type === 'file' && e.path.toLowerCase().includes(filter.toLowerCase())).slice(0, 200) : null;

  if (file) {
    return (
      <div className="tab-pane">
        <div className="pane-bar">
          <button className="icon-btn sm" onClick={() => setFile(null)} title="Back">
            <ArrowLeft size={15} />
          </button>
          <span className="mono truncate pane-path">{file.path}</span>
          <span className="spacer" />
          <button className="icon-btn sm" title="Copy" onClick={() => navigator.clipboard?.writeText(file.content)}>
            <Copy size={14} />
          </button>
          <button className="icon-btn sm" title="Mention in chat" onClick={() => useStore.setState({ composerInsert: { text: '@' + file.path } })}>
            <AtSign size={14} />
          </button>
          <button className="icon-btn sm" title="Explain this file" onClick={() => submit(`/explain @${file.path}`)}>
            <MessageSquarePlus size={14} />
          </button>
        </div>
        <div className="pane-scroll">
          {file.kind ? (
            <div className="file-preview">
              {!file.url ? (
                <div className="faint">Preview needs the desktop app or local mode.</div>
              ) : file.kind === 'image' ? (
                <img src={file.url} alt={file.path} />
              ) : file.kind === 'video' ? (
                <video src={file.url} controls playsInline />
              ) : (
                <audio src={file.url} controls />
              )}
              {file.canSense && (
                <button
                  className="btn btn-primary"
                  onClick={() =>
                    submit(
                      file.kind === 'image'
                        ? `Look at @${file.path} and describe it in detail.`
                        : file.kind === 'video'
                          ? `Watch @${file.path} and tell me what happens — what you see and what you hear, with timestamps.`
                          : `Listen to @${file.path}: transcribe it with timestamps and describe any sounds or music.`,
                    )
                  }
                >
                  {file.kind === 'image' ? 'Ask Buddo to look at it' : file.kind === 'video' ? 'Ask Buddo to watch it' : 'Ask Buddo to listen'}
                </button>
              )}
            </div>
          ) : (
            <CodeView content={file.content} path={file.path} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="tab-pane">
      <div className="pane-bar">
        {shared && (
          <div className="seg tree-scope" title="Which files to show">
            {[
              ['chat', 'This chat'],
              ['all', 'All files'],
            ].map(([id, l]) => (
              <button key={id} className={scope === id ? 'on' : ''} onClick={() => setUI({ treeScope: id })}>
                {scope === id && <motion.div layoutId="tree-scope-pill" className="seg-pill" />}
                {l}
              </button>
            ))}
          </div>
        )}
        <input className="pane-filter" placeholder={`Filter ${entries.filter((e) => e.type === 'file').length} files…`} value={filter} onChange={(e) => setFilter(e.target.value)} />
        {!ws?.exec && ws?.type === 'sandbox' && (
          <button
            className="icon-btn sm"
            title="New file"
            onClick={async () => {
              const name = prompt('File name (e.g. src/app.js)');
              if (name) {
                useStore.getState().ensureSession();
                await getWorkspace().write(name, '');
                refreshFileIndex();
              }
            }}
          >
            <FilePlus2 size={14} />
          </button>
        )}
        <button className="icon-btn sm" title="Refresh" onClick={refreshFileIndex}>
          <RefreshCw size={14} />
        </button>
      </div>
      <div className="pane-scroll tree">
        {!entries.length && (
          <div className="pane-empty">
            <FolderTree size={28} />
            <p>{chatOnly ? 'No files from this chat yet.' : 'No files yet.'}</p>
            <span className="faint">
              {ws?.type === 'sandbox' ? 'Each chat has its own files. Ask Buddo to build something and they appear here.' : chatOnly ? 'Files Buddo creates or changes in this chat show up here.' : 'This folder is empty.'}
            </span>
            {chatOnly && allEntries.length > 0 && (
              <button className="btn btn-outline btn-sm" style={{ marginTop: 10 }} onClick={() => setUI({ treeScope: 'all' })}>
                Show all files in the folder
              </button>
            )}
          </div>
        )}
        {filtered
          ? filtered.map((e) => (
              <button key={e.path} className="tree-row" style={{ paddingLeft: 10 }} onClick={() => openFile(e.path)}>
                <FileText size={14} style={{ color: fileColor(e.path) }} />
                <span className="truncate mono" style={{ fontSize: 12 }}>
                  {e.path}
                </span>
              </button>
            ))
          : sort(root).map((n) => <TreeNode key={n.path} node={n} sort={sort} depth={0} onOpen={openFile} open={open} toggle={toggle} changed={changed} />)}
      </div>
    </div>
  );
}

function ChangesTab() {
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeId));
  const [open, setOpen] = useState(null);
  const changes = (session?.changes || []).filter((c) => !c.reverted);
  const totals = changes.reduce(
    (acc, c) => {
      const s = diffStats(diffLines(c.original || '', c.current));
      return { a: acc.a + s.added, d: acc.d + s.removed };
    },
    { a: 0, d: 0 },
  );
  if (!changes.length) {
    return (
      <div className="pane-empty">
        <GitCompare size={28} />
        <p>No changes yet</p>
        <span className="faint">Every file Buddo edits shows up here with a diff — revert anything in one click.</span>
      </div>
    );
  }
  return (
    <div className="tab-pane">
      <div className="pane-bar">
        <span className="pane-count">
          {changes.length} file{changes.length > 1 ? 's' : ''} changed <span className="add">+{totals.a}</span> <span className="del">−{totals.d}</span>
        </span>
        <span className="spacer" />
        <button
          className="btn btn-sm btn-danger"
          onClick={async () => {
            if (confirm('Revert all changes Buddo made in this chat?')) for (const c of changes) await revertChange(session.id, c.path);
          }}
        >
          <Undo2 size={13} /> Revert all
        </button>
      </div>
      <div className="pane-scroll">
        {changes.map((c) => {
          const s = diffStats(diffLines(c.original || '', c.current));
          const isOpen = open === c.path;
          return (
            <motion.div layout key={c.path} className="change">
              <button className="change-head" onClick={() => setOpen(isOpen ? null : c.path)}>
                <motion.span animate={{ rotate: isOpen ? 90 : 0 }} className="row">
                  <ChevronRight size={13} />
                </motion.span>
                <span className="mono truncate">{c.path}</span>
                {c.original == null && <span className="chip accent">new</span>}
                <span className="spacer" />
                <span className="diff-stats">
                  <span className="add">+{s.added}</span>
                  <span className="del">−{s.removed}</span>
                </span>
                <span
                  className="icon-btn sm"
                  role="button"
                  title="Revert this file"
                  onClick={(e) => {
                    e.stopPropagation();
                    revertChange(session.id, c.path);
                  }}
                >
                  <Undo2 size={13} />
                </span>
              </button>
              <AnimatePresence initial={false}>
                {isOpen && (
                  <motion.div initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }} style={{ overflow: 'hidden' }}>
                    <DiffView before={c.original || ''} after={c.current} path={c.path} />
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

function TerminalTab() {
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeId));
  const ws = useStore((s) => s.ws);
  const [cmd, setCmd] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef(null);
  const log = session?.terminal || [];
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [log.length, log[log.length - 1]?.output]);

  if (!ws?.exec) {
    return (
      <div className="pane-empty">
        <TerminalSquare size={28} />
        <p>Terminal needs the local app</p>
        <span className="faint">
          Browsers can't run shell commands. Run <code>npx buddo web</code> or <code>npm start</code> in your project, or use the desktop app — then Buddo can run tests, builds and git.
        </span>
      </div>
    );
  }
  return (
    <div className="tab-pane term-pane">
      <div className="pane-scroll term-log">
        {!log.length && <div className="faint" style={{ padding: 12 }}>Commands Buddo runs show up here. You can run your own below.</div>}
        {log.map((t) => (
          <div key={t.id} className="term-entry">
            <div className="term-cmd">
              <span className="term-prompt">{t.source === 'agent' ? '◆' : '$'}</span> {t.command}
              {t.code === null && <span className="spinner" style={{ width: 11, height: 11 }} />}
              {t.code !== null && t.code !== undefined && <span className={t.code === 0 ? 'term-ok' : 'term-bad'}>{t.code === 0 ? '✓' : `✗ ${t.code}`}</span>}
            </div>
            {t.output && <pre>{t.output.slice(-20000)}</pre>}
          </div>
        ))}
        <div ref={end} />
      </div>
      <form
        className="term-input"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!cmd.trim() || busy) return;
          const c = cmd;
          setCmd('');
          setBusy(true);
          try {
            await runUserCommand(c);
          } finally {
            setBusy(false);
          }
        }}
      >
        <span className="term-prompt">$</span>
        <input value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder={busy ? 'running…' : 'run a command'} disabled={busy} />
        <button className="icon-btn sm" disabled={busy}>
          <Play size={13} />
        </button>
      </form>
    </div>
  );
}

function TasksTab() {
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeId));
  const todos = session?.todos || [];
  const done = todos.filter((t) => t.status === 'done').length;
  if (!todos.length) {
    return (
      <div className="pane-empty">
        <ListTodo size={28} />
        <p>No plan yet</p>
        <span className="faint">For bigger tasks Buddo writes a step-by-step plan and checks items off live.</span>
      </div>
    );
  }
  return (
    <div className="tab-pane">
      <div className="tasks-head">
        <div className="row">
          <b>Progress</b>
          <span className="spacer" />
          <span className="faint">
            {done}/{todos.length}
          </span>
        </div>
        <div className="progress">
          <div style={{ width: `${(done / todos.length) * 100}%` }} />
        </div>
      </div>
      <div className="pane-scroll" style={{ padding: '4px 10px' }}>
        <TodoList todos={todos} />
      </div>
    </div>
  );
}

function PreviewTab() {
  const ws = useStore((s) => s.ws);
  const fileIndex = useStore((s) => s.fileIndex);
  const previewPath = useStore((s) => s.previewPath);
  const [html, setHtml] = useState(undefined);
  const [key, setKey] = useState(0);
  // While Buddo is writing an HTML/CSS/JS file, render its half-written content live.
  const live = useStore((s) => {
    const sess = s.sessions.find((x) => x.id === s.activeId);
    const it = s.running && sess?.items[sess.items.length - 1];
    const l = it?.live;
    return l?.name === 'write_file' && /\.(html?|css|js)$/i.test(l.args?.path || '') && l.args.content ? l : null;
  });
  const liveKey = live ? `${live.args.path}:${Math.floor(live.args.content.length / 120)}` : '';
  const entry = live && /\.html?$/i.test(live.args.path) ? live.args.path.replace(/^\.?\//, '') : previewPath;
  const load = async () => setHtml(await buildPreview(getWorkspace(), entry, live ? { [live.args.path]: live.args.content } : {}).catch(() => null));
  useEffect(() => {
    load();
  }, [ws?.root, fileIndex, liveKey, entry]);
  return (
    <div className="tab-pane">
      <div className="pane-bar">
        <span className="faint" style={{ fontSize: 12 }}>
          {live ? (
            <span className="row" style={{ gap: 6 }}>
              <span className="live-dot">LIVE</span> building {live.args.path}…
            </span>
          ) : (
            `Live preview of ${entry || 'index.html'}`
          )}
        </span>
        <span className="spacer" />
        <button
          className="icon-btn sm"
          title="Reload"
          onClick={() => {
            load();
            setKey((k) => k + 1);
          }}
        >
          <RefreshCw size={14} />
        </button>
        <button
          className="icon-btn sm"
          title="Open in new tab"
          disabled={!html}
          onClick={() => window.open(URL.createObjectURL(new Blob([html], { type: 'text/html' })), '_blank')}
        >
          <ExternalLink size={14} />
        </button>
      </div>
      {html ? (
        <iframe key={key} className="preview-frame" sandbox="allow-scripts allow-forms allow-modals allow-popups" srcDoc={html} title="Preview" />
      ) : (
        <div className="pane-empty">
          <Eye size={28} />
          <p>Nothing to preview</p>
          <span className="faint">When the project has an index.html, Buddo renders it here live — try “build me a landing page”.</span>
        </div>
      )}
    </div>
  );
}

export default function RightPanel() {
  const tab = useStore((s) => s.ui.tab);
  const ws = useStore((s) => s.ws);
  const { setUI } = useStore.getState();
  return (
    <div className="panel">
      <div className="panel-tabs">
        {TABS.map((t) => (
          <button key={t.id} className={'panel-tab' + (tab === t.id ? ' on' : '')} onClick={() => setUI({ tab: t.id })}>
            {tab === t.id && <motion.div layoutId="panel-tab" className="panel-tab-bg" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
            <t.icon size={14} />
            <span>{t.label}</span>
          </button>
        ))}
        <span className="spacer" />
        {ws?.type === 'sandbox' && tab === 'files' && (
          <button
            className="icon-btn sm"
            title="Delete this chat's files"
            onClick={() => {
              if (confirm("Delete all of this chat's files?")) {
                getWorkspace().clear?.();
                refreshFileIndex();
              }
            }}
          >
            <Trash2 size={14} />
          </button>
        )}
        <button className="icon-btn sm" onClick={() => setUI({ panel: false })}>
          <X size={15} />
        </button>
      </div>
      <AnimatePresence mode="wait">
        <motion.div key={tab} className="panel-body" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }} transition={{ duration: 0.16 }}>
          {tab === 'files' && <FilesTab />}
          {tab === 'changes' && <ChangesTab />}
          {tab === 'terminal' && <TerminalTab />}
          {tab === 'tasks' && <TasksTab />}
          {tab === 'preview' && <PreviewTab />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
