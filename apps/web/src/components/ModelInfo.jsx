import { RECOMMENDED_MODELS } from '@buddo/core';
import { useStore } from '../lib/store.js';
import { modelGuide, speedRating, speedKey, usesCpu, WEBLLM_MODELS } from '../lib/engine.js';

const USES = {
  code: '💻 Code',
  chat: '💬 Chat',
  search: '🔎 Web search',
  think: '🧠 Reasoning',
  vision: '👁 Images',
};

const known = (id = '') => [...WEBLLM_MODELS, ...RECOMMENDED_MODELS].find((m) => m.id === id || `${m.id}:latest` === id || m.id === id.replace(/:latest$/, ''));

/** What a model is good at: from our lists, else guessed from its name. */
export function usesOf(m) {
  if (m.uses) return m.uses;
  const k = known(m.id);
  if (k?.uses) return k.uses;
  const id = m.id.toLowerCase();
  const out = [];
  if (/coder|code|starcoder|codestral|devstral/.test(id)) out.push('code');
  if (/qwen3(?!.*coder)|r1|gpt-oss|qwq|reason|think|magistral/.test(id)) out.push('think');
  if (/vl\b|vl:|llava|vision|gemma3|moondream|minicpm-v/.test(id)) out.push('vision');
  if (!out.length || out.includes('think')) out.push('chat');
  return out;
}

export const bestFor = (m) => m.best || known(m.id)?.best || '';

export function UseChips({ uses }) {
  return (
    <span className="use-chips">
      {uses.map((u) => (
        <span key={u} className={`use-chip use-${u}`}>
          {USES[u]}
        </span>
      ))}
    </span>
  );
}

/** "Speed ⚡⚡⚡" (relative, from size) plus the real tok/s measured on this device, if any. */
export function SpeedLine({ m }) {
  const settings = useStore((s) => s.settings);
  const rating = speedRating(m, settings);
  const measured = settings.modelSpeeds?.[speedKey(m.id, settings)];
  if (rating === 0) return <span className="speed-line needs-gpu">Needs a GPU — can't run in CPU mode</span>;
  return (
    <span className="speed-line">
      {rating ? <span title="Relative speed on this device (smaller models are faster)">Speed {'⚡'.repeat(rating)}<span className="speed-off">{'⚡'.repeat(4 - rating)}</span></span> : null}
      {measured ? <span className="speed-measured" title="Measured on this device, while writing">Your speed: {Math.round(measured)} tok/s</span> : null}
    </span>
  );
}

/** "Which one should I pick?" for this device and engine. */
export function ModelGuide({ onPick }) {
  const settings = useStore((s) => s.settings);
  const server = useStore((s) => s.server);
  const guide = modelGuide(settings);
  const cpu = settings.engine === 'webllm' && usesCpu(settings);
  const label = (id) => known(id)?.label || id;
  return (
    <div className="model-guide">
      <div className="model-guide-title">Which one should I pick? {cpu ? <span className="faint">(this device runs models on the CPU)</span> : null}</div>
      {guide.map((g) => (
        <button key={g.use} className="model-guide-row" onClick={() => onPick?.(g.id)} disabled={!onPick}>
          <span className={`use-chip use-${g.use}`}>{USES[g.use].split(' ')[0]}</span>
          <span>{g.text}</span>
          <span className="spacer" />
          <span className="mono">{label(g.id)}</span>
        </button>
      ))}
      {!server && <div className="faint model-guide-note">On the website, web search only looks things up on Wikipedia. The desktop app searches the whole web.</div>}
    </div>
  );
}
