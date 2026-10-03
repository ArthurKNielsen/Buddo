import { memo, useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Brain, ChevronRight, Copy, Check, RotateCcw, AlertTriangle, Square, Paperclip, Info, Activity } from 'lucide-react';
import { renderMarkdown, handleCopyClick } from '../lib/markdown.js';
import { useStore } from '../lib/store.js';
import { retryLast } from '../lib/runner.js';
import { shortModel, precisionOf } from '../lib/engine.js';
import ToolCard from './ToolCard.jsx';
import LiveCode from './LiveCode.jsx';
import Logo from './Logo.jsx';
import ActivityBar, { ActivityLog } from './Activity.jsx';

const enter = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  transition: { type: 'spring', stiffness: 380, damping: 32 },
};

const Markdown = memo(function Markdown({ text, fold = false }) {
  return <div className="md" onClick={handleCopyClick} dangerouslySetInnerHTML={{ __html: renderMarkdown(text, { fold }) }} />;
});

function Thinking({ part, live }) {
  const show = useStore((s) => s.settings.showThinking);
  // Short thoughts (a quick plan) stay visible; long reasoning collapses when done.
  const [openState, setOpen] = useState(null);
  const open = openState ?? (part.done && part.text.trim().length < 400);
  const textRef = useRef(null);
  const following = live && !part.done;
  useEffect(() => {
    if (following && textRef.current) textRef.current.scrollTop = textRef.current.scrollHeight;
  }, [part.text, following]);
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
        {(open || following) && (
          <motion.div
            className="thinking-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25 }}
          >
            <div className="thinking-text" ref={textRef}>
              {part.text.trim()}
              {following && <span className="live-caret" />}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
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
  // The reply's code was saved into files: fold the full script the model wrote (the change cards show what changed).
  const fold = !running && item.parts.some((p) => p.type === 'tool' && p.call?.auto && !p.call.quick && p.status === 'done');
  const [showLog, setShowLog] = useState(false);
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
            <Markdown key={i} text={p.text} fold={fold} />
          ) : p.type === 'note' ? (
            <div key={i} className="msg-note">
              <Info size={12} /> {p.text}
            </div>
          ) : p.type === 'thinking' ? (
            <Thinking key={i} part={p} live={running} />
          ) : (
            <ToolCard key={p.call.id} part={p} sessionId={sessionId} />
          ),
        )}
        {running && item.live && <LiveCode live={item.live} />}
        {running && <ActivityBar item={item} />}
        <AnimatePresence initial={false}>
          {!running && showLog && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} style={{ overflow: 'hidden' }}>
              <ActivityLog steps={item.steps} />
            </motion.div>
          )}
        </AnimatePresence>
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
            {item.steps?.length > 0 && (
              <button className={'icon-btn sm' + (showLog ? ' on' : '')} title="What the model did, step by step" onClick={() => setShowLog(!showLog)}>
                <Activity size={13} />
              </button>
            )}
            {last && (
              <button className="icon-btn sm" title="Retry" onClick={retryLast}>
                <RotateCcw size={13} />
              </button>
            )}
            <span className="faint">
              {shortModel(item.model)}
              {precisionOf(item.model) && ` · ${precisionOf(item.model)}`}
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
