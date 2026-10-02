import { motion } from 'framer-motion';
import { Settings, Cpu, Palette, SlidersHorizontal, Database, Info, Sun, Moon, Monitor, Check } from 'lucide-react';
import { useStore, DEFAULT_SETTINGS } from '../lib/store.js';
import { checkEngine } from '../lib/engine.js';
import { MODES } from './Composer.jsx';
import Modal from './Modal.jsx';
import Logo from './Logo.jsx';

const TABS = [
  { id: 'engine', icon: Cpu, label: 'Engine' },
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
  const engine = useStore((st) => st.engine);
  const server = useStore((st) => st.server);
  const sessions = useStore((st) => st.sessions);
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
                  {s.engine === 'webllm' ? 'Runs on your GPU via WebGPU' : engine.status === 'ok' ? `Connected · ${engine.models.length} models` : `Not connected${engine.error ? ` — ${engine.error}` : ''}`}
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
                  <span className="hint">Bigger = remembers more of your project, but uses more RAM. 16k–32k is a good default.</span>
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
          {tab === 'appearance' && (
            <>
              <div className="field">
                <label>Theme</label>
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
              <div className="field row" style={{ flexDirection: 'row' }}>
                <div style={{ flex: 1 }}>
                  <label>Show thinking</label>
                  <div className="hint">Display the reasoning of thinking models (Qwen 3, gpt-oss…)</div>
                </div>
                <Toggle on={s.showThinking} onChange={(v) => setSettings({ showThinking: v })} />
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
                Buddo <span className="faint">v1.0.0</span>
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
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
