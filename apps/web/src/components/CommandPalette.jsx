import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Search, Plus, PanelLeft, PanelRight, FolderOpen, Cpu, Settings, SunMoon, ShieldCheck, Zap, Flame, Map as MapIcon, MessageSquare, Slash, Keyboard, Home, FileText,
} from 'lucide-react';
import { SLASH_COMMANDS } from '@buddo/core';
import { useStore } from '../lib/store.js';
import { submit } from '../lib/runner.js';

export default function CommandPalette() {
  const open = useStore((s) => s.ui.palette);
  const sessions = useStore((s) => s.sessions);
  const fileIndex = useStore((s) => s.fileIndex);
  const settings = useStore((s) => s.settings);
  const st = useStore.getState();
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const input = useRef(null);
  const close = () => st.setUI({ palette: false });

  useEffect(() => {
    if (open) {
      setQ('');
      setIdx(0);
      setTimeout(() => input.current?.focus(), 10);
    }
  }, [open]);

  const actions = useMemo(() => {
    const a = [
      { group: 'Actions', icon: Plus, label: 'New chat', hint: '⌘⇧O', run: () => st.newChat() },
      { group: 'Actions', icon: FolderOpen, label: 'Open folder…', run: () => st.setUI({ folder: true }) },
      { group: 'Actions', icon: Cpu, label: 'Switch model…', run: () => st.setUI({ models: true }) },
      { group: 'Actions', icon: PanelLeft, label: 'Toggle sidebar', hint: '⌘B', run: () => st.toggleUI('sidebar') },
      { group: 'Actions', icon: PanelRight, label: 'Toggle side panel', hint: '⌘J', run: () => st.toggleUI('panel') },
      { group: 'Actions', icon: SunMoon, label: `Switch to ${settings.theme === 'dark' ? 'light' : 'dark'} theme`, run: () => st.setSettings({ theme: settings.theme === 'dark' ? 'light' : 'dark' }) },
      { group: 'Actions', icon: Settings, label: 'Settings', hint: '⌘,', run: () => st.setUI({ settings: true }) },
      { group: 'Actions', icon: Keyboard, label: 'Keyboard shortcuts & commands', run: () => st.setUI({ help: true }) },
      { group: 'Actions', icon: Home, label: 'Go to buddo homepage', run: () => (location.href = '/') },
      { group: 'Mode', icon: ShieldCheck, label: 'Mode: Ask before changes', run: () => st.setSettings({ mode: 'ask' }) },
      { group: 'Mode', icon: Zap, label: 'Mode: Auto-accept edits', run: () => st.setSettings({ mode: 'auto' }) },
      { group: 'Mode', icon: Flame, label: 'Mode: YOLO (approve everything)', run: () => st.setSettings({ mode: 'yolo' }) },
      { group: 'Mode', icon: MapIcon, label: 'Mode: Plan (read-only)', run: () => st.setSettings({ mode: 'plan' }) },
      ...SLASH_COMMANDS.filter((c) => c.prompt && !c.arg).map((c) => ({ group: 'Commands', icon: Slash, label: `/${c.name} — ${c.desc}`, run: () => submit('/' + c.name) })),
      ...SLASH_COMMANDS.filter((c) => c.arg).map((c) => ({
        group: 'Commands',
        icon: Slash,
        label: `/${c.name} — ${c.desc}`,
        run: () => useStore.setState({ composerInsert: { text: `/${c.name} `, replace: true } }),
      })),
      ...sessions.slice(0, 30).map((s) => ({ group: 'Chats', icon: MessageSquare, label: s.title, run: () => st.selectSession(s.id) })),
    ];
    if (q.length > 1)
      a.push(
        ...fileIndex
          .filter((e) => e.type === 'file')
          .slice(0, 3000)
          .map((e) => ({
            group: 'Files',
            icon: FileText,
            label: e.path,
            run: () => {
              st.setUI({ viewing: e.path });
              st.openPanel('files');
            },
          })),
      );
    return a;
  }, [sessions, settings.theme, fileIndex, q.length > 1]);

  const filtered = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return actions.filter((a) => words.every((w) => a.label.toLowerCase().includes(w))).slice(0, 60);
  }, [q, actions]);

  useEffect(() => setIdx(0), [q]);

  const run = (a) => {
    close();
    setTimeout(a.run, 30);
  };

  const onKey = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIdx((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter' && filtered[idx]) {
      e.preventDefault();
      run(filtered[idx]);
    } else if (e.key === 'Escape') close();
  };

  useEffect(() => {
    document.querySelector('.pal-item.on')?.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  let lastGroup = '';
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="overlay pal-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(e) => e.target === e.currentTarget && close()}>
          <motion.div
            className="palette"
            initial={{ opacity: 0, scale: 0.96, y: -12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: -8 }}
            transition={{ type: 'spring', stiffness: 500, damping: 34 }}
          >
            <div className="pal-search">
              <Search size={17} className="faint" />
              <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder="Type a command, chat or file…" />
              <kbd>esc</kbd>
            </div>
            <div className="pal-list">
              {!filtered.length && <div className="pal-empty">No results</div>}
              {filtered.map((a, i) => {
                const header = a.group !== lastGroup ? (lastGroup = a.group) : null;
                return (
                  <div key={a.group + a.label + i}>
                    {header && <div className="pal-group">{header}</div>}
                    <button className={'pal-item' + (i === idx ? ' on' : '')} onMouseMove={() => setIdx(i)} onClick={() => run(a)}>
                      {i === idx && <motion.div layoutId="pal-hl" className="pal-hl" transition={{ type: 'spring', stiffness: 700, damping: 45 }} />}
                      <a.icon size={15} />
                      <span className="truncate">{a.label}</span>
                      <span className="spacer" />
                      {a.hint && <kbd>{a.hint}</kbd>}
                    </button>
                  </div>
                );
              })}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
