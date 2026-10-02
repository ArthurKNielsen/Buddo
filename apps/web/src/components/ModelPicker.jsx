import { useState } from 'react';
import { motion } from 'framer-motion';
import { Cpu, Check, Download, RefreshCw, Sparkles } from 'lucide-react';
import { RECOMMENDED_MODELS, guessVision } from '@buddo/core';
import { useStore } from '../lib/store.js';
import { checkEngine, pullModel, WEBLLM_MODELS, loadWebLLM, isPocketModel } from '../lib/engine.js';
import Modal from './Modal.jsx';

const fmtSize = (b) => (b ? (b / 1e9).toFixed(1) + ' GB' : '');

export function PullButton({ id, compact }) {
  const [state, setState] = useState(null);
  const installed = useStore((s) => s.engine.models.some((m) => m.id === id || m.id === id + ':latest'));
  if (installed) return <span className="chip accent"><Check size={12} /> Installed</span>;
  if (state?.error) return <span className="chip" style={{ color: 'var(--danger)' }} title={state.error}>Failed</span>;
  if (state) {
    const pct = state.total ? Math.round((state.completed / state.total) * 100) : null;
    return (
      <div className="pull-progress">
        <div className={'progress' + (pct === null ? ' indeterminate' : '')}>
          <div style={{ width: `${pct || 0}%` }} />
        </div>
        <span className="faint mono">{pct === null ? state.status?.slice(0, 18) : `${pct}%`}</span>
      </div>
    );
  }
  return (
    <button
      className={'btn btn-sm ' + (compact ? 'btn-outline' : 'btn-primary')}
      onClick={async (e) => {
        e.stopPropagation();
        setState({ status: 'starting' });
        try {
          await pullModel(id, (ev) => setState({ status: ev.status, completed: ev.completed, total: ev.total }));
          useStore.getState().setSettings({ model: id });
          useStore.getState().toast(`${id} is ready`, 'success');
          setState(null);
        } catch (err) {
          setState({ error: err.message });
        }
      }}
    >
      <Download size={13} /> Download
    </button>
  );
}

export default function ModelPicker() {
  const open = useStore((s) => s.ui.models);
  const settings = useStore((s) => s.settings);
  const engine = useStore((s) => s.engine);
  const webllm = useStore((s) => s.webllm);
  const { setUI, setSettings } = useStore.getState();
  const close = () => setUI({ models: false });
  const isWeb = settings.engine === 'webllm';
  const models = isWeb ? WEBLLM_MODELS : engine.models;
  const current = isWeb ? settings.webllmModel : settings.model;
  const notInstalled = settings.engine === 'ollama' ? RECOMMENDED_MODELS.filter((r) => !engine.models.some((m) => m.id === r.id)) : [];

  return (
    <Modal
      open={open}
      onClose={close}
      title="Choose a model"
      icon={<Cpu size={17} />}
      footer={
        <>
          <button className="btn btn-ghost" onClick={() => setUI({ models: false, settings: true, settingsTab: 'engine' })}>
            Engine settings
          </button>
          <span className="spacer" />
          <button className="btn btn-outline" onClick={checkEngine}>
            <RefreshCw size={14} /> Refresh
          </button>
        </>
      }
    >
      <div className="modal-body">
        <div className="engine-line">
          <span className={`dot ${isWeb || engine.status === 'ok' ? 'ok' : engine.status === 'checking' ? 'wait' : 'down'}`} />
          <span>
            {isWeb ? 'In-browser (WebGPU)' : settings.engine === 'openai' ? 'LM Studio / OpenAI-compatible' : 'Ollama'}
            {engine.version && ` v${engine.version}`}
          </span>
          {!isWeb && engine.status === 'down' && <span className="faint truncate">— not reachable</span>}
        </div>
        {!models.length && !isWeb && (
          <div className="faint" style={{ padding: '10px 0' }}>
            No models found. {settings.engine === 'ollama' ? 'Download one below.' : 'Load a model in your local server.'}
          </div>
        )}
        <div className="model-list">
          {models.map((m, i) => (
            <motion.button
              key={m.id}
              className={'model-row' + (m.id === current ? ' on' : '')}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.03 }}
              onClick={() => {
                if (isWeb) {
                  setSettings({ webllmModel: m.id });
                  loadWebLLM(m.id).catch(() => {});
                } else setSettings({ model: m.id });
                close();
              }}
            >
              <div className="model-icon">
                <Cpu size={15} />
              </div>
              <div className="model-meta">
                <div className="row" style={{ gap: 6 }}>
                  <span className="mono">{m.label || m.id}</span>
                  {!isWeb && guessVision(m.id) && <span className="vision-badge">👁 vision</span>}
                  {(m.pocket || isPocketModel(m.id)) && <span className="pocket-badge">⚡ Pocket</span>}
                </div>
                <div className="faint">{[m.params, m.quant, typeof m.size === 'number' ? fmtSize(m.size) : m.size, m.note].filter(Boolean).join(' · ')}</div>
              </div>
              <span className="spacer" />
              {m.id === current && <Check size={16} className="ok" />}
            </motion.button>
          ))}
        </div>
        {isWeb && webllm && !webllm.ready && (
          <div className="webllm-progress">
            <div className="progress">
              <div style={{ width: `${(webllm.progress || 0) * 100}%` }} />
            </div>
            <span className="faint">{webllm.text}</span>
          </div>
        )}
        {notInstalled.length > 0 && engine.status !== 'down' && (
          <>
            <div className="section-label">
              <Sparkles size={13} /> Recommended free models
            </div>
            <div className="model-list">
              {notInstalled.map((m) => (
                <div key={m.id} className="model-row static">
                  <div className="model-icon">
                    <Download size={15} />
                  </div>
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
                  <PullButton id={m.id} compact />
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
