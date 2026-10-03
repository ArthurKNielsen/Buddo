import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowRight, ArrowLeft, Check, Cpu, Globe, Server, Shield, Zap, Heart, Copy, HardDrive, Box, FolderOpen, Loader2 } from 'lucide-react';
import { RECOMMENDED_MODELS } from '@buddo/core';
import { useStore } from '../lib/store.js';
import { checkEngine, WEBLLM_MODELS, loadWebLLM, hasWebGPU, pickBrowserFolder, useSandbox, isMobile, usesCpu } from '../lib/engine.js';
import { supportsFolderAccess } from '../lib/workspaces.js';
import { PullButton } from './ModelPicker.jsx';
import Logo from './Logo.jsx';

const slide = {
  initial: (d) => ({ opacity: 0, x: d * 40 }),
  animate: { opacity: 1, x: 0 },
  exit: (d) => ({ opacity: 0, x: d * -40 }),
};

function CopyLine({ cmd }) {
  const [ok, setOk] = useState(false);
  return (
    <div className="copy-line">
      <code>{cmd}</code>
      <button
        className="icon-btn sm"
        onClick={() => {
          navigator.clipboard?.writeText(cmd);
          setOk(true);
          setTimeout(() => setOk(false), 1200);
        }}
      >
        {ok ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </div>
  );
}

const OS = /Mac/i.test(navigator.platform) ? 'mac' : /Win/i.test(navigator.platform) ? 'windows' : 'linux';

function OllamaSetup() {
  const engine = useStore((s) => s.engine);
  const server = useStore((s) => s.server);
  const settings = useStore((s) => s.settings);
  const [os, setOs] = useState(OS);
  useEffect(() => {
    if (engine.status === 'ok') return;
    const t = setInterval(checkEngine, 3000);
    return () => clearInterval(t);
  }, [engine.status]);

  if (engine.status === 'down' || engine.status === 'unknown' || engine.status === 'checking') {
    return (
      <div>
        <div className="status-card wait">
          <Loader2 size={16} className="spin" />
          <div>
            <b>Waiting for Ollama…</b>
            <div className="faint">Install it and Buddo will connect automatically.</div>
          </div>
        </div>
        <div className="seg" style={{ margin: '14px 0 10px' }}>
          {['mac', 'windows', 'linux'].map((o) => (
            <button key={o} className={os === o ? 'on' : ''} onClick={() => setOs(o)}>
              {os === o && <motion.div layoutId="os-pill" className="seg-pill" />}
              {o === 'mac' ? 'macOS' : o === 'windows' ? 'Windows' : 'Linux'}
            </button>
          ))}
        </div>
        <ol className="steps">
          {os === 'linux' ? (
            <li>
              Install Ollama:
              <CopyLine cmd="curl -fsSL https://ollama.com/install.sh | sh" />
            </li>
          ) : (
            <li>
              Download Ollama from{' '}
              <a href="https://ollama.com/download" target="_blank" rel="noreferrer" className="link">
                ollama.com/download
              </a>{' '}
              and open it (it lives in your {os === 'mac' ? 'menu bar' : 'system tray'}).
            </li>
          )}
          <li>
            Make sure it's running:
            <CopyLine cmd="ollama serve" />
          </li>
          {!server && !['localhost', '127.0.0.1'].includes(location.hostname) && (
            <li>
              Allow this website to talk to Ollama (one time):
              <CopyLine cmd={os === 'windows' ? 'setx OLLAMA_ORIGINS "*"' : `OLLAMA_ORIGINS="${location.origin}" ollama serve`} />
            </li>
          )}
        </ol>
        <div className="faint" style={{ fontSize: 12 }}>
          Ollama is free and open-source. Looking at <code>{settings.ollamaUrl}</code>
        </div>
      </div>
    );
  }
  return (
    <div>
      <div className="status-card ok">
        <Check size={16} />
        <div>
          <b>Ollama connected{engine.version && ` · v${engine.version}`}</b>
          <div className="faint">{engine.models.length ? `${engine.models.length} model(s) installed — you're set.` : 'Now grab a model (one-time download).'}</div>
        </div>
      </div>
      <div className="section-label">{engine.models.length ? 'Want a smarter model?' : 'Pick a model to download'}</div>
      <div className="model-list">
        {RECOMMENDED_MODELS.slice(0, 5).map((m) => (
          <div key={m.id} className="model-row static">
            <div className="model-meta">
              <div className="row">
                <span className="mono">{m.id}</span>
                <span className="chip">{m.tag}</span>
              </div>
              <div className="faint">
                {m.size} · {m.note}
              </div>
            </div>
            <span className="spacer" />
            <PullButton id={m.id} />
          </div>
        ))}
      </div>
    </div>
  );
}

function WebLLMSetup() {
  const settings = useStore((s) => s.settings);
  const webllm = useStore((s) => s.webllm);
  const { setSettings } = useStore.getState();
  const gpu = hasWebGPU();
  return (
    <div>
      {!gpu && (
        <div className="status-card" style={{ marginBottom: 12 }}>
          <Globe size={16} />
          <div>
            <b>No WebGPU here — models will run on your CPU</b>
            <div className="faint">Slower, but it works. Pick a Pocket model for the best speed, or use Ollama for big models.</div>
          </div>
        </div>
      )}
      <p className="muted" style={{ marginTop: 0 }}>
        The model downloads once into your browser cache and runs on your {gpu ? 'GPU' : 'CPU'}. Nothing is sent anywhere.
      </p>
      <div className="model-list">
        {WEBLLM_MODELS.map((m) => (
          <button key={m.id} className={'model-row' + (settings.webllmModel === m.id ? ' on' : '')} onClick={() => setSettings({ webllmModel: m.id })}>
            <div className="model-meta">
              <div className="row" style={{ gap: 6 }}>
                <span className="mono">{m.label}</span>
                {m.pocket && <span className="pocket-badge">⚡ Pocket</span>}
              </div>
              <div className="faint">
                {m.size} · {m.note}
              </div>
            </div>
            <span className="spacer" />
            {settings.webllmModel === m.id && <Check size={16} className="ok" />}
          </button>
        ))}
      </div>
      <div style={{ marginTop: 14 }}>
        {webllm && !webllm.error && webllm.progress < 1 ? (
          <div className="webllm-progress">
            <div className="progress">
              <div style={{ width: `${(webllm.progress || 0) * 100}%` }} />
            </div>
            <span className="faint">{webllm.text}</span>
          </div>
        ) : webllm?.ready ? (
          <div className="status-card ok">
            <Check size={16} /> <b>Model loaded and ready</b>
          </div>
        ) : (
          <button className="btn btn-primary" onClick={() => loadWebLLM(settings.webllmModel).catch(() => {})}>
            Download & load model
          </button>
        )}
        {webllm?.error && <div className="faint" style={{ color: 'var(--danger)', marginTop: 8 }}>{webllm.text}</div>}
      </div>
    </div>
  );
}

function OpenAISetup() {
  const settings = useStore((s) => s.settings);
  const engine = useStore((s) => s.engine);
  const { setSettings } = useStore.getState();
  return (
    <div>
      <ol className="steps">
        <li>
          Open{' '}
          <a className="link" href="https://lmstudio.ai" target="_blank" rel="noreferrer">
            LM Studio
          </a>{' '}
          (or llama.cpp / Jan / LocalAI) and download a coding model.
        </li>
        <li>Start the local server (LM Studio → Developer → Start server, enable CORS).</li>
      </ol>
      <div className="field">
        <label>Server URL</label>
        <div className="row">
          <input className="input mono" value={settings.openaiUrl} onChange={(e) => setSettings({ openaiUrl: e.target.value })} />
          <button className="btn btn-outline" onClick={checkEngine}>
            Test
          </button>
        </div>
      </div>
      {engine.status === 'ok' && (
        <div className="status-card ok">
          <Check size={16} /> <b>Connected · {engine.models.length} model(s)</b>
        </div>
      )}
      {engine.status === 'down' && (
        <div className="status-card bad">
          <Server size={16} /> <span>Can't reach the server: {engine.error}</span>
        </div>
      )}
    </div>
  );
}

function WorkspaceStep() {
  const ws = useStore((s) => s.ws);
  const server = useStore((s) => s.server);
  const { setUI } = useStore.getState();
  if (server) {
    return (
      <div>
        <div className="status-card ok">
          <HardDrive size={16} />
          <div>
            <b>Full power mode</b>
            <div className="faint">Buddo can read & edit files and run commands in your folder.</div>
          </div>
        </div>
        <div className="ws-current">
          <FolderOpen size={18} />
          <div className="truncate">
            <b>{ws?.name}</b>
            <div className="faint mono truncate">{ws?.root}</div>
          </div>
          <span className="spacer" />
          <button className="btn btn-outline btn-sm" onClick={() => setUI({ folder: true })}>
            Change
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="choice-grid two">
      <button className={'choice' + (ws?.type === 'folder' ? ' on' : '')} disabled={!supportsFolderAccess()} onClick={() => pickBrowserFolder().catch(() => {})}>
        <FolderOpen size={22} />
        <b>Open a folder</b>
        <span className="faint">{supportsFolderAccess() ? 'Edit a real project on your disk (Chrome / Edge)' : 'Not supported in this browser'}</span>
      </button>
      <button className={'choice' + (ws?.type === 'sandbox' ? ' on' : '')} onClick={useSandbox}>
        <Box size={22} />
        <b>Browser sandbox</b>
        <span className="faint">Build from scratch in a virtual project with live preview</span>
      </button>
      <div className="faint" style={{ gridColumn: '1 / -1', fontSize: 12.5 }}>
        Want Buddo to run commands, tests and git? Run <code>npm start</code> from the Buddo repo or use the desktop app.
      </div>
    </div>
  );
}

const ENGINES_DESKTOP = [
  { id: 'ollama', icon: Cpu, title: 'Ollama', tag: 'Recommended', desc: 'Runs open models on your computer. Best quality, fully offline.' },
  { id: 'webllm', icon: Globe, title: 'In your browser', tag: 'Zero install', desc: 'WebGPU-powered. Nothing to install, smaller models.' },
  { id: 'openai', icon: Server, title: 'LM Studio & others', tag: 'Advanced', desc: 'Any local OpenAI-compatible server: LM Studio, llama.cpp, Jan…' },
];
// On phones, the tiny in-browser "Pocket" models are the only practical option.
const ENGINES = isMobile()
  ? [{ id: 'webllm', icon: Globe, title: 'Pocket (on this phone)', tag: 'Best for phones', desc: 'Tiny, fast models that run right on your phone. ~200–700 MB, one-time download.' }, ...ENGINES_DESKTOP.filter((e) => e.id !== 'webllm')]
  : ENGINES_DESKTOP;

export default function SetupModal() {
  const open = useStore((s) => s.ui.setup);
  const settings = useStore((s) => s.settings);
  const engine = useStore((s) => s.engine);
  const webllm = useStore((s) => s.webllm);
  const { setUI, setSettings } = useStore.getState();
  const [step, setStep] = useState(settings.onboarded ? 1 : 0);
  const [dir, setDir] = useState(1);
  useEffect(() => {
    if (open) setStep(settings.onboarded ? 2 : 0);
    // First run on a phone without a local server → default to the fastest Pocket model.
    if (open && !settings.onboarded && isMobile() && !useStore.getState().server) {
      setSettings({ engine: 'webllm', webllmModel: WEBLLM_MODELS.find((m) => m.pocket).id });
    }
    // No usable GPU (many Chromebooks) → in-browser models run on the CPU, where Pocket Coder is the fastest coder.
    else if (open && !settings.onboarded && usesCpu()) {
      setSettings({ webllmModel: WEBLLM_MODELS.find((m) => m.pocket).id });
    }
  }, [open]);

  const go = (n) => {
    setDir(n > step ? 1 : -1);
    setStep(n);
  };
  const finish = () => {
    setSettings({ onboarded: true });
    setUI({ setup: false });
  };
  const engineReady = settings.engine === 'webllm' ? !!webllm?.ready || !!webllm?.progress : engine.status === 'ok';

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <motion.div
            className="modal setup"
            initial={{ opacity: 0, scale: 0.94, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 360, damping: 30 }}
          >
            <div className="setup-progress">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className={'sp-dot' + (i <= step ? ' on' : '')}>
                  {i === step && <motion.div layoutId="sp" className="sp-active" />}
                </div>
              ))}
            </div>
            <div className="setup-body">
              <AnimatePresence mode="wait" custom={dir}>
                <motion.div key={step} custom={dir} variants={slide} initial="initial" animate="animate" exit="exit" transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}>
                  {step === 0 && (
                    <div className="welcome">
                      <div className="welcome-logo">
                        <div className="empty-logo-glow" />
                        <Logo size={88} />
                      </div>
                      <h1>
                        Meet <span className="grad-text">Buddo</span>
                      </h1>
                      <p className="muted">Your AI coding agent that lives on your machine. It reads your code, makes changes, runs commands and fixes bugs — for free.</p>
                      <div className="welcome-points">
                        {[
                          [Heart, 'Free forever', 'No API keys, no subscriptions, no limits'],
                          [Shield, 'Private', 'Your code never leaves your computer'],
                          [Zap, 'Agentic', 'Plans, edits files, runs tests, iterates'],
                        ].map(([I, t, d], i) => (
                          <motion.div key={t} className="wp" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 + i * 0.08 }}>
                            <I size={17} />
                            <div>
                              <b>{t}</b>
                              <span className="faint">{d}</span>
                            </div>
                          </motion.div>
                        ))}
                      </div>
                    </div>
                  )}
                  {step === 1 && (
                    <div>
                      <h2 className="setup-title">Choose your AI engine</h2>
                      <p className="muted setup-sub">All options are free and run locally. You can switch any time.</p>
                      <div className="choice-grid">
                        {ENGINES.map((e) => (
                          <motion.button key={e.id} className={'choice' + (settings.engine === e.id ? ' on' : '')} onClick={() => setSettings({ engine: e.id })} whileHover={{ y: -2 }} whileTap={{ scale: 0.98 }}>
                            <div className="row">
                              <e.icon size={20} />
                              <span className="spacer" />
                              <span className="chip">{e.tag}</span>
                            </div>
                            <b>{e.title}</b>
                            <span className="faint">{e.desc}</span>
                            {settings.engine === e.id && (
                              <motion.div className="choice-check" initial={{ scale: 0 }} animate={{ scale: 1 }}>
                                <Check size={12} />
                              </motion.div>
                            )}
                          </motion.button>
                        ))}
                      </div>
                    </div>
                  )}
                  {step === 2 && (
                    <div>
                      <h2 className="setup-title">{settings.engine === 'webllm' ? 'Load an in-browser model' : settings.engine === 'openai' ? 'Connect your local server' : 'Set up Ollama'}</h2>
                      <div style={{ marginTop: 14 }}>
                        {settings.engine === 'ollama' && <OllamaSetup />}
                        {settings.engine === 'webllm' && <WebLLMSetup />}
                        {settings.engine === 'openai' && <OpenAISetup />}
                      </div>
                    </div>
                  )}
                  {step === 3 && (
                    <div>
                      <h2 className="setup-title">Where should Buddo work?</h2>
                      <p className="muted setup-sub">Pick the project Buddo can read and edit.</p>
                      <WorkspaceStep />
                    </div>
                  )}
                </motion.div>
              </AnimatePresence>
            </div>
            <div className="modal-foot">
              {step > 0 && (
                <button className="btn btn-ghost" onClick={() => go(step - 1)}>
                  <ArrowLeft size={15} /> Back
                </button>
              )}
              <span className="spacer" />
              {settings.onboarded && step < 3 && (
                <button className="btn btn-ghost" onClick={finish}>
                  Close
                </button>
              )}
              {step < 3 ? (
                <button className="btn btn-primary" onClick={() => go(step + 1)}>
                  {step === 0 ? 'Get started' : step === 2 && !engineReady ? 'Skip for now' : 'Continue'} <ArrowRight size={15} />
                </button>
              ) : (
                <button className="btn btn-primary" onClick={finish}>
                  Start building <ArrowRight size={15} />
                </button>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
