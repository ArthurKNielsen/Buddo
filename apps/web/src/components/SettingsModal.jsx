import { motion } from 'framer-motion';
import { Settings, Cpu, Palette, SlidersHorizontal, Database, Info, Sun, Moon, Monitor, Check, Eye, Smile } from 'lucide-react';
import PersonalityPanel from './PersonalityPanel.jsx';
import SensesPanel from './SensesPanel.jsx';
import { useStore, DEFAULT_SETTINGS } from '../lib/store.js';
import { checkEngine, shortModel, precisionOf, usesCpu } from '../lib/engine.js';
import { MODES } from './Composer.jsx';
import Modal from './Modal.jsx';
import Logo from './Logo.jsx';
import { SKINS } from '../lib/skins.js';
import { UpdatePanel } from './Updates.jsx';

const TABS = [
  { id: 'personality', icon: Smile, label: 'Personality' },
  { id: 'engine', icon: Cpu, label: 'Engine' },
  { id: 'senses', icon: Eye, label: 'Senses' },
  { id: 'appearance', icon: Palette, label: 'Appearance' },
  { id: 'behavior', icon: SlidersHorizontal, label: 'Behavior' },
  { id: 'data', icon: Database, label: 'Data' },
  { id: 'about', icon: Info, label: 'About' },
];
const ACCENTS = [
  ['violet', '#8b5cf6', '#22d3ee'],
  ['blue', '#3b82f6', '#22d3ee'],
  ['emerald', '#10b981', '#a3e635'],
  ['orange', '#f97316', '#facc15'],
  ['pink', '#ec4899', '#a78bfa'],
];

function Toggle({ on, onChange }) {
  return <button className={'switch' + (on ? ' on' : '')} onClick={() => onChange(!on)} />;
}

