import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowDown, Sparkles, Bug, FlaskConical, Rocket, BookOpen, Wand2 } from 'lucide-react';
import { useStore } from '../lib/store.js';
import { submit } from '../lib/runner.js';
import Logo from './Logo.jsx';
import Message from './Message.jsx';

const SUGGESTIONS = [
  { icon: BookOpen, title: 'Explain this project', sub: 'Architecture, entry points, how it fits together', prompt: '/explain' },
  { icon: Bug, title: 'Find & fix a bug', sub: 'Hunt down the most likely issue and patch it', prompt: '/fix look for the most likely bug and fix it' },
  { icon: FlaskConical, title: 'Run the tests', sub: 'Run tests and fix anything that fails', prompt: '/test' },
  { icon: Rocket, title: 'Build a landing page', sub: 'HTML + CSS + JS, animated and responsive', prompt: '/scaffold a modern animated landing page for a coffee shop in index.html, styles.css and script.js' },
  { icon: Wand2, title: 'Create BUDDO.md', sub: 'Teach Buddo about this codebase', prompt: '/init' },
  { icon: Sparkles, title: 'Review my changes', sub: 'Catch bugs before you commit', prompt: '/review' },
];

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Burning the midnight oil' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function Empty() {
  const ws = useStore((s) => s.ws);
  const sugg = ws?.exec ? SUGGESTIONS : SUGGESTIONS.filter((s) => s.prompt !== '/test');
  return (
    <div className="empty">
      <motion.div className="empty-logo" initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 200, damping: 15 }}>
        <div className="empty-logo-glow" />
        <Logo size={64} />
      </motion.div>
      <motion.h1 initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08 }}>
        {greeting()}. <span className="grad-text">What are we building?</span>
      </motion.h1>
      <motion.p className="muted" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.14 }}>
        Working in <b>{ws?.name || '…'}</b> · runs 100% on your machine · free forever
      </motion.p>
      <div className="sugg-grid">
        {sugg.map((s, i) => (
          <motion.button
            key={s.title}
            className="sugg"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.18 + i * 0.05, type: 'spring', stiffness: 300, damping: 24 }}
            whileHover={{ y: -3 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => submit(s.prompt)}
          >
            <div className="sugg-icon">
              <s.icon size={16} />
            </div>
            <div>
              <div className="sugg-title">{s.title}</div>
              <div className="sugg-sub">{s.sub}</div>
            </div>
          </motion.button>
        ))}
      </div>
    </div>
  );
}

export default function ChatView() {
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeId));
  const ref = useRef(null);
  const inner = useRef(null);
  const stick = useRef(true);
  const lastTop = useRef(0);
  const [showDown, setShowDown] = useState(false);
  const items = session?.items || [];

  useEffect(() => {
    stick.current = true;
    requestAnimationFrame(() => ref.current && (ref.current.scrollTop = ref.current.scrollHeight));
  }, [session?.id]);

  useEffect(() => {
    if (stick.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  });

  // Follow the conversation as it grows (cards open, code streams in), not only when the store changes.
  useEffect(() => {
    if (!inner.current || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (stick.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
    });
    ro.observe(inner.current);
    return () => ro.disconnect();
  }, []);

  const onScroll = () => {
    const el = ref.current;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    // Stop following only when the user scrolls up: content growing or shrinking also fires scroll events.
    if (dist < 80) stick.current = true;
    else if (el.scrollTop < lastTop.current - 4) stick.current = false;
    lastTop.current = el.scrollTop;
    setShowDown(dist > 300);
  };

  return (
    <div className="chat" ref={ref} onScroll={onScroll}>
      <div className="chat-inner" ref={inner}>
        {!items.length ? (
          <Empty />
        ) : (
          items.map((it, i) => <Message key={it.id} item={it} sessionId={session.id} last={i === items.length - 1} />)
        )}
        <div style={{ height: 24 }} />
      </div>
      <AnimatePresence>
        {showDown && (
          <motion.button
            className="scroll-down"
            initial={{ opacity: 0, y: 10, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.9 }}
            onClick={() => ref.current.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' })}
          >
            <ArrowDown size={16} />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
