import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronRight } from 'lucide-react';
import { useStore } from '../lib/store.js';
import { diffLines, diffStats, describeCall } from '@buddo/core';

const TOOL_WORDS = {
  list_dir: 'folder listing', read_file: 'file', search: 'search results', glob: 'file list', write_file: 'save', edit_file: 'edit',
  run_command: 'command output', fetch_url: 'web page', web_search: 'search results', screenshot: 'screenshot', record_video: 'recording', make_video: 'video', edit_video: 'video',
  watch_video: 'video', listen_audio: 'audio', view_image: 'image', remember: 'memory', todo: 'task list',
};
const DOING = {
  list_dir: 'Looking through a folder', read_file: 'Reading a file', search: 'Searching the code', glob: 'Finding files', write_file: 'Saving a file',
  edit_file: 'Editing a file', run_command: 'Running a command', fetch_url: 'Opening a web page', web_search: 'Searching the web', screenshot: 'Taking a screenshot',
  record_video: 'Recording a video', make_video: 'Making a video', edit_video: 'Editing a video', watch_video: 'Watching a video', listen_audio: 'Listening to audio', view_image: 'Looking at an image', remember: 'Saving a memory', todo: 'Updating the task list',
};

const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n || 0));
const secs = (ms) => `${Math.max(0, ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
const tokens = (s) => Math.round((s?.length || 0) / 3.6);

/** The model's thoughts in a step: its thinking channel, or the <think>…</think> it wrote (maybe still open). */
function thoughtOf(step) {
  if (step?.thought) return step.thought.trim();
  const m = /<think>([\s\S]*?)(?:<\/think>|$)/.exec(step?.raw || '');
  return m ? m[1].trim() : '';
}
const tail = (s, n = 110) => (s.length > n ? `…${s.slice(-n).replace(/^\S*\s/, '')}` : s);

/** What the model is doing right now, in plain words. */
export function describe(item, webllm, engine) {
  const last = item.parts[item.parts.length - 1];
  const phase = item.phase || {};
  const step = item.steps?.[item.steps.length - 1];
  if (engine === 'webllm' && webllm && !webllm.ready && !webllm.error) {
    return { label: 'Loading the model', detail: webllm.progress ? `${Math.round(webllm.progress * 100)}%` : webllm.text };
  }
  if (phase.kind === 'reading') {
    const latest = step?.breakdown?.latest;
    return {
      label: latest ? `Reading ${latest}` : phase.after ? `Reading the ${TOOL_WORDS[phase.after] || phase.after + ' result'}` : 'Reading your message',
      detail: `${k(phase.tokens)} tokens of context`,
      hint: 'the model reads everything before it starts writing',
    };
  }
  // Thinking out loud: show the thought itself as it's written, not just "Thinking".
  const thought = thoughtOf(step);
  if (thought && step && !step.endedAt && (/<think>(?![\s\S]*<\/think>)/.test(step.raw || '') || (step.thought && !step.raw))) return { label: 'Thinking', detail: `“${tail(thought)}”`, quote: true };
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

/** What a tool call did, in plain words (with the lines it changed for an edit). */
function Did({ call }) {
  const a = call.args || {};
  const path = String(a.path || '').trim();
  if (call.name === 'edit_file') {
    const oldL = String(a.old || '').split('\n');
    const newL = String(a.new || '').split('\n');
    const shown = (ls, sign) => ls.slice(0, 4).map((l, i) => <div key={sign + i} className={'act-mini ' + (sign === '-' ? 'del' : 'add')}>{sign} {l}</div>);
    return (
      <>
        Edited <b>{path}</b>: {oldL.length} line{oldL.length === 1 ? '' : 's'} → {String(a.new || '').trim() ? `${newL.length} line${newL.length === 1 ? '' : 's'}` : 'deleted'}
        <div className="act-minidiff">
          {shown(oldL, '-')}
          {oldL.length > 4 && <div className="act-mini faint">  … {oldL.length - 4} more</div>}
          {String(a.new || '').trim() && shown(newL, '+')}
          {String(a.new || '').trim() && newL.length > 4 && <div className="act-mini faint">  … {newL.length - 4} more</div>}
        </div>
      </>
    );
  }
  if (call.name === 'write_file') return <>Wrote <b>{path}</b> ({String(a.content || '').split('\n').length} lines)</>;
  if (call.name === 'read_file') return <>Opened <b>{path}</b>{a.start ? ` from line ${a.start}` : ''} to read it</>;
  if (call.name === 'search') return <>Searched the code for <b>“{a.pattern}”</b>{a.glob ? ` in ${a.glob}` : a.path && a.path !== '.' ? ` in ${a.path}` : ''}</>;
  if (call.name === 'run_command') return <>Ran <code>{a.command}</code></>;
  if (call.name === 'todo') return <>Updated its plan (task list)</>;
  return <>{DOING[call.name] || call.name}: {describeCall(call)}</>;
}

/** What came back from the tool, in plain words. */
function GotBack({ part }) {
  if (part.status === 'running' || part.status === 'awaiting') return <span className="faint">waiting…</span>;
  if (part.status === 'denied') return <>You said no</>;
  if (part.status === 'error') return <span className="act-bad">Failed: {String(part.output || '').split('\n')[0].slice(0, 140)}</span>;
  const d = part.display;
  if (d?.type === 'file') return <>{d.end - d.start + 1} of {d.total} lines of {d.path}</>;
  if (d?.type === 'search') return <>{d.hits.length ? `${d.hits.length} match${d.hits.length === 1 ? '' : 'es'} in ${new Set(d.hits.map((h) => h.file)).size} file(s): ${d.hits.slice(0, 3).map((h) => `${h.file}:${h.line}`).join(', ')}${d.hits.length > 3 ? '…' : ''}` : 'No matches'}</>;
  if (d?.type === 'diff') {
    const st = diffStats(diffLines(d.before || '', d.after));
    return <>{d.created ? 'Created' : 'Saved'} {d.path}: <span className="act-add">+{st.added}</span> <span className="act-del">−{st.removed}</span> lines</>;
  }
  if (d?.type === 'terminal') return <>Exit code {d.code}</>;
  if (d?.type === 'todos') return <>{d.todos.filter((t) => t.status === 'done').length}/{d.todos.length} tasks done</>;
  return <>{String(part.output || 'Done').split('\n')[0].slice(0, 140)}</>;
}

/** One step, readable: what it read, what it thought, what it did, what came back (raw output one tap away). */
function StepDetail({ step, part, live }) {
  const [raw, setRaw] = useState(false);
  const b = step.breakdown;
  const thought = thoughtOf(step);
  const prose = (step.raw || '').replace(/<think>[\s\S]*?(<\/think>|$)/, '').replace(/<tool:[\s\S]*$/, '').trim();
  return (
    <div className="act-detail">
      {b && (
        <div className="act-row">
          <span className="act-ico">📥</span>
          <span className="act-key">Read</span>
          <span>
            Buddo's instructions {k(b.instructions)} · the chat so far {k(b.chat)} · <b>{b.latest || 'your message'}</b> {k(b.latestTokens)} <span className="faint">tokens</span>
          </span>
        </div>
      )}
      {thought && (
        <div className="act-row">
          <span className="act-ico">💭</span>
          <span className="act-key">Thought</span>
          <span className="act-thought">{thought}</span>
        </div>
      )}
      {part && (
        <div className="act-row">
          <span className="act-ico">🔧</span>
          <span className="act-key">Did</span>
          <span><Did call={part.call} /></span>
        </div>
      )}
      {part && (
        <div className="act-row">
          <span className="act-ico">📄</span>
          <span className="act-key">Got back</span>
          <span><GotBack part={part} /></span>
        </div>
      )}
      {!part && prose && !live && (
        <div className="act-row">
          <span className="act-ico">💬</span>
          <span className="act-key">Wrote</span>
          <span>its reply to you ({prose.split(/\s+/).length} words)</span>
        </div>
      )}
      {live && !part ? (
        <RawView step={step} live />
      ) : (
        <>
          <button className="act-rawbtn faint" onClick={() => setRaw(!raw)}>{raw ? 'Hide' : 'Show'} exactly what the model wrote</button>
          {raw && <RawView step={step} live={false} />}
        </>
      )}
    </div>
  );
}

function StepRow({ step, part, live, open, onToggle }) {
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
          {step.finish === 'length' ? ' · stopped: out of room' : ''}
          {!live && step.endedAt && !step.raw && !step.thought ? ' · empty reply' : ''}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} style={{ overflow: 'hidden' }}>
            <StepDetail step={step} part={part} live={live} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Every step the model took: how long it read, what it wrote (raw, including tool calls and thoughts). */
export function ActivityLog({ steps, parts = [], live }) {
  const [opened, setOpened] = useState({});
  if (!steps?.length) return null;
  return (
    <div className="act-log">
      {steps.map((s, i) => {
        const isLive = live && i === steps.length - 1;
        const open = opened[s.n] ?? isLive;
        const part = s.callId ? parts.find((p) => p.type === 'tool' && p.call.id === s.callId) : null;
        return <StepRow key={s.n} step={s} part={part} live={isLive} open={open} onToggle={() => setOpened((o) => ({ ...o, [s.n]: !open }))} />;
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
  const { label, detail, hint, quote } = describe(item, webllm, engine);
  const step = item.steps?.[item.steps.length - 1];
  const phaseSecs = item.phase?.at ? (Date.now() - item.phase.at) / 1000 : 0;
  const total = Math.floor((Date.now() - item.startedAt) / 1000);

  return (
    <motion.div className="activity" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <button className="activity-head" onClick={() => setSettings({ showActivity: !open })} title={open ? 'Hide details' : 'Show everything the model is doing'}>
        <span className="working-orb" />
        <span className="shimmer">{label}…</span>
        {detail && <span className={quote ? 'faint act-live-thought' : 'faint'}>{detail}</span>}
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
            <ActivityLog steps={item.steps} parts={item.parts} live />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