export default function SettingsModal() {
  const open = useStore((s) => s.ui.settings);
  const tab = useStore((s) => s.ui.settingsTab);
  const s = useStore((st) => st.settings);
  const webllm = useStore((st) => st.webllm);
  const engine = useStore((st) => st.engine);
  const server = useStore((st) => st.server);
  const sessions = useStore((st) => st.sessions);
  const version = useStore((st) => st.update?.current) || '1.0.0';
  const { setUI, setSettings, toast } = useStore.getState();

  return (
    <Modal open={open} onClose={() => setUI({ settings: false })} title="Settings" icon={<Settings size={17} />} width={760} className="settings">
      <div className="settings-grid">
        <nav className="settings-nav">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setUI({ settingsTab: t.id })}>
              {tab === t.id && <motion.div layoutId="set-nav" className="set-nav-bg" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
              <t.icon size={15} /> {t.label}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          {tab === 'engine' && (
            <>
              <div className="field">
                <label>Engine</label>
                <div className="seg">
                  {[
                    ['ollama', 'Ollama'],
                    ['webllm', 'In-browser'],
                    ['openai', 'LM Studio / OpenAI-compatible'],
                  ].map(([id, l]) => (
                    <button key={id} className={s.engine === id ? 'on' : ''} onClick={() => setSettings({ engine: id })}>
                      {s.engine === id && <motion.div layoutId="eng-pill" className="seg-pill" />}
                      {l}
                    </button>
                  ))}
                </div>
                <span className="hint row">
                  <span className={`dot ${s.engine === 'webllm' || engine.status === 'ok' ? 'ok' : 'down'}`} />
                  {s.engine === 'webllm' ? (usesCpu(s) ? 'Runs on your CPU (WebAssembly)' : 'Runs on your GPU via WebGPU') : engine.status === 'ok' ? `Connected · ${engine.models.length} models` : `Not connected${engine.error ? ` — ${engine.error}` : ''}`}
                </span>
              </div>
              {s.engine === 'ollama' && (
                <div className="field">
                  <label>Ollama URL</label>
                  <input className="input mono" value={s.ollamaUrl} onChange={(e) => setSettings({ ollamaUrl: e.target.value })} onBlur={checkEngine} />
                  <span className="hint">{server ? 'Requests are proxied through the local Buddo server.' : 'Called directly from your browser.'}</span>
                </div>
              )}
              {s.engine === 'openai' && (
                <div className="field">
                  <label>Server URL</label>
                  <input className="input mono" value={s.openaiUrl} onChange={(e) => setSettings({ openaiUrl: e.target.value })} onBlur={checkEngine} />
                  <span className="hint">LM Studio: http://localhost:1234/v1 · llama.cpp: http://localhost:8080/v1</span>
                </div>
              )}
              <div className="field">
                <label>Model</label>
                <button className="btn btn-outline" style={{ justifyContent: 'flex-start' }} onClick={() => setUI({ settings: false, models: true })}>
                  <Cpu size={14} /> <span className="mono">{(s.engine === 'webllm' ? s.webllmModel : s.model) || 'Choose…'}</span>
                </button>
              </div>
              {s.engine !== 'webllm' && (
                <div className="field">
                  <label>Context window · {s.ctx.toLocaleString()} tokens</label>
                  <input type="range" min={4096} max={131072} step={4096} value={s.ctx} onChange={(e) => setSettings({ ctx: +e.target.value })} className="range" />
                  <span className="hint">Bigger = remembers more of your project, but needs more GPU memory. 8k suits a 7B model on most computers; if Buddo reads your messages slowly, go back to 8,192 (when it doesn't fit, part of the model runs on the CPU).</span>
                </div>
              )}
              <div className="field">
                <label>Lite mode (for tiny & phone models)</label>
                <div className="seg">
                  {[
                    ['auto', 'Auto'],
                    ['on', 'Always'],
                    ['off', 'Never'],
                  ].map(([id, l]) => (
                    <button key={id} className={s.lite === id ? 'on' : ''} onClick={() => setSettings({ lite: id })}>
                      {s.lite === id && <motion.div layoutId="lite-pill" className="seg-pill" />}
                      {l}
                    </button>
                  ))}
                </div>
                <span className="hint">A ~9× shorter prompt and smaller context so tiny models answer fast. Auto turns it on for Pocket models.</span>
              </div>
              {s.engine === 'ollama' && (
                <div className="field">
                  <label>Always use tools</label>
                  <div className="seg">
                    {[
                      ['auto', 'On'],
                      ['off', 'Off'],
                    ].map(([id, l]) => (
                      <button key={id} className={(s.strictTools === 'off' ? 'off' : 'auto') === id ? 'on' : ''} onClick={() => setSettings({ strictTools: id })}>
                        {(s.strictTools === 'off' ? 'off' : 'auto') === id && <motion.div layoutId="strict-pill" className="seg-pill" />}
                        {l}
                      </button>
                    ))}
                  </div>
                  <span className="hint">Ollama only lets the model answer in Buddo's reply format, so it can't skip the tools: asked to build something, it can't finish until the files are written. Turn off only if a model writes worse code this way.</span>
                </div>
              )}
              <div className="field">
                <label>Think out loud</label>
                <div className="seg">
                  {[
                    ['auto', 'Auto'],
                    ['on', 'Always'],
                    ['off', 'Never'],
                  ].map(([id, l]) => (
                    <button key={id} className={s.thinkAloud === id ? 'on' : ''} onClick={() => setSettings({ thinkAloud: id })}>
                      {s.thinkAloud === id && <motion.div layoutId="think-pill" className="seg-pill" />}
                      {l}
                    </button>
                  ))}
                </div>
                <span className="hint">Models without a thinking mode write a short plan before each step, so you can see what they're thinking. Auto: on for normal models, off for Pocket models (it costs them a few seconds). Thinking models (Qwen 3, gpt-oss, DeepSeek R1) always show their thoughts.</span>
              </div>
              {s.engine === 'webllm' && (
                <div className="field">
                  <label>Run in-browser models on</label>
                  <div className="seg">
                    {[
                      ['auto', 'Auto'],
                      ['gpu', 'GPU'],
                      ['cpu', 'CPU'],
                    ].map(([id, l]) => (
                      <button key={id} className={s.webllmDevice === id ? 'on' : ''} onClick={() => setSettings({ webllmDevice: id })}>
                        {s.webllmDevice === id && <motion.div layoutId="dev-pill" className="seg-pill" />}
                        {l}
                      </button>
                    ))}
                  </div>
                  <span className="hint">
                    GPU (WebGPU) is fast. CPU is slower but works on every computer, even when the GPU gives broken answers. Auto uses the GPU, checks once that it answers correctly, and switches to CPU if it can't. CPU mode runs models up to 3B.
                  </span>
                  {s.gpuBroken && (
                    <span className="hint">
                      ⚠️ Your GPU failed the correctness check, so Auto is using the CPU.{' '}
                      <button
                        className="link"
                        onClick={() => {
                          try {
                            localStorage.removeItem('buddo-gpu-verified');
                          } catch {}
                          setSettings({ gpuBroken: false });
                        }}
                      >
                        Test the GPU again
                      </button>
                    </span>
                  )}
                </div>
              )}
              {s.engine === 'webllm' && !usesCpu(s) && (
                <div className="field">
                  <label>GPU precision (in-browser models)</label>
                  <div className="seg">
                    {[
                      ['auto', 'Auto'],
                      ['f16', 'Fast (f16)'],
                      ['f32', 'Safe (f32)'],
                    ].map(([id, l]) => (
                      <button key={id} className={s.webllmPrecision === id ? 'on' : ''} onClick={() => setSettings({ webllmPrecision: id })}>
                        {s.webllmPrecision === id && <motion.div layoutId="prec-pill" className="seg-pill" />}
                        {l}
                      </button>
                    ))}
                  </div>
                  <span className="hint">If replies come out as gibberish (random symbols and Chinese characters), your GPU does fast f16 math wrong — use Safe. Auto picks Safe on Chromebooks and GPUs without f16, and switches by itself if it spots gibberish. Changing it downloads the other version once.</span>
                  {webllm?.loaded && (
                    <span className="hint">
                      Loaded right now: <b>{shortModel(webllm.loaded)}</b> · <span className={'prec-chip ' + precisionOf(webllm.loaded)}>{precisionOf(webllm.loaded)}</span>
                    </span>
                  )}
                </div>
              )}
              <div className="field">
                <label>Creativity (temperature) · {s.temperature.toFixed(2)}</label>
                <input type="range" min={0} max={1} step={0.05} value={s.temperature} onChange={(e) => setSettings({ temperature: +e.target.value })} className="range" />
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => setUI({ settings: false, setup: true })}>
                Run setup wizard again
              </button>
            </>
          )}
          {tab === 'personality' && <PersonalityPanel />}
          {tab === 'senses' && <SensesPanel />}
          {tab === 'appearance' && (
            <>
              <div className="field">
                <label>Theme</label>
                <div className="skin-grid">
                  {SKINS.map((k) => (
                    <motion.button
                      key={k.id}
                      className={'skin-card' + ((s.skin || 'studio') === k.id ? ' on' : '')}
                      onClick={() => setSettings({ skin: k.id })}
                      whileHover={{ y: -2 }}
                      whileTap={{ scale: 0.97 }}
                    >
                      <span className="skin-swatch" style={{ background: k.colors[0] }}>
                        <i style={{ background: k.colors[1] }} />
                        <b style={{ background: k.colors[2] }} />
                        <em style={{ background: k.colors[3] }} />
                      </span>
                      <span className="skin-name">{k.name}</span>
                      <span className="skin-blurb">{k.blurb}</span>
                      {(s.skin || 'studio') === k.id && <Check size={13} className="skin-check" />}
                    </motion.button>
                  ))}
                </div>
              </div>
              <div className="field row" style={{ flexDirection: 'row' }}>
                <div style={{ flex: 1 }}>
                  <label>Buddo on the chat bar</label>
                  <div className="hint">Buddo stands on the message box and shows what he's doing. Poke him, or grab and pull.</div>
                </div>
                <Toggle on={s.buddy} onChange={(v) => setSettings({ buddy: v })} />
              </div>
              {s.skin === 'classic' && (
              <>
              <div className="field">
                <label>Mode</label>
                <div className="seg">
                  {[
                    ['dark', Moon, 'Dark'],
                    ['light', Sun, 'Light'],
                    ['system', Monitor, 'System'],
                  ].map(([id, I, l]) => (
                    <button key={id} className={s.theme === id ? 'on' : ''} onClick={() => setSettings({ theme: id })}>
                      {s.theme === id && <motion.div layoutId="theme-pill" className="seg-pill" />}
                      <I size={13} /> {l}
                    </button>
                  ))}
                </div>
              </div>
              <div className="field">
                <label>Accent</label>
                <div className="row" style={{ gap: 10 }}>
                  {ACCENTS.map(([id, a, b]) => (
                    <motion.button
                      key={id}
                      className={'swatch' + (s.accent === id ? ' on' : '')}
                      style={{ background: `linear-gradient(135deg, ${a}, ${b})` }}
                      onClick={() => setSettings({ accent: id })}
                      whileHover={{ scale: 1.1 }}
                      whileTap={{ scale: 0.92 }}
                      title={id}
                    >
                      {s.accent === id && <Check size={14} color="white" />}
                    </motion.button>
                  ))}
                </div>
              </div>
              </>
              )}
              <div className="field row" style={{ flexDirection: 'row' }}>
                <div style={{ flex: 1 }}>
                  <label>Watch Buddo type</label>
                  <div className="hint">Show code live, character by character, while Buddo writes it</div>
                </div>
                <Toggle on={s.liveCode} onChange={(v) => setSettings({ liveCode: v })} />
              </div>
              <div className="field row" style={{ flexDirection: 'row' }}>
                <div style={{ flex: 1 }}>
                  <label>Show thinking</label>
                  <div className="hint">Keep the model's thoughts in the chat after it finishes (they always show live)</div>
                </div>
                <Toggle on={s.showThinking} onChange={(v) => setSettings({ showThinking: v })} />
              </div>
              <div className="field row" style={{ flexDirection: 'row' }}>
                <div style={{ flex: 1 }}>
                  <label>Show live details</label>
                  <div className="hint">Open the step-by-step view of everything the model reads and writes while it works (you can also tap the status line)</div>
                </div>
                <Toggle on={s.showActivity} onChange={(v) => setSettings({ showActivity: v })} />
              </div>
            </>
          )}
          {tab === 'behavior' && (
            <>
              <div className="field">
                <label>Default permission mode</label>
                <div className="mode-cards">
                  {MODES.map((m) => (
                    <button key={m.id} className={'mode-card' + (s.mode === m.id ? ' on' : '')} onClick={() => setSettings({ mode: m.id })}>
                      <m.icon size={16} />
                      <b>{m.label}</b>
                      <span className="faint">{m.tip}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="hint">
                Tip: put project instructions in a <code>BUDDO.md</code> file at the root of your project (run <code>/init</code>) — Buddo reads it every time.
              </div>
            </>
          )}
          {tab === 'data' && (
            <>
              <p className="muted" style={{ marginTop: 0 }}>
                Everything is stored locally in this browser. {sessions.length} chat{sessions.length === 1 ? '' : 's'} saved.
              </p>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <button
                  className="btn btn-outline"
                  onClick={() => {
                    const blob = new Blob([JSON.stringify({ sessions, exportedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' });
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = `buddo-chats-${Date.now()}.json`;
                    a.click();
                  }}
                >
                  Export chats
                </button>
                <button
                  className="btn btn-danger"
                  onClick={() => {
                    if (confirm('Delete all chats? This cannot be undone.')) {
                      useStore.setState({ sessions: [], activeId: null });
                      toast('All chats deleted', 'success');
                    }
                  }}
                >
                  Delete all chats
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => {
                    if (confirm('Reset all settings to defaults?')) setSettings({ ...DEFAULT_SETTINGS, onboarded: true });
                  }}
                >
                  Reset settings
                </button>
              </div>
            </>
          )}
          {tab === 'about' && (
            <div className="about">
              <Logo size={56} />
              <h3>
                Buddo <span className="faint">v{version}</span>
              </h3>
              <p className="muted">A free, open-source, local-first AI coding agent. Made to give everyone a capable coding buddy without API keys or subscriptions.</p>
              <div className="about-grid">
                <span className="faint">Engine</span>
                <span>{s.engine}</span>
                <span className="faint">Workspace mode</span>
                <span>{server ? 'Local server (full)' : 'Browser'}</span>
                <span className="faint">License</span>
                <span>MIT</span>
              </div>
              <h4 style={{ marginTop: 18 }}>Updates</h4>
              <UpdatePanel />
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
