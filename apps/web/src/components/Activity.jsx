import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronRight } from 'lucide-react';
import { useStore } from '../lib/store.js';

const TOOL_WORDS = {
  list_dir: 'folder listing', read_file: 'file', search: 'search results', glob: 'file list', write_file: 'save', edit_file: 'edit',
  run_command: 'command output', fetch_url: 'web page', web_search: 'search results', screenshot: 'screenshot', record_video: 'recording',
  watch_video: 'video', listen_audio: 'audio', view_image: 'image', remember: 'memory', todo: 'task list',
};
const DOING = {
  list_dir: 'Looking through a folder', read_file: 'Reading a file', search: 'Searching the code', glob: 'Finding files', write_file: 'Saving a file',
  edit_file: 'Editing a file', run_command: 'Running a command', fetch_url: 'Opening a web page', web_search: 'Searching the web', screenshot: 'Taking a screenshot',
  record_video: 'Recording a video', watch_video: 'Watching a video', listen_audio: 'Listening to audio', view_image: 'Looking at an image', remember: 'Saving a memory', todo: 'Updating the task list',
};

const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n || 0));
const secs = (ms) => `${Math.max(0, ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
const tokens = (s) => Math.round((s?.length || 0) / 3.6);

/** What the model is doing right now, in plain words. */
function describe(item, webllm, engine) {
  const last = item.parts[item.parts.length - 1];
  const phase = item.phase || {};
  if (engine === 'webllm' && webllm && !webllm.ready && !webllm.error) {
    return { label: 'Loading the model', detail: webllm.progress ? `${Math.round(webllm.progress * 100)}%` : webllm.text };
  }
  if (phase.kind === 'reading') {
    return {
      label: phase.after ? `Reading the ${TOOL_WORDS[phase.after] || phase.after + ' result'}` : 'Reading your message',
      detail: `${k(phase.tokens)} tokens of context`,
      hint: 'the model reads everything before it starts writing',
    };
  }
  if (phase.kind === 'waiting') return { label: 'Waiting for your OK' };
  if (item.live) {
    const a = item.live.args || {};
    const verb = { write_file: 'Writing', edit_file: 'Editing', run_command: 'Typing a command' }[item.live.name];
    return { label: verb ? `${verb}${a.path ? ` ${a.path}` : ''}` : `Preparing ${item.live.name}` };
  }
  if (item.preparing) return { label: item.preparing === 'write_file' || item.preparing === 'edit_file' ? 'Writing code' : `Preparing ${item.preparing}` };
  if (last?.type === 'thinking' && !last.done) return { label: 'Thinking' };
  if (last?.type === 'tool' && last.status === 'running') return { label: DOING[last.call.name] || `Running ${last.call.name}` };
  if (last?.type === 'text' && phase.kind === 'writing') return { label: 'Writing the reply' };
  if (phase.kind === 'writing') return { label: 'Writing' };
  return { label: 'Working' };
}

function RawView({ step, live }) {
  const ref = useRef(null);
  useEffect(() => {
    if (live && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [step.raw, step.thought, live]);
  const empty = !step.raw && !step.thought;
  return (
    <pre className="act-raw" ref={ref}>
      {step.thought && <span className="act-thought">{step.thought}</span>}
      {step.thought && step.raw && '\n\n'}
      {step.raw}
      {empty && <span className="faint">{live ? 'Nothing written yet — the model is still reading…' : '(no output)'}</span>}
      {live && <span className="live-caret" />}
    </pre>
  );
}

function StepRow({ step, live, open, onToggle }) {
  const now = Date.now();
  const readMs = (step.firstAt || (live ? now : step.endedAt || now)) - step.startedAt;
  const writeMs = step.firstAt ? (step.endedAt || now) - step.firstAt : 0;
  const out = step.usage?.completion || tokens(step.raw) + tokens(step.thought);
  const tps = step.usage?.tps || (writeMs > 300 ? out / (writeMs / 1000) : 0);
  return (
    <div className={'act-step' + (live ? ' live' : '')}>
      <button className="act-step-head" onClick={onToggle}>
        <motion.span animate={{ rotate: open ? 90 : 0 }} className="row">
          <ChevronRight size={12} />
        </motion.span>
        <span className="act-n">Step {step.n}</span>
        <span className="act-sum">
          read {k(step.usage?.prompt || step.promptTokens)} tokens{step.after ? ` (+ ${step.after} result)` : ''} in {secs(readMs)}
          {step.firstAt ? ` · wrote ${k(out)} tokens in ${secs(writeMs)}${tps ? ` · ${Math.round(tps)} tok/s` : ''}` : ''}
          {step.tool ? ` → ${step.tool}` : ''}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} style={{ overflow: 'hidden' }}>
            <RawView step={step} live={live} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Every step the model took: how long it read, what it wrote (raw, including tool calls and thoughts). */
export function ActivityLog({ steps, live }) {
  const [opened, setOpened] = useState({});
  if (!steps?.length) return null;
  return (
    <div className="act-log">
      {steps.map((s, i) => {
        const isLive = live && i === steps.length - 1;
        const open = opened[s.n] ?? isLive;
        return <StepRow key={s.n} step={s} live={isLive} open={open} onToggle={() => setOpened((o) => ({ ...o, [s.n]: !open }))} />;
      })}
    </div>
  );
}

/** Live status line under a running message; expands into the full activity log. */
export default function ActivityBar({ item }) {
  const webllm = useStore((s) => s.webllm);
  const engine = useStore((s) => s.settings.engine);
  const open = useStore((s) => s.settings.showActivity);
  const setSettings = useStore((s) => s.setSettings);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 500);
    return () => clearInterval(t);
  }, []);
  const { label, detail, hint } = describe(item, webllm, engine);
  const step = item.steps?.[item.steps.length - 1];
  const phaseSecs = item.phase?.at ? (Date.now() - item.phase.at) / 1000 : 0;
  const total = Math.floor((Date.now() - item.startedAt) / 1000);

  return (
    <motion.div className="activity" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <button className="activity-head" onClick={() => setSettings({ showActivity: !open })} title={open ? 'Hide details' : 'Show everything the model is doing'}>
        <span className="working-orb" />
        <span className="shimmer">{label}…</span>
        {detail && <span className="faint">{detail}</span>}
        {step && <span className="faint act-step-chip">step {step.n}</span>}
        <span className="faint">
          {phaseSecs >= 1 && total - phaseSecs >= 1 ? `${Math.floor(phaseSecs)}s · ` : ''}
          {total}s
        </span>
        <span className="spacer" />
        <span className="act-toggle faint">
          {open ? 'Hide' : 'Details'}
          <motion.span animate={{ rotate: open ? 90 : 0 }} className="row">
            <ChevronRight size={13} />
          </motion.span>
        </span>
      </button>
      {hint && phaseSecs > 4 && !open && <div className="act-hint faint">Still reading — {hint}. Tap Details to see more.</div>}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22 }} style={{ overflow: 'hidden' }}>
            <ActivityLog steps={item.steps} live />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
