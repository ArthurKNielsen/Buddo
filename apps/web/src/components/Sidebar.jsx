import { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Search, MessageSquare, Trash2, FolderOpen, Settings, PanelLeftClose, HardDrive, Globe, Box, Pencil, Command } from 'lucide-react';
import { useStore } from '../lib/store.js';
import Logo from './Logo.jsx';
import { href } from '../lib/paths.js';

function groupByDate(sessions) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const groups = { Today: [], Yesterday: [], 'Previous 7 days': [], Older: [] };
  for (const s of sessions) {
    const t = s.updatedAt;
    if (t >= today) groups.Today.push(s);
    else if (t >= today - 864e5) groups.Yesterday.push(s);
    else if (t >= today - 7 * 864e5) groups['Previous 7 days'].push(s);
    else groups.Older.push(s);
  }
  return Object.entries(groups).filter(([, v]) => v.length);
}

export default function Sidebar() {
  const sessions = useStore((s) => s.sessions);
  const activeId = useStore((s) => s.activeId);
  const ws = useStore((s) => s.ws);
  const running = useStore((s) => s.running);
  const { newChat, selectSession, deleteSession, renameSession, setUI, toggleUI } = useStore.getState();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(null);

  const filtered = useMemo(
    () => [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).filter((s) => !q || s.title.toLowerCase().includes(q.toLowerCase())),
    [sessions, q],
  );
  const WsIcon = ws?.type === 'server' ? HardDrive : ws?.type === 'folder' ? Globe : Box;

  return (
    <div className="sidebar">
      <div className="sb-head">
        <div className="brand">
          <Logo size={26} thinking={!!running} />
          <span className="brand-name">buddo</span>
          <span className="chip accent brand-free">free</span>
        </div>
        <button className="icon-btn sm" title="Hide sidebar (⌘B)" onClick={() => toggleUI('sidebar')}>
          <PanelLeftClose size={16} />
        </button>
      </div>

      <motion.button className="new-chat" whileHover={{ y: -1 }} whileTap={{ scale: 0.98 }} onClick={() => newChat()}>
        <Plus size={16} />
        New chat
        <span className="spacer" />
        <kbd>⌘⇧O</kbd>
      </motion.button>

      <div className="sb-search">
        <Search size={14} />
        <input placeholder="Search chats" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      <div className="sb-list">
        {!filtered.length && <div className="sb-empty">{q ? 'No matches' : 'Your chats will appear here'}</div>}
        {groupByDate(filtered).map(([label, list]) => (
          <div key={label} className="sb-group">
            <div className="sb-group-label">{label}</div>
            <AnimatePresence initial={false}>
              {list.map((s) => (
                <motion.div
                  key={s.id}
                  layout
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -10, height: 0 }}
                  transition={{ duration: 0.22 }}
                  className={'sb-item' + (s.id === activeId ? ' active' : '')}
                  onClick={() => selectSession(s.id)}
                  onDoubleClick={() => setEditing(s.id)}
                >
                  {s.id === activeId && <motion.div layoutId="sb-active" className="sb-active-bg" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
                  {running?.sessionId === s.id ? <span className="spinner" style={{ width: 12, height: 12 }} /> : <MessageSquare size={14} className="faint" />}
                  {editing === s.id ? (
                    <input
                      className="sb-rename"
                      autoFocus
                      defaultValue={s.title}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => {
                        renameSession(s.id, e.target.value.trim() || s.title);
                        setEditing(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.target.blur();
                        if (e.key === 'Escape') setEditing(null);
                      }}
                    />
                  ) : (
                    <span className="truncate">{s.title}</span>
                  )}
                  <span className="sb-actions">
                    <button
                      className="icon-btn sm"
                      title="Rename"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditing(s.id);
                      }}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      className="icon-btn sm"
                      title="Delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteSession(s.id);
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </span>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        ))}
      </div>

      <div className="sb-foot">
        <button className="ws-card" onClick={() => setUI({ folder: true })} title="Switch workspace">
          <div className="ws-icon">
            <WsIcon size={16} />
          </div>
          <div className="ws-meta">
            <div className="truncate ws-name">{ws?.name || 'No workspace'}</div>
            <div className="truncate ws-kind">{ws ? (ws.exec ? 'Local folder · shell enabled' : ws.kind) : 'Choose a folder'}</div>
          </div>
          <FolderOpen size={15} className="faint" />
        </button>
        <div className="row" style={{ gap: 4 }}>
          <button className="icon-btn" title="Settings (⌘,)" onClick={() => setUI({ settings: true })}>
            <Settings size={16} />
          </button>
          <button className="icon-btn" title="Command palette (⌘K)" onClick={() => setUI({ palette: true })}>
            <Command size={16} />
          </button>
          <span className="spacer" />
          <a className="sb-link" href={href('/')}>Homepage</a>
        </div>
      </div>
    </div>
  );
}
