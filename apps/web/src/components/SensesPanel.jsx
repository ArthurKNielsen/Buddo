import { useEffect, useState } from 'react';
import { Mic, AudioLines, Eye, Waves, Check, Download, Cpu } from 'lucide-react';
import { useStore } from '../lib/store.js';

const ICONS = { whisper: Mic, sounds: AudioLines, vad: Waves, vision: Eye };
const H = { 'x-buddo': '1' };

export default function SensesPanel() {
  const server = useStore((s) => s.server);
  const vision = useStore((s) => s.vision);
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = () =>
    fetch('/api/media/status', { headers: H })
      .then((r) => r.json())
      .then(setSt)
      .catch(() => setSt({ available: false, models: [] }));
  useEffect(() => {
    if (server) load();
  }, [server]);

  const setup = async () => {
    setBusy({ label: 'Starting…', pct: 0 });
    const r = await fetch('/api/media/setup', { method: 'POST', headers: H });
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const ev = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (ev.type === 'progress') setBusy({ label: `${ev.label}${ev.stage === 'extract' ? ' — unpacking' : ''}`, pct: ev.total ? ev.done / ev.total : null });
        if (ev.type === 'error') useStore.getState().toast(ev.error, 'error');
      }
    }
    setBusy(null);
    load();
  };

  if (!server) {
    return (
      <p className="muted" style={{ marginTop: 0 }}>
        Watching videos and listening to audio run on your computer — open Buddo as the <b>desktop app</b> or with <code>npm start</code>. In the browser you can still attach images for vision models.
      </p>
    );
  }
  const ready = st?.models?.every((m) => m.installed);
  const missingMB = (st?.models || []).filter((m) => !m.installed).reduce((a, m) => a + m.sizeMB, 0);
  return (
    <>
      <p className="muted" style={{ marginTop: 0 }}>
        Buddo can <b>watch videos</b>, <b>hear audio</b> and <b>look at images</b> — locally, in about a second. These small free models do the perceiving:
      </p>
      <div className="senses-list">
        {(st?.models || []).map((m) => {
          const I = ICONS[m.id] || Cpu;
          return (
            <div key={m.id} className="sense">
              <I size={16} />
              <span style={{ flex: 1 }}>{m.label}</span>
              <span className="faint">{m.sizeMB} MB</span>
              {m.installed ? <Check size={15} className="ok" /> : <span className="chip">not downloaded</span>}
            </div>
          );
        })}
        <div className="sense">
          <Eye size={16} />
          <span style={{ flex: 1 }}>Seeing the actual pictures (your chat model)</span>
          {vision ? <span className="vision-badge">vision ✓</span> : <span className="faint">use a vision model, e.g. qwen2.5vl:7b</span>}
        </div>
      </div>
      {st && !st.available && <p style={{ color: 'var(--danger)' }}>{st.error}</p>}
      {busy ? (
        <div className="webllm-progress">
          <div className={'progress' + (busy.pct === null ? ' indeterminate' : '')}>
            <div style={{ width: `${(busy.pct || 0) * 100}%` }} />
          </div>
          <span className="faint">{busy.label}</span>
        </div>
      ) : ready ? (
        <div className="status-card ok">
          <Check size={16} /> <b>All senses ready</b>
        </div>
      ) : (
        st?.available && (
          <button className="btn btn-primary" onClick={setup}>
            <Download size={14} /> Download senses (~{missingMB} MB, one time)
          </button>
        )
      )}
    </>
  );
}
