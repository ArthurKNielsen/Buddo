import { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Download, RefreshCw, X, ExternalLink } from 'lucide-react';
import { useStore } from '../lib/store.js';

// Updates for the desktop app (window.buddoDesktop, from preload.cjs). The web app always runs the newest version.
const desktop = () => (typeof window !== 'undefined' && window.buddoDesktop?.checkUpdate ? window.buddoDesktop : null);
const setUpdate = (patch) => useStore.setState((s) => ({ update: { ...(s.update || {}), ...patch } }));
const mb = (n) => `${(n / 1e6).toFixed(0)} MB`;

export async function checkForUpdate({ quiet = false } = {}) {
  const d = desktop();
  if (!d) return;
  setUpdate({ checking: true, error: null });
  const r = await d.checkUpdate().catch((e) => ({ error: e.message }));
  setUpdate({ checking: false, info: r.error ? null : r, error: r.error || null, current: r.current, checkedAt: Date.now() });
  if (!quiet && !r.error && !r.available) useStore.getState().toast(`Buddo is up to date (v${r.current}).`, 'success');
  if (!quiet && r.error) useStore.getState().toast(`Couldn't check for updates: ${r.error}`, 'error');
}

export async function installUpdate() {
  const d = desktop();
  if (!d) return;
  setUpdate({ stage: 'download', got: 0, total: useStore.getState().update?.info?.size || 0, error: null });
  const r = await d.installUpdate();
  if (r?.opened) setUpdate({ stage: null });
  else if (!r?.ok) setUpdate({ stage: 'error', error: r?.error || 'The update failed.' });
}

/** Checks once on start, follows download progress, and shows a small "update available" card. */
export function UpdateBanner() {
  const u = useStore((s) => s.update);
  useEffect(() => {
    const d = desktop();
    if (!d) return;
    d.version?.().then((v) => setUpdate({ current: v })).catch(() => {});
    const off = d.onUpdate?.((m) => {
      if (m.stage === 'available') setUpdate({ info: m });
      else setUpdate({ stage: m.stage, got: m.got, total: m.total, error: m.error || null });
    });
    const t = setTimeout(() => checkForUpdate({ quiet: true }), 3000);
    return () => {
      clearTimeout(t);
      off?.();
    };
  }, []);
  const show = !!(u?.info?.available && !u.dismissed) || u?.stage === 'download' || u?.stage === 'install' || u?.stage === 'error';
  return (
    <AnimatePresence>
      {show && (
        <motion.div className="update-card" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }} transition={{ duration: 0.2 }}>
          <UpdateBody u={u} compact />
          {!u.stage && (
            <button className="icon-btn sm update-x" title="Later" onClick={() => setUpdate({ dismissed: true })}>
              <X size={13} />
            </button>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function UpdateBody({ u, compact }) {
  const info = u?.info;
  if (u?.stage === 'download') {
    const pct = u.total ? Math.min(100, (u.got / u.total) * 100) : 0;
    return (
      <div className="update-body">
        <b>Downloading Buddo {info?.version ? `v${info.version}` : ''}…</b>
        <div className={'progress' + (u.total ? '' : ' indeterminate')}>
          <div style={{ width: `${pct}%` }} />
        </div>
        <span className="faint">{u.total ? `${mb(u.got || 0)} of ${mb(u.total)}` : 'Starting…'}</span>
      </div>
    );
  }
  if (u?.stage === 'install') {
    return (
      <div className="update-body">
        <b>Installing…</b>
        <span className="faint">Buddo closes and opens again on the new version.</span>
      </div>
    );
  }
  if (u?.stage === 'error') {
    return (
      <div className="update-body">
        <b>The update didn't work</b>
        <span className="faint">{u.error}</span>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn btn-sm btn-primary" onClick={installUpdate}>Try again</button>
          <button className="btn btn-sm btn-outline" onClick={() => setUpdate({ stage: null, error: null, dismissed: true })}>Close</button>
        </div>
      </div>
    );
  }
  if (info?.available) {
    return (
      <div className="update-body">
        <b>
          <Download size={14} /> Buddo v{info.version} is out
        </b>
        {!compact && info.notes && <pre className="update-notes">{info.notes}</pre>}
        <span className="faint">You have v{info.current}.{info.canInstall ? '' : ' Download it from the Releases page.'}</span>
        <button className="btn btn-sm btn-primary" onClick={installUpdate}>
          {info.canInstall ? (
            <>
              <Download size={13} /> Update now{info.size ? ` (${mb(info.size)})` : ''}
            </>
          ) : (
            <>
              <ExternalLink size={13} /> Open the Releases page
            </>
          )}
        </button>
      </div>
    );
  }
  return null;
}

/** Settings → About: the version, and a button to look for a new one. */
export function UpdatePanel() {
  const u = useStore((s) => s.update);
  if (!desktop()) return <p className="faint">The web app is always the newest version. The desktop app updates itself from here.</p>;
  return (
    <div className="update-panel">
      {u?.info?.available || u?.stage ? (
        <UpdateBody u={u} />
      ) : (
        <span className="faint">{u?.checkedAt ? `Up to date${u.current ? ` (v${u.current})` : ''}.` : u?.error ? `Couldn't check: ${u.error}` : 'Updates come from GitHub releases.'}</span>
      )}
      {!u?.stage && (
        <button className="btn btn-sm btn-outline" disabled={u?.checking} onClick={() => checkForUpdate()}>
          <RefreshCw size={13} className={u?.checking ? 'spin' : ''} /> {u?.checking ? 'Checking…' : 'Check for updates'}
        </button>
      )}
    </div>
  );
}
