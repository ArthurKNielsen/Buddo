import { memo, useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Brain, ChevronRight, Copy, Check, RotateCcw, AlertTriangle, Square, Paperclip, Info } from 'lucide-react';
import { renderMarkdown, handleCopyClick } from '../lib/markdown.js';
import { useStore } from '../lib/store.js';
import { retryLast } from '../lib/runner.js';
import ToolCard from './ToolCard.jsx';
import LiveCode from './LiveCode.jsx';
import Logo from './Logo.jsx';

const enter = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  transition: { type: 'spring', stiffness: 380, damping: 32 },
};

const Markdown = memo(function Markdown({ text }) {
  return <div className="md" onClick={handleCopyClick} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
});

function Thinking({ part, live }) {
  const show = useStore((s) => s.settings.showThinking);
  const [open, setOpen] = useState(false);
  const secs = Math.max(1, Math.round(((part.endedAt || Date.now()) - part.startedAt) / 1000));
  if (!show && part.done) return null;
  return (
    <div className="thinking">
      <button className="thinking-head" onClick={() => setOpen(!open)}>
        <Brain size={14} />
        {part.done ? <span>Thought for {secs}s</span> : <span className="shimmer">Thinking…</span>}
        <motion.span animate={{ rotate: open ? 90 : 0 }} className="row">
          <ChevronRight size={14} />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {(open || (live && !part.done && show)) && (
          <motion.div
            className="thinking-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25 }}
          >
            <div className="thinking-text">{part.text.trim().slice(open ? 0 : -600)}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const VERBS = ['Thinking', 'Cooking', 'Pondering', 'Brewing', 'Scheming', 'Crafting', 'Vibing', 'Noodling'];

function Working({ item }) {
  const [verb] = useState(() => VERBS[Math.floor(Math.random() * VERBS.length)]);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = Math.floor((Date.now() - item.startedAt) / 1000);
  const label = item.preparing ? (item.preparing === 'write_file' || item.preparing === 'edit_file' ? 'Writing code' : 'Preparing tool') : verb;
  return (
    <motion.div className="working" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <span className="working-orb" />
      <span className="shimmer">{label}…</span>
      <span className="faint">
        {secs}s · <kbd>esc</kbd> to stop
      </span>
    </motion.div>
  );
}

function CopyButton({ text }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      className="icon-btn sm"
      title="Copy"
      onClick={() => {
        navigator.clipboard?.writeText(text);
        setOk(true);
        setTimeout(() => setOk(false), 1200);
      }}
    >
      {ok ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

function Assistant({ item, sessionId, last }) {
  const running = useStore((s) => s.running?.sessionId === sessionId) && item.status === 'streaming';
  const lastPart = item.parts[item.parts.length - 1];
  const showWorking =
    running &&
    (item.preparing ||
      !lastPart ||
      (lastPart.type === 'tool' && ['done', 'error', 'denied'].includes(lastPart.status)) ||
      (lastPart.type === 'thinking' && lastPart.done));
  const text = item.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n\n');
  const secs = item.endedAt ? ((item.endedAt - item.startedAt) / 1000).toFixed(1) : null;

  return (
    <motion.div className="msg assistant" {...enter}>
      <div className="avatar">
        <Logo size={26} animated={false} thinking={running} />
      </div>
      <div className="msg-body">
        {item.parts.map((p, i) =>
          p.type === 'text' ? (
            <Markdown key={i} text={p.text} />
          ) : p.type === 'thinking' ? (
            <Thinking key={i} part={p} live={running} />
          ) : (
            <ToolCard key={p.call.id} part={p} sessionId={sessionId} />
          ),
        )}
        {running && item.live ? <LiveCode live={item.live} /> : showWorking && <Working item={item} />}
        {item.status === 'error' && (
          <motion.div className="msg-error" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
            <AlertTriangle size={15} />
            <span>{item.error}</span>
            {last && (
              <button className="btn btn-sm btn-outline" onClick={retryLast}>
                <RotateCcw size={13} /> Retry
              </button>
            )}
          </motion.div>
        )}
        {item.status === 'stopped' && (
          <div className="msg-stopped">
            <Square size={11} /> Stopped
          </div>
        )}
        {!running && item.status !== 'streaming' && (
          <div className="msg-meta">
            {text && <CopyButton text={text} />}
            {last && (
              <button className="icon-btn sm" title="Retry" onClick={retryLast}>
                <RotateCcw size={13} />
              </button>
            )}
            <span className="faint">
              {item.model?.replace(/-q4f16_1-MLC$/, '')}
              {secs && ` · ${secs}s`}
              {item.usage?.tps ? ` · ${Math.round(item.usage.tps)} tok/s` : ''}
            </span>
          </div>
        )}
      </div>
    </motion.div>
  );
}

function Message({ item, sessionId, last }) {
  if (item.type === 'user') {
    return (
      <motion.div className="msg user" {...enter}>
        <div className="user-bubble">
          {item.images?.length > 0 && (
            <div className="user-images">
              {item.images.map((src, i) => (
                <img key={i} src={src} alt="attachment" />
              ))}
            </div>
          )}
          <div className="user-text">{item.text}</div>
          {item.attachments?.length > 0 && (
            <div className="user-attach">
              {item.attachments.map((a) => (
                <span key={a} className="chip">
                  <Paperclip size={11} /> {a}
                </span>
              ))}
            </div>
          )}
        </div>
      </motion.div>
    );
  }
  if (item.type === 'notice') {
    return (
      <motion.div className="notice" {...enter}>
        <Info size={13} /> {item.text}
      </motion.div>
    );
  }
  return <Assistant item={item} sessionId={sessionId} last={last} />;
}

export default memo(Message);
