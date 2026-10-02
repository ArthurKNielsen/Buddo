import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowUp, Square, Paperclip, X, ShieldCheck, Zap, Flame, Map as MapIcon, FileText, Slash, AtSign } from 'lucide-react';
import { SLASH_COMMANDS, contextTokens } from '@buddo/core';
import { useStore } from '../lib/store.js';
import { submit, stop } from '../lib/runner.js';

export const MODES = [
  { id: 'ask', label: 'Ask', icon: ShieldCheck, tip: 'Approve every edit and command' },
  { id: 'auto', label: 'Auto', icon: Zap, tip: 'Auto-approve edits, ask before commands' },
  { id: 'yolo', label: 'YOLO', icon: Flame, tip: 'Approve everything automatically' },
  { id: 'plan', label: 'Plan', icon: MapIcon, tip: 'Read-only: investigate and plan' },
];

function fuzzy(q, s) {
  q = q.toLowerCase();
  s = s.toLowerCase();
  if (!q) return 1;
  if (s.includes(q)) return 2 + (s.endsWith(q) ? 1 : 0) - s.length / 1000;
  let i = 0;
  for (const ch of s) if (ch === q[i]) i++;
  return i === q.length ? 1 - s.length / 1000 : 0;
}

function ContextRing({ used, total }) {
  const pct = Math.min(1, used / total);
  const r = 8;
  const c = 2 * Math.PI * r;
  const color = pct > 0.85 ? 'var(--danger)' : pct > 0.6 ? 'var(--warn)' : 'var(--accent)';
  return (
    <div className="ctx-ring" title={`Context: ~${used.toLocaleString()} / ${total.toLocaleString()} tokens. Use /compact to free space.`}>
      <svg width="22" height="22" viewBox="0 0 22 22">
        <circle cx="11" cy="11" r={r} stroke="var(--border-2)" strokeWidth="2.5" fill="none" />
        <motion.circle
          cx="11"
          cy="11"
          r={r}
          stroke={color}
          strokeWidth="2.5"
          fill="none"
          strokeLinecap="round"
          strokeDasharray={c}
          animate={{ strokeDashoffset: c * (1 - pct) }}
          transform="rotate(-90 11 11)"
        />
      </svg>
      <span>{Math.round(pct * 100)}%</span>
    </div>
  );
}

export default function Composer() {
  const [text, setText] = useState('');
  const [caretPos, setCaretPos] = useState(null);
  const [files, setFiles] = useState([]);
  const [menuIdx, setMenuIdx] = useState(0);
  const [focused, setFocused] = useState(false);
  const [drag, setDrag] = useState(false);
  const ta = useRef(null);
  const fileInput = useRef(null);
  const settings = useStore((s) => s.settings);
  const running = useStore((s) => s.running);
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeId));
  const fileIndex = useStore((s) => s.fileIndex);
  const insert = useStore((s) => s.composerInsert);
  const ws = useStore((s) => s.ws);
  const { setSettings } = useStore.getState();

  const busy = !!running && running.sessionId === session?.id;
  const budget = settings.engine === 'webllm' ? 8192 : settings.ctx;
  const used = useMemo(() => (session ? contextTokens(session.history) + 2600 : 0), [session?.history]);

  // Autosize
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = Math.min(el.scrollHeight, 260) + 'px';
  }, [text]);

  useEffect(() => {
    ta.current?.focus();
  }, [session?.id]);

  useEffect(() => {
    if (!insert) return;
    setText((t) => (insert.replace ? insert.text : (t ? t.trimEnd() + ' ' : '') + insert.text));
    setCaretPos(null);
    useStore.setState({ composerInsert: null });
    setTimeout(() => ta.current?.focus(), 0);
  }, [insert]);

  // Which popover? "/cmd" at start, or "@path" token at cursor.
  // Read from state, not the DOM: during render the textarea still holds the previous value.
  const caret = Math.min(caretPos ?? text.length, text.length);
  const before = text.slice(0, caret);
  const slashMatch = /^\/([a-z-]*)$/i.exec(before);
  const atMatch = /(?:^|\s)@([\w./-]*)$/.exec(before);

  const menu = useMemo(() => {
    if (slashMatch) {
      const q = slashMatch[1];
      return {
        type: 'slash',
        items: SLASH_COMMANDS.map((c) => ({ c, score: fuzzy(q, c.name) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).map((x) => x.c),
      };
    }
    if (atMatch) {
      const q = atMatch[1];
      const items = fileIndex
        .filter((e) => e.type === 'file')
        .map((e) => ({ path: e.path, score: fuzzy(q, e.path) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);
      return { type: 'file', items };
    }
    return null;
  }, [slashMatch?.[1], atMatch?.[1], fileIndex]);

  useEffect(() => setMenuIdx(0), [menu?.type, menu?.items.length]);

  const choose = (item) => {
    if (menu.type === 'slash') {
      const next = `/${item.name}${item.arg ? ' ' : ''}`;
      setText(next + text.slice(caret));
      setCaretPos(next.length);
      if (!item.arg && (item.action || item.prompt)) setTimeout(() => doSubmit(`/${item.name}`), 0);
    } else {
      const start = before.lastIndexOf('@');
      const head = text.slice(0, start) + '@' + item.path + ' ';
      setText(head + text.slice(caret));
      setCaretPos(head.length);
    }
    ta.current?.focus();
  };

  const doSubmit = (value = text) => {
    if (busy) return;
    if (!value.trim() && !files.length) return;
    submit(value, files);
    setText('');
    setCaretPos(null);
    setFiles([]);
  };

  const onKey = (e) => {
    if (menu?.items.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        return setMenuIdx((i) => (i + 1) % menu.items.length);
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        return setMenuIdx((i) => (i - 1 + menu.items.length) % menu.items.length);
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        return choose(menu.items[menuIdx]);
      }
    }
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      const i = MODES.findIndex((m) => m.id === settings.mode);
      return setSettings({ mode: MODES[(i + 1) % MODES.length].id });
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      doSubmit();
    }
    if (e.key === 'ArrowUp' && !text && session) {
      const lastUser = [...session.items].reverse().find((i) => i.type === 'user');
      if (lastUser) {
        e.preventDefault();
        setText(lastUser.text);
        setCaretPos(null);
      }
    }
  };

  const addFiles = async (list) => {
    const out = [];
    for (const f of list) {
      if (f.size > 2_000_000) continue;
      try {
        out.push({ name: f.name, content: await f.text() });
      } catch {}
    }
    setFiles((x) => [...x, ...out]);
  };

  return (
    <div className="composer-wrap">
      <div className="composer-inner">
        <AnimatePresence>
          {menu?.items.length > 0 && (
            <motion.div
              className="popover"
              initial={{ opacity: 0, y: 8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }}
              transition={{ duration: 0.16 }}
            >
              <div className="popover-title">
                {menu.type === 'slash' ? <Slash size={12} /> : <AtSign size={12} />}
                {menu.type === 'slash' ? 'Commands' : 'Mention a file'}
              </div>
              {menu.items.map((it, i) => (
                <button
                  key={menu.type === 'slash' ? it.name : it.path}
                  className={'pop-item' + (i === menuIdx ? ' on' : '')}
                  onMouseEnter={() => setMenuIdx(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(it);
                  }}
                >
                  {i === menuIdx && <motion.div layoutId="pop-hl" className="pop-hl" transition={{ type: 'spring', stiffness: 600, damping: 40 }} />}
                  {menu.type === 'slash' ? (
                    <>
                      <span className="pop-cmd mono">/{it.name}</span>
                      {it.arg && <span className="faint mono">&lt;{it.arg}&gt;</span>}
                      <span className="spacer" />
                      <span className="faint">{it.desc}</span>
                    </>
                  ) : (
                    <>
                      <FileText size={13} className="faint" />
                      <span className="mono truncate">{it.path}</span>
                    </>
                  )}
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        <motion.div
          className={'composer' + (focused ? ' focused' : '') + (drag ? ' drag' : '') + (busy ? ' busy' : '')}
          layout
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            addFiles([...e.dataTransfer.files]);
          }}
        >
          <AnimatePresence>
            {files.length > 0 && (
              <motion.div className="attachments" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
                {files.map((f, i) => (
                  <motion.span key={f.name + i} className="chip" initial={{ scale: 0.8 }} animate={{ scale: 1 }}>
                    <FileText size={12} /> {f.name}
                    <button onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                      <X size={12} />
                    </button>
                  </motion.span>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
          <textarea
            ref={ta}
            rows={1}
            value={text}
            placeholder={busy ? 'Buddo is working… (esc to stop)' : `Ask Buddo to build, fix or explain anything in ${ws?.name || 'your project'}…  (/ commands · @ files)`}
            onChange={(e) => {
              setText(e.target.value);
              setCaretPos(e.target.selectionStart);
            }}
            onSelect={(e) => setCaretPos(e.target.selectionStart)}
            onKeyDown={onKey}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onPaste={(e) => {
              const fs = [...(e.clipboardData?.files || [])];
              if (fs.length) {
                e.preventDefault();
                addFiles(fs);
              }
            }}
          />
          <div className="composer-bar">
            <div className="seg" title="Shift+Tab to cycle">
              {MODES.map((m) => (
                <button key={m.id} className={settings.mode === m.id ? 'on' : ''} onClick={() => setSettings({ mode: m.id })} title={m.tip}>
                  {settings.mode === m.id && <motion.div layoutId="mode-pill" className={`seg-pill mode-${m.id}`} transition={{ type: 'spring', stiffness: 500, damping: 35 }} />}
                  <m.icon size={13} />
                  {m.label}
                </button>
              ))}
            </div>
            <span className="spacer" />
            {session?.history.length > 0 && <ContextRing used={used} total={budget} />}
            <button className="icon-btn" title="Attach files" onClick={() => fileInput.current?.click()}>
              <Paperclip size={16} />
            </button>
            <input ref={fileInput} type="file" multiple hidden onChange={(e) => addFiles([...e.target.files])} />
            <AnimatePresence mode="wait" initial={false}>
              {busy ? (
                <motion.button key="stop" className="send stop" onClick={stop} initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }} title="Stop (esc)">
                  <Square size={13} fill="currentColor" />
                </motion.button>
              ) : (
                <motion.button
                  key="send"
                  className="send"
                  disabled={!text.trim() && !files.length}
                  onClick={() => doSubmit()}
                  initial={{ scale: 0.6, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.6, opacity: 0 }}
                  whileTap={{ scale: 0.9 }}
                  title="Send (enter)"
                >
                  <ArrowUp size={17} strokeWidth={2.5} />
                </motion.button>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
        <div className="composer-hint faint">
          Buddo runs locally — your code never leaves your machine. <kbd>⇧</kbd>+<kbd>tab</kbd> modes · <kbd>⌘K</kbd> commands
        </div>
      </div>
    </div>
  );
}
